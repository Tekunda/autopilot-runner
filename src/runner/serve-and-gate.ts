// The dedicated "heavy" gate stage (docs/ci-gate-refit-plan.md §5, P5). The fast gate stage
// (run-gate-stage.ts) runs deterministic checks against the PR checkout only -- it has no
// customer toolchain, no running server, no browser. The heavy gates (the SEO site crawl, e2e,
// Visual-QA) need a LIVE served site. This module brings that site up runner-side, threads its
// base URL into the gates via ctx.config, runs them, and tears the server down.
//
// Mirrors the old `qa-site.sh` serve/e2e/seo phases, Autopilot-native:
//   install -> build -> serve -> wait-for-ready -> { heavy gates } -> teardown
//
// §11 CONSTRAINT (load-bearing): this stage crawls/screenshots a SETTLED LOCAL SERVER -- a stable
// build we just produced and started -- NOT a mid-rollout production deploy. That is the whole
// point: judging a settling deploy flags exactly the transient asset-skew / half-translated
// errors the serpent incident hit. A local `yarn build` + `yarn start` is atomic and settled by
// the time wait-for-ready returns, so the heavy gates see a stable site.
//
// The exact install/build/start commands are NOT hardcoded -- they come from tenant config (the
// same command strings a command gate uses, e.g. `yarn build:<site>` / `yarn start:<site>`), so
// nothing here is site-specific.

import { spawn as nodeSpawn } from 'node:child_process';

import type { CheckResult, ExecutionGrant, ServeConfig, SiteConfig, StatusTelemetry } from '../contracts/types.ts';
import type { ExecutorCredential } from '../gates/visual/judge.ts';
import { verifyGrant } from '../control-plane/grant-verify.ts';
import { runCommand as defaultRunCommand } from '../gates/exec.ts';
import { boundedCapture } from '../gates/output-capture.ts';
import { registerHeavyGatesForSpecs } from './gate-registry.ts';
import { URL_BOUND_HEAVY_GATE_IDS } from './heavy-gate-ids.ts';
import { digestFor, grantId, rejectedTelemetry } from './prepare-stage.ts';
import { runGateStage, type RunGateStageDeps } from './run-gate-stage.ts';

// The serve recipe (install/build/start/baseUrl) and the multi-site recipe are signed grant
// fields -- see ServeConfig / SiteConfig and ExecutionGrant.serve / .sites in
// ../contracts/types.ts. Re-exported here for the modules and tests that already reach for them
// through this heavy-stage entry point.
export type { ServeConfig, SiteConfig };

// A brought-up server. stop() must always be called (a finally) so the runner never leaks a
// server process into later steps.
export interface ServedSite {
  baseUrl: string;
  stop(): Promise<void>;
}

// Minimal process handle so serveSite is testable without spawning a real server.
export interface ServeProcess {
  kill(signal?: NodeJS.Signals): void;
  onExit(listener: (code: number | null) => void): void;
}

export interface ServeSiteDeps {
  // Where the customer PR is checked out -- install/build/start all run here.
  cwd: string;
  runCommand?: typeof defaultRunCommand;
  spawn?: (command: string, args: string[], cwd: string) => ServeProcess;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
  readyPath: '/',
  readyTimeoutMs: 120_000,
  readyIntervalMs: 1_000,
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultSpawn(command: string, args: string[], cwd: string): ServeProcess {
  // `detached` so the server (and anything `yarn start` forks) lives in its own process group,
  // which stop() can then signal as a whole -- a bare child.kill would orphan the real server.
  const child = nodeSpawn(command, args, { cwd, detached: true, stdio: 'ignore' });
  return {
    kill(signal?: NodeJS.Signals): void {
      try {
        if (child.pid) process.kill(-child.pid, signal ?? 'SIGTERM');
        else child.kill(signal ?? 'SIGTERM');
      } catch {
        child.kill(signal ?? 'SIGTERM');
      }
    },
    onExit(listener: (code: number | null) => void): void {
      child.on('exit', listener);
    },
  };
}

// Which step of serveSite produced a thrown error. The install step touches the shared npm/yarn
// registry and local package cache -- the ONLY step where ENOENT/EINTEGRITY/corrupt-tarball/5xx
// genuinely mean transient infra (a bad mirror, a truncated download). The build step compiles
// the customer's OWN code against their OWN checked-out tree with no network involved -- a build
// ENOENT means a referenced file (an asset, a config) is really missing, which is a reproducible
// break no matter how infra-shaped its message looks (PR deletes `logo.svg`, import survives ->
// the bundler throws "ENOENT ... logo.svg", not a registry hiccup). ready-poll is a different kind
// of transient: the server never answered before the deadline, which is a network/startup timeout.
export type BuildPhase = 'install' | 'build' | 'ready-poll';

// Tags a thrown Error with which phase produced it, so failure classification keys on STRUCTURE
// (which step failed) rather than sniffing prose across all three steps alike -- mirrors how
// drive-faults.ts's isNetworkFault keys on err.code, not text. Every throw site inside serveSite
// (runOrThrow below, and the ready-poll loop) tags its Error this way.
function phaseError(phase: BuildPhase, message: string): Error {
  const err = new Error(message) as Error & { buildPhase: BuildPhase };
  err.buildPhase = phase;
  return err;
}

// Recover the phase a caught serve/build error was tagged with. Falls back to the label prefix
// runOrThrow/serveSite already put in the message (`install \`...`, `build \`...`, `server \`...`)
// for an error that reaches here untagged (e.g. a test double, or a future throw site that forgets
// the tag) -- fail CLOSED to "unknown" rather than guess, since an unknown phase must never be
// classified transient (see isTransientBuildFault).
function phaseOf(err: unknown): BuildPhase | undefined {
  if (typeof err === 'object' && err !== null) {
    const tagged = (err as { buildPhase?: unknown }).buildPhase;
    if (tagged === 'install' || tagged === 'build' || tagged === 'ready-poll') return tagged;
  }
  const message = err instanceof Error ? err.message : String(err);
  if (/^install `/.test(message)) return 'install';
  if (/^build `/.test(message)) return 'build';
  if (/^server `/.test(message)) return 'ready-poll';
  return undefined;
}

// Infra-flake signatures seen in captured install-step failure text -- registry hiccups, truncated
// downloads, and dropped connections that a bare re-run of the SAME command often clears. Mirrors
// the SHAPE of drive-faults.ts's isNetworkFault (a tight, literal signature list, not a broad
// substring match), but for shell/build output, not HTTP-fetch error objects -- the two never
// apply to the same call site, so this stays local to serve-and-gate.ts. Scoped to the install
// PHASE only (see BuildPhase) -- the same substrings in a BUILD failure mean something else
// entirely (a missing asset/import), never infra.
const TRANSIENT_INSTALL_PATTERNS: readonly RegExp[] = [
  /ENOENT/, // a file went missing mid-install (concurrent cache write, extraction race)
  /EINTEGRITY/, // downloaded tarball didn't match its checksum (npm cache corruption / bad mirror)
  /corrupt/i, // "tarball data for X seems to be corrupted" and similar cache-corruption text
  /tarball/i, // package tarball fetch/extract failures generally
  /ECONNRESET/, // registry connection dropped mid-request
  /ETIMEDOUT/, // registry connection timed out
  /ENOTFOUND/, // DNS lookup for the registry host failed
  /\bE5\d\d\b/, // npm's own "E500"/"E502"/"E503" codes for an unexpected registry 5xx response
  /\b(request|fetch|registry)\b[^\n]{0,40}\b5\d\d\b/i, // yarn/npm registry 5xx prose ("request ... failed ... 503")
];

// The narrower transient set for the ready-poll phase: a dropped/timed-out connection while
// polling, or the readiness deadline itself firing -- by definition the server never answered in
// time, a network/startup timeout rather than a judged code defect. `exited before becoming ready`
// (the process itself died) is deliberately NOT here -- that is the server's own code crashing on
// start, which is reproducible and must block, not retry.
const TRANSIENT_READY_POLL_PATTERNS: readonly RegExp[] = [
  /ECONNRESET/,
  /ETIMEDOUT/,
  /ENOTFOUND/,
  /not ready at .* within \d+ms/, // the readiness deadline fired -- the server never answered in time
];

// Whether a captured install/build/serve failure LOOKS like transient infra rather than a
// reproducible break in the customer's own code, scoped by WHICH PHASE produced it (see
// BuildPhase). Used to route a site's serve failure into either an `unjudged/infra` (worth a
// bounded gate retry, see fix-loop.ts's isInfraUnjudgedOnly) or a blocking `fail` (a real build break,
// correctly attributed -- never masqueraded as an SEO finding). A build-phase failure is NEVER
// transient (a build ENOENT is a missing asset, not registry infra); neither is a failure whose
// phase could not be determined -- fail closed to blocking rather than risk masking a real break.
export function isTransientBuildFault(phase: BuildPhase | undefined, message: string): boolean {
  if (phase === 'install') return TRANSIENT_INSTALL_PATTERNS.some((pattern) => pattern.test(message));
  if (phase === 'ready-poll') return TRANSIENT_READY_POLL_PATTERNS.some((pattern) => pattern.test(message));
  return false;
}

// Tighter than the gate default: this capture is inlined into an Error MESSAGE that a caller then
// wraps with its own phase/command prefix, so it shares its budget rather than owning one.
const SERVE_CAPTURE_LIMIT = 2000;

async function runOrThrow(
  runCommand: typeof defaultRunCommand,
  phase: Extract<BuildPhase, 'install' | 'build'>,
  line: string,
  cwd: string,
): Promise<void> {
  const { exitCode, stderr, stdout } = await runCommand('sh', ['-c', line], cwd);
  if (exitCode !== 0) {
    // Head-and-tail, not a tail (output-capture.ts): a failed build prints its FIRST compile error
    // first and a cascade of consequences after it, so the head is where the cause is. This text
    // is both the check finding a human reads and the brief the autofixer works from, and it is
    // also what isTransientBuildFault pattern-matches -- a wider sample of the same failure, still
    // scoped to the same phase, so an install flake stays as detectable as it was.
    const detail = boundedCapture(stderr.trim() || stdout.trim(), SERVE_CAPTURE_LIMIT);
    throw phaseError(phase, `${phase} \`${line}\` exited ${exitCode}: ${detail}`);
  }
}

// Install (optional) -> build (optional) -> start the server -> poll until it answers. Returns a
// handle whose stop() kills the server. Throws if a build step fails or the server never becomes
// ready inside the timeout (after killing the started process, so nothing leaks).
export async function serveSite(config: ServeConfig, deps: ServeSiteDeps): Promise<ServedSite> {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const spawn = deps.spawn ?? defaultSpawn;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;

  if (config.installCommand) await runOrThrow(runCommand, 'install', config.installCommand, deps.cwd);
  if (config.buildCommand) await runOrThrow(runCommand, 'build', config.buildCommand, deps.cwd);

  const child = spawn('sh', ['-c', config.startCommand], deps.cwd);
  const stop = async (): Promise<void> => {
    child.kill('SIGTERM');
  };

  const readyUrl = new URL(config.readyPath ?? DEFAULTS.readyPath, config.baseUrl.replace(/\/$/, '') + '/').toString();
  const timeoutMs = config.readyTimeoutMs ?? DEFAULTS.readyTimeoutMs;
  const intervalMs = config.readyIntervalMs ?? DEFAULTS.readyIntervalMs;
  const deadline = Date.now() + timeoutMs;

  let serverExited: number | null | undefined;
  child.onExit((code) => {
    serverExited = code;
  });

  for (;;) {
    if (serverExited !== undefined) {
      throw phaseError('ready-poll', `server \`${config.startCommand}\` exited before becoming ready (code ${serverExited})`);
    }
    try {
      const res = await fetchImpl(readyUrl);
      if (res.ok) {
        process.stdout.write(`[heavy-stage] server ready at ${config.baseUrl}\n`);
        return { baseUrl: config.baseUrl.replace(/\/$/, ''), stop };
      }
    } catch {
      // not up yet -- keep polling until the deadline
    }
    if (Date.now() >= deadline) {
      await stop();
      throw phaseError('ready-poll', `server \`${config.startCommand}\` not ready at ${readyUrl} within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

// Gate ids whose runtime baseUrl is the served instance this stage just brought up. The overlay
// wins over any baseUrl in the signed/target config (see run-gate-stage.ts configOverlay).
// Re-exported from the shared source of truth (heavy-gate-ids.ts) that the CIRunner adapter's
// fast-vs-heavy dispatch also derives from, so the two can never drift.
export { URL_BOUND_HEAVY_GATE_IDS };

export interface RunHeavyGateStageDeps extends RunGateStageDeps {
  // The serve recipe. Defaults to the grant's SIGNED `serve` field (never the unsigned target
  // config -- the startCommand is a shell command, so it must come from the verified grant).
  // Absent on both -> the stage runs the gates WITHOUT bringing a server up (they skip cleanly
  // when they need a URL).
  serve?: ServeConfig;
  // The MULTI-SITE recipe. Defaults to the grant's SIGNED `sites` field. When present (and
  // non-empty) it TAKES PRECEDENCE over `serve`: the URL-bound gates run once per site, each
  // against that site's own server, while the deterministic gates run once. Absent -> the
  // single-`serve` path.
  sites?: SiteConfig[];
  // Injected for tests; defaults to serveSite. Lets a test assert threading/teardown without a
  // real build+server.
  serveSiteImpl?: (config: ServeConfig, deps: ServeSiteDeps) => Promise<ServedSite>;
  // Injected serve-site sub-deps (spawn/fetch/runCommand/sleep) for tests.
  serveDeps?: Omit<ServeSiteDeps, 'cwd'>;
  // The tenant's model credential for the Visual-QA vision judge, threaded in like baseUrl (it
  // only exists at run time, off the coding-executor-config, so it can't ride the signed grant).
  // Absent -> the judge falls back to ANTHROPIC_API_KEY, else fails closed.
  executorCredential?: ExecutorCredential;
}

// The heavy stage: bring the site up, thread its base URL into the URL-bound heavy gates, run the
// grant's gates (delegating verification, PR-match and execution to runGateStage), then always
// tear the server down. The Visual-QA gate is registered here (it must NOT ride on the fast gate
// path), so a `{kind:'generic', id:'visual-qa'}` spec in the grant resolves to an executable gate.
export async function runHeavyGateStage(grant: ExecutionGrant, deps: RunHeavyGateStageDeps): Promise<StatusTelemetry> {
  const workspaceRoot = deps.workspaceRoot ?? process.cwd();
  // Verify the grant HERE, before serving -- the serve recipe's startCommand runs a shell
  // command, so a forged/tampered grant must be rejected before any command executes. runGateStage
  // verifies again (harmlessly) when we delegate to it below.
  const verification = verifyGrant(grant, deps.verifyKey, deps.now ?? new Date());
  if (!verification.ok) {
    return rejectedTelemetry(grant, verification.reason);
  }
  const serveSiteImpl = deps.serveSiteImpl ?? serveSite;

  // Register the heavy-only gates (Visual-QA) for any id the grant names, so they resolve
  // to executable gates in the same registry runGateStage runs from.
  const heavyIds = (grant.gateSpecs ?? [])
    .filter((spec): spec is Extract<typeof spec, { kind: 'generic' }> => spec.kind === 'generic')
    .map((spec) => spec.id);
  registerHeavyGatesForSpecs(deps.registry, heavyIds);

  // Multi-site takes precedence over `serve`: run the URL-bound gates once per site (each against
  // its own server + per-site config) while the deterministic gates run once. Absent -> the
  // single-`serve` path below, unchanged.
  const sites = deps.sites ?? grant.sites;
  if (sites && sites.length > 0) {
    return runPerSiteHeavyGates(grant, sites, deps, workspaceRoot, serveSiteImpl);
  }

  const serveConfig = deps.serve ?? grant.serve;
  let served: ServedSite | undefined;
  try {
    let configOverlay: Record<string, Record<string, unknown>> | undefined;
    if (serveConfig?.startCommand) {
      served = await serveSiteImpl(serveConfig, { cwd: workspaceRoot, ...(deps.serveDeps ?? {}) });
      configOverlay = {};
      for (const id of URL_BOUND_HEAVY_GATE_IDS) configOverlay[id] = { baseUrl: served.baseUrl };
      // The vision judge authenticates with the tenant's executor credential -- threaded onto
      // the visual-qa gate's runtime config the same way its baseUrl is.
      if (deps.executorCredential) {
        configOverlay['visual-qa'] = { ...configOverlay['visual-qa'], executorCredential: deps.executorCredential };
      }
    }

    return await runGateStage(grant, {
      ...deps,
      workspaceRoot,
      ...(configOverlay ? { configOverlay } : {}),
    });
  } finally {
    if (served) await served.stop().catch(() => {});
  }
}

// A site's serveSiteImpl (install/build/start/ready-poll) threw. The URL-bound gates for THIS
// site genuinely never ran -- publish them `skip/infra`, never a `fail` with invented findings
// (the exact mislabel this fix removes: a build break masquerading as an SEO content-gate
// FAILURE). A separate `heavy-serve (<site>)` check carries the real classification: a
// transient-shaped fault (registry hiccup, truncated tarball) reports `unjudged/infra`, which
// the control plane retries as an infra fault before escalating (bounded by `fix.maxBuildRetries`
// on the dispatch path, one gate-only retry on the blocking fix loop) -- a bare re-run may just
// clear it. A reproducible break (a real syntax/type error) reports `fail` with the real message,
// so it blocks the merge, correctly attributed to the build rather than to a phantom SEO finding.
function siteServeFailureChecks(site: SiteConfig, urlBoundIds: ReadonlySet<string>, err: unknown): CheckResult[] {
  const message = err instanceof Error ? err.message : String(err);
  // `baseId` for the same reason run-gate-stage.ts's toChecks sets it on every suffixed check: the
  // never-run / no-baseline ledger and the enabled-gate set are keyed by the BARE gate id
  // (promotion.ts's `baseIdOf`), so without it `baseId ?? id` falls back to this SUFFIXED name and
  // can never match an enabled id. That matters most precisely here -- "a gate that never ran
  // because its site would not serve" is the scenario the never-run diagnostic exists to report.
  const skipChecks: CheckResult[] = [...urlBoundIds].map((id) => ({
    name: `${id} (${site.name})`,
    baseId: id,
    status: 'pending',
    skipped: true,
    skipReason: 'infra',
  }));
  // `heavy-serve` is a per-site synthetic check, not one of the tenant's enabled gates, so it
  // carries no baseId -- there is no bare id for the ledger to match it against.
  const serveCheck: CheckResult = isTransientBuildFault(phaseOf(err), message)
    ? { name: `heavy-serve (${site.name})`, status: 'fail', unjudged: true, unjudgedReason: 'infra', findings: [message] }
    : { name: `heavy-serve (${site.name})`, status: 'fail', findings: [message] };
  return [...skipChecks, serveCheck];
}

// The multi-site heavy run. The deterministic gates (and any command gates) run ONCE against the
// PR checkout with no server; the URL-bound gates (seo-site-crawl, visual-qa) run ONCE PER SITE,
// each against that site's freshly served instance, with its baseUrl + per-site gateConfig
// overlaid and its checks named `<gate> (<site>)` so a legible per-site check lands. Every site
// is served then torn down in its own try/finally, so one site's server never leaks into the
// next. Results aggregate across all calls: a BLOCKING `fail` on ANY site fails the stage, while
// a report-only gate's fail is published without blocking (each runGateStage call honours the
// signed `blocking` flag). The loop is gate-agnostic, so an added URL-bound gate (e2e) reuses it.
async function runPerSiteHeavyGates(
  grant: ExecutionGrant,
  sites: readonly SiteConfig[],
  deps: RunHeavyGateStageDeps,
  workspaceRoot: string,
  serveSiteImpl: (config: ServeConfig, deps: ServeSiteDeps) => Promise<ServedSite>,
): Promise<StatusTelemetry> {
  const urlBound = new Set<string>(URL_BOUND_HEAVY_GATE_IDS);
  const urlBoundIds = new Set(
    (grant.gateSpecs ?? [])
      .filter((spec): spec is Extract<typeof spec, { kind: 'generic' }> => spec.kind === 'generic')
      .map((spec) => spec.id)
      .filter((id) => urlBound.has(id)),
  );
  // Everything else the grant carries -- the deterministic generic gates AND the command gates --
  // runs once, unsuffixed, without a server (a URL-bound gate is the only kind a per-site server
  // changes). runGateStage re-derives command ids from the signed specs, so "rest" is just "not a
  // URL-bound gate id".
  const restIds = new Set((grant.gateSpecs ?? []).map((spec) => spec.id).filter((id) => !urlBound.has(id)));

  const checks: CheckResult[] = [];
  let ok = true;
  // Every runGateStage call below scans the SAME checkout, so they all report the same stack.
  // Keep the first non-empty one rather than concatenating N identical copies into the report.
  let stack: string[] | undefined;
  const absorb = (telemetry: StatusTelemetry): void => {
    checks.push(...telemetry.checks);
    if (telemetry.result !== 'pass') ok = false;
    if (stack === undefined && telemetry.stack?.length) stack = telemetry.stack;
  };

  if (restIds.size > 0) {
    absorb(await runGateStage(grant, { ...deps, workspaceRoot, onlyGateIds: restIds }));
  }

  if (urlBoundIds.size > 0) {
    for (const site of sites) {
      let served: ServedSite | undefined;
      try {
        try {
          served = await serveSiteImpl(site.serve, { cwd: workspaceRoot, ...(deps.serveDeps ?? {}) });
        } catch (err) {
          // A real try/catch (not just the finally below): classify and move on to the NEXT
          // site rather than rethrow -- an uncaught throw here would propagate all the way out
          // of runPerSiteHeavyGates and discard any OTHER site's already-collected findings (and,
          // absent action-entry.ts's own catch, crash the runner before gate-report.json is
          // written at all).
          checks.push(...siteServeFailureChecks(site, urlBoundIds, err));
          ok = false;
          continue;
        }
        const configOverlay: Record<string, Record<string, unknown>> = {};
        for (const id of urlBoundIds) {
          // Per-site gateConfig (routes/brands/budgets) first, the served baseUrl over it -- the
          // baseUrl is the whole point of the served instance, so it always wins.
          configOverlay[id] = { ...(site.gateConfig?.[id] ?? {}), baseUrl: served.baseUrl };
        }
        if (deps.executorCredential && urlBoundIds.has('visual-qa')) {
          configOverlay['visual-qa'] = { ...configOverlay['visual-qa'], executorCredential: deps.executorCredential };
        }
        absorb(
          await runGateStage(grant, {
            ...deps,
            workspaceRoot,
            configOverlay,
            onlyGateIds: urlBoundIds,
            checkNameSuffix: ` (${site.name})`,
          }),
        );
      } finally {
        if (served) await served.stop().catch(() => {});
      }
    }
  }

  return {
    grantId: grantId(grant),
    result: ok ? 'pass' : 'fail',
    checks,
    // Forwarded, not re-derived: this aggregate telemetry replaces the per-call ones, so
    // without this the heavy stage would be the one tenant shape whose gate report has no
    // stack line.
    ...(stack !== undefined ? { stack } : {}),
    logDigest: digestFor(grant.repoId, grant.ticketId, grant.stage, String((grant.gateSpecs ?? []).length)),
  };
}
