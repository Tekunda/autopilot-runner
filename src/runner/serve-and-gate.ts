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
// errors a prior mid-rollout incident hit. A local `yarn build` + `yarn start` is atomic and
// settled by the time wait-for-ready returns, so the heavy gates see a stable site.
//
// The exact install/build/start commands are NOT hardcoded -- they come from tenant config (the
// same command strings a command gate uses, e.g. `yarn build:<site>` / `yarn start:<site>`), so
// nothing here is site-specific.

import { spawn as nodeSpawn } from 'node:child_process';

import type { CheckResult, ExecutionGrant, ServeConfig, SiteConfig, StatusTelemetry } from '../contracts/types.ts';
import { matchesAnyPath, sitesForChangedFiles } from '../contracts/changed-paths.ts';
import { canonicalGateId, gateConfigFor } from '../gates/gate-id-aliases.ts';
import type { ExecutorCredential } from '../gates/visual/judge.ts';
import { verifyGrant } from '../control-plane/grant-verify.ts';
import { runCommand as defaultRunCommand } from '../gates/exec.ts';
import { boundedCapture } from '../gates/output-capture.ts';
import { registerHeavyGatesForSpecs } from './gate-registry.ts';
import { SITE_SCOPED_GATE_IDS, URL_BOUND_HEAVY_GATE_IDS } from './heavy-gate-ids.ts';
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
  const verification = verifyGrant(grant, deps.verifyKey, deps.now ?? new Date(), deps.environment);
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

// The gates a site's OWN checks would have carried, reported as an explicit per-site SKIP because
// this PR's diff touches none of the site's declared `paths`. Published rather than silently
// omitted: an absent check is indistinguishable from a gate nobody noticed did not run, which is
// the failure mode run-gate-stage.ts's `missing` backstop exists for. Same shape as
// siteServeFailureChecks' skips (including `baseId` for the never-run ledger); only the reason
// differs, and it is a DIFF-scoped one -- the next PR touching this site runs it.
//
// Both per-site loops report through here, so `notRunPhrase` names what actually did not happen:
// the URL-bound loop never brought the site's server up ("was not served"), while the site-scoped
// deterministic loop had a server-less run to make but no file of this site's to make it about
// ("owns none of this diff").
function siteOutOfScopeChecks(
  site: SiteConfig,
  gateIds: ReadonlySet<string>,
  changedFiles: readonly string[],
  notRunPhrase: string,
): CheckResult[] {
  return [...gateIds].map((id) => ({
    name: `${id} (${site.name})`,
    baseId: id,
    status: 'pending' as const,
    skipped: true as const,
    skipReason: 'no-matching-files' as const,
    findings: [
      `${site.name} ${notRunPhrase}: none of the ${changedFiles.length} changed file(s) matches ` +
        `[${(site.paths ?? []).join(', ')}], so this diff cannot change what ${id} would see there.`,
    ],
  }));
}

// Does this site CLAIM the file -- would it be judged here at all?
//
// A site that declared no `paths` never claimed to be scopeable, so it claims EVERYTHING. That is
// the inclusive reading contracts/changed-paths.ts takes for the same question.
function siteClaims(site: SiteConfig, file: string): boolean {
  if (!site.paths || site.paths.length === 0) return true;
  return matchesAnyPath(file, site.paths);
}

// Does this site OWN the file -- did it positively NAME it? Stricter than siteClaims: a pathless
// site claims everything and owns nothing, because it never said what it was about.
//
// Ownership, not claim, is what may EXCLUDE a file from another site (filesForSite). The
// difference decides the shared-file rule: keyed on claim, a pathless sibling would absorb every
// unclaimed `packages/**` file and the scoped site would skip a file its own build consumes --
// the opposite of the rule contracts/changed-paths.ts states and sitesForChangedFiles enforces,
// where a file matching no site's paths selects EVERY site.
function siteOwns(site: SiteConfig, file: string): boolean {
  return Boolean(site.paths && site.paths.length > 0 && matchesAnyPath(file, site.paths));
}

// The changed files ONE site's server-less, site-scoped gates are allowed to judge, plus the two
// distinct ways a file can be in that run without the site owning it.
//
// A file is EXCLUDED from a site only on the positive fact that another site OWNS it and this one
// does not claim it. So a file NO site owns runs everywhere -- the shared-module / lockfile /
// cross-site content case -- and ambiguity again resolves towards RUNNING, because a missed gate
// is worse than a wasted one. It is also why no shared path list has to be written or kept in
// sync: sites declare only what they OWN.
//
// A pathless site is therefore fan-out in both directions: it grades everything, and it excludes
// nothing from anyone. That is the honest reading -- it declared nothing, so "its" files and
// shared files are indistinguishable -- and the tenant closes the ambiguity by declaring `paths`.
//
// The two unowned sets are returned rather than re-derived by the caller, so the notes that report
// them and the selection they describe can never disagree. They are kept APART because only one of
// them supports a cross-site claim:
//   - `unclaimed`: no site owns it, so by the rule above it is in EVERY site's run. A note may say
//     so of every site.
//   - `foreign`: another site owns it and this (pathless) site graded it anyway. A note may say
//     only what THIS site did -- a third, scoped site excluded it.
function filesForSite(
  site: SiteConfig,
  sites: readonly SiteConfig[],
  changedFiles: readonly string[],
): { files: readonly string[]; unclaimed: readonly string[]; foreign: readonly string[] } {
  const files: string[] = [];
  const unclaimed: string[] = [];
  const foreign: string[] = [];
  for (const file of changedFiles) {
    const owner = sites.find((candidate) => siteOwns(candidate, file));
    if (owner && !siteClaims(site, file)) continue;
    files.push(file);
    if (!owner) unclaimed.push(file);
    else if (owner !== site && !siteOwns(site, file)) foreign.push(file);
  }
  return { files, unclaimed, foreign };
}

// How many paths a note names before it summarises the rest. A note is a diagnostic, not a
// manifest: a 200-file refactor must not bury the finding it is attached to.
const UNOWNED_FILE_NOTE_LIMIT = 10;

function listed(files: readonly string[]): string {
  const named = files.slice(0, UNOWNED_FILE_NOTE_LIMIT).join(', ');
  return files.length > UNOWNED_FILE_NOTE_LIMIT ? `${named}, +${files.length - UNOWNED_FILE_NOTE_LIMIT} more` : named;
}

// The provenance of the files a site graded without owning them, as `note:` findings.
//
// This has to be SAID, not just done. A file graded under more than one site's rules is a file
// whose finding means something different: it is evidence the file is wrongly shared and wants
// splitting into per-site variants. Without the provenance a reader (or a fix agent) sees a
// finding against a file the site never named and reaches for the two wrong repairs -- weakening
// the rule, or contorting one file to satisfy every site.
//
// EVERY SENTENCE HERE IS ONLY WHAT THE DATA SUPPORTS. `unclaimed` is owned by nobody, which by
// filesForSite's rule puts it in every site's run, so the cross-site sentence is a fact. `foreign`
// is owned by someone else, so all that can be said is what THIS site did -- a scoped third site
// excluded that file, and claiming otherwise would send a reader looking for a check that does not
// exist.
//
// A `note:` finding is the seam the content gates already use for "something about WHAT I looked
// at, which is not itself a defect". Verdicts are computed before these are attached, so a note can
// never turn a check red, and they ride on every check of the run (not only the failed ones)
// because they are facts about the selection, not about any one gate's result.
function selectionNotes(
  site: SiteConfig,
  sites: readonly SiteConfig[],
  selection: { unclaimed: readonly string[]; foreign: readonly string[] },
): string[] {
  // Nothing to disambiguate for a lone site: there is no other rule set for a file to also be
  // graded under, so every sentence below would be about a comparison that does not exist.
  if (sites.length < 2) return [];
  // NOBODY declared `paths`. Then every file is unclaimed in every run and a per-file list carries
  // no information -- it is just the diff, repeated on every check, for the tenants who scoped
  // nothing. One note that names the cause and the remedy is the whole signal.
  if (!sites.some((candidate) => candidate.paths && candidate.paths.length > 0)) {
    return selection.unclaimed.length === 0
      ? []
      : [
          `note: no site declares \`paths\`, so ownership of the ${selection.unclaimed.length} changed file(s) is ` +
            `undecidable and every site graded all of them under its own rules. Declaring \`paths\` on the sites ` +
            'will scope this.',
        ];
  }
  const notes: string[] = [];
  if (selection.unclaimed.length > 0) {
    notes.push(
      `note: ${selection.unclaimed.length} changed file(s) are owned by no site, so EVERY site graded them under ` +
        'its own rules. A finding against one of these means the file is wrongly shared and wants a per-site ' +
        `variant -- not a weakened rule, and not one file bent to satisfy every site: ${listed(selection.unclaimed)}`,
    );
  }
  if (selection.foreign.length > 0) {
    notes.push(
      `note: ${site.name} declares no \`paths\`, so it also graded ${selection.foreign.length} changed file(s) ` +
        `another site owns. Declare \`paths\` on ${site.name} to stop it judging content it does not own: ` +
        `${listed(selection.foreign)}`,
    );
  }
  return notes;
}

// Per-site gateConfig keys that named a site-scoped gate this run did not execute -- so the config
// sits there looking applied and does nothing.
//
// The alias map resolves a LEGACY key onto the canonical gate (gateConfigFor), which is the common
// case and needs no note. It does not resolve the reverse: config written under the CURRENT name
// while an unexpired grant still names the old one. That is a real shortfall and the same failure
// mode inertScopesNote exists for, so it is reported rather than dropped.
//
// Computed for EVERY site, outside the per-site loop, because the worst case is the one where that
// loop never runs: the grant names none of these gates at all (the tenant is not entitled, or the
// gate is off), so `ran` is empty, every per-site value applies to nothing, and there is no
// per-site check to hang the news on. This note's own text offers exactly that as a cause, so it
// has to survive it -- see publishedSiteNotes below for how it reaches the report either way.
function unappliedConfigNote(site: SiteConfig, siteScoped: ReadonlySet<string>, ran: ReadonlySet<string>): string | undefined {
  const gateConfig = site.gateConfig;
  if (!gateConfig) return undefined;
  // Identity, not id arithmetic: "applied" means some gate this run executed actually RESOLVED to
  // this entry. Comparing canonical ids instead would call a legacy-id run and a canonical-id key
  // a match, which is the one case that does NOT resolve and the whole reason for this note.
  const applied = new Set([...ran].map((id) => gateConfigFor(id, gateConfig)).filter((entry) => entry !== undefined));
  const stranded = Object.keys(gateConfig).filter(
    (key) => siteScoped.has(canonicalGateId(key)) && !applied.has(gateConfig[key]),
  );
  if (stranded.length === 0) return undefined;
  return (
    `note: per-site config for ${site.name} names ${stranded.join(', ')}, which this run did not execute, so ` +
    'those values applied to nothing. The grant may still name the gate under a different id, or the tenant may ' +
    'not be entitled to it.'
  );
}

// The config a gate id would have run with WITHOUT any per-site overlay: the signed spec's own
// config, else the runner-supplied target config for that id. Mirrors the precedence
// run-gate-stage.ts applies before it merges the overlay on top.
function baseConfigFor(grant: ExecutionGrant, deps: RunHeavyGateStageDeps, id: string): Record<string, unknown> {
  const spec = (grant.gateSpecs ?? []).find((candidate) => candidate.kind === 'generic' && candidate.id === id);
  const signed = spec?.kind === 'generic' ? spec.config : undefined;
  // `!== undefined`, not `??`: run-gate-stage.ts tests the same way, so a spec config of `null`
  // shadows the target config there and must shadow it here too, or this note would be computed
  // against config the gate never saw.
  const resolved = signed !== undefined ? signed : deps.target.config?.[id];
  return resolved && typeof resolved === 'object' ? (resolved as Record<string, unknown>) : {};
}

// The pre-per-site `scopes` workaround -- a private per-path rule list some gate configs still
// carry -- has been REMOVED from the gates. Nothing reads the key any more, so a config that still
// carries one is running on its top-level rule list and the key changes nothing at all.
//
// Still reported, because dead config that LOOKS applied is exactly what this stage's other notes
// exist to surface: a tenant reading a rule list cannot tell an obeyed one from an ignored one, and
// the key will otherwise sit there being mistaken for the reason a file was (or was not) flagged.
//
// Keyed on the key's PRESENCE, not on any overlap with per-site config: an inert key is inert
// whether or not the site also configures the gate, and keying on the overlap would hide it from
// the one tenant most in need of the news -- the one that never moved its rules to per-site config.
function inertScopesNote(id: string, base: Record<string, unknown>): string | undefined {
  if (base['scopes'] === undefined) return undefined;
  return (
    `note: the config for ${id} still carries a \`scopes\` key. It is IGNORED -- the per-path rule ` +
    'mechanism it configured no longer exists, so the gate ran on its top-level rule list and the key ' +
    'changed nothing. Delete it; per-path rules come from per-site gateConfig now.'
  );
}

// Attach notes to the checks a per-site run produced. `forAll` rides on every check (facts about
// the SELECTION, true of every gate in the run); `byGateId` rides only on the check for that gate
// (facts about one gate's config). Non-destructive (the telemetry is rebuilt, not mutated) and
// verdict-free: `status` and every flag are copied through untouched.
function withNotes(
  telemetry: StatusTelemetry,
  forAll: readonly string[],
  byGateId: ReadonlyMap<string, string>,
): StatusTelemetry {
  if (forAll.length === 0 && byGateId.size === 0) return telemetry;
  return {
    ...telemetry,
    checks: telemetry.checks.map((check) => {
      const own = byGateId.get(check.baseId ?? check.name);
      const added = own ? [...forAll, own] : forAll;
      return added.length > 0 ? { ...check, findings: [...(check.findings ?? []), ...added] } : check;
    }),
  };
}

// The multi-site heavy run, a THREE-way split of the grant's signed specs:
//
//   - URL-bound gates (seo-site-crawl, visual-qa, e2e, layout-rules) run ONCE PER SITE against
//     that site's freshly served instance, with its baseUrl + per-site gateConfig overlaid;
//   - site-scoped deterministic gates (SITE_SCOPED_GATE_IDS -- the content/SEO gates) also run
//     ONCE PER SITE, but with NO server: per-site gateConfig overlaid and `ctx.changedFiles`
//     narrowed to the files that site owns, so each site's rules judge only that site's content.
//     Opt-in on evidence -- see the lane derivation below -- so a tenant that has configured
//     nothing per-site keeps them in the lane below;
//   - everything else (every deterministic gate neither lane took, AND the command gates) runs
//     ONCE, unsuffixed, against the whole checkout, exactly as before.
//
// Both per-site loops name their checks `<gate> (<site>)` so a legible per-site check lands. Every
// served site is torn down in its own try/finally, so one site's server never leaks into the next.
// Results aggregate across all calls: a BLOCKING `fail` on ANY site fails the stage, while a
// report-only gate's fail is published without blocking (each runGateStage call honours the signed
// `blocking` flag). Both loops are gate-agnostic, so an added id in either list reuses them.
async function runPerSiteHeavyGates(
  grant: ExecutionGrant,
  sites: readonly SiteConfig[],
  deps: RunHeavyGateStageDeps,
  workspaceRoot: string,
  serveSiteImpl: (config: ServeConfig, deps: ServeSiteDeps) => Promise<ServedSite>,
): Promise<StatusTelemetry> {
  const urlBound = new Set<string>(URL_BOUND_HEAVY_GATE_IDS);
  const siteScoped = new Set<string>(SITE_SCOPED_GATE_IDS);
  const genericIds = (grant.gateSpecs ?? [])
    .filter((spec): spec is Extract<typeof spec, { kind: 'generic' }> => spec.kind === 'generic')
    .map((spec) => spec.id);
  const urlBoundIds = new Set(genericIds.filter((id) => urlBound.has(id)));
  // OPT-IN ON EVIDENCE. A site-scoped gate joins the per-site lane only when the tenant has
  // actually said something per-site about it: some site declares `paths` (so the files can be
  // split) or some site declares `gateConfig` for that id (so the rules can be). Without either,
  // running it per site would run the SAME gate over the SAME files with the SAME config once per
  // site and publish N duplicate checks and N copies of every finding -- pure noise, and a
  // behaviour change for every tenant that has not adopted this yet. So it stays in the `rest`
  // lane and runs once, exactly as before.
  const anySiteScopesFiles = sites.some((site) => site.paths && site.paths.length > 0);
  const siteScopedIds = new Set(
    genericIds.filter(
      (id) =>
        siteScoped.has(id) &&
        // Alias-resolved, like the overlay below and like the server-side PackRegistry: a tenant
        // keys `gateConfig` by whatever the gate was called when they wrote it, and an exact-id
        // lookup would read a legacy key as "no per-site config" and leave the lane off.
        (anySiteScopesFiles || sites.some((site) => gateConfigFor(id, site.gateConfig) !== undefined)),
    ),
  );
  // Everything else the grant carries -- the deterministic generic gates neither lane took AND the
  // command gates -- runs once, unsuffixed, against the whole diff. A command gate is never
  // site-scoped: its scoping axis is its own signed `paths`, honoured inside the gate.
  //
  // Subtracted from the DERIVED lane sets, never from the constant id lists. Against the constants,
  // a `{kind:'command'}` spec whose id collides with a lane id would land in NO lane: absent from
  // every `onlyGateIds`, so run-gate-stage.ts never adds it to `enabledIds`, so even its `missing`
  // backstop cannot see it -- and the stage reports PASS with no checks at all. Silent green, from
  // one colliding id. The derived sets contain only ids a lane will really run, so every remaining
  // id lands here and is reported one way or another.
  const restIds = new Set(
    (grant.gateSpecs ?? []).map((spec) => spec.id).filter((id) => !urlBoundIds.has(id) && !siteScopedIds.has(id)),
  );

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

  // Stranded per-site config, worked out for every site BEFORE the lane guard below. The guard is
  // exactly the condition under which this diagnostic matters most (no site-scoped gate ran, so
  // nothing consumed any of it), and computing it inside would silence it there.
  const strandedBySite = new Map<string, string>();
  for (const site of sites) {
    const note = unappliedConfigNote(site, siteScoped, siteScopedIds);
    if (note) strandedBySite.set(site.name, note);
  }
  // Sites whose stranded-config note has found a home on a real check. Whatever is left over at
  // the end gets a synthetic check of its own, so the news never depends on a lane having run.
  const reported = new Set<string>();

  if (siteScopedIds.size > 0) {
    // No server here -- these gates read the checkout. What makes them per-site is the pair of
    // per-site inputs: the site's own gateConfig (its banned phrases, its competitor list) and a
    // changedFiles list narrowed to the files it owns. Run under a site's rules, a file belonging
    // to the OTHER brand would be judged by rules that were never written for it.
    const changedFiles = deps.target.changedFiles;
    for (const site of sites) {
      const stranded = strandedBySite.get(site.name);
      const selection = filesForSite(site, sites, changedFiles);
      const { files } = selection;
      // An EMPTY selection is only a skip when the diff itself was non-empty -- that is the
      // positive fact "this site owns none of these files". An empty `changedFiles` is IGNORANCE
      // (contracts/changed-paths.ts), so it runs, with the same empty list today's single
      // unsuffixed call would have passed. And the skip is PUBLISHED, never an omission: an
      // unreported gate reads as a pass nobody checked.
      if (files.length === 0 && changedFiles.length > 0) {
        process.stdout.write(`[site] ${site.name}: content gates not run -- owns no file in this diff\n`);
        const skips = siteOutOfScopeChecks(site, siteScopedIds, changedFiles, 'owns none of this diff');
        // A site can be out of THIS diff's scope and still be misconfigured, and the skip checks
        // are the only per-site checks it will publish -- so the stranded config rides on them.
        if (stranded) {
          process.stdout.write(`[site] ${site.name}: ${stranded}\n`);
          reported.add(site.name);
          for (const skip of skips) skip.findings = [...(skip.findings ?? []), stranded];
        }
        checks.push(...skips);
        continue;
      }
      const configOverlay: Record<string, Record<string, unknown>> = {};
      const configNotes = new Map<string, string>();
      for (const id of siteScopedIds) {
        const perSite = { ...(gateConfigFor(id, site.gateConfig) ?? {}) };
        configOverlay[id] = perSite;
        const inertScopes = inertScopesNote(id, baseConfigFor(grant, deps, id));
        if (inertScopes) configNotes.set(id, inertScopes);
      }
      const runNotes = selectionNotes(site, sites, selection);
      if (stranded) {
        runNotes.push(stranded);
        reported.add(site.name);
      }
      for (const line of [...runNotes, ...configNotes.values()]) {
        process.stdout.write(`[site] ${site.name}: ${line}\n`);
      }
      const telemetry = await runGateStage(grant, {
        ...deps,
        workspaceRoot,
        configOverlay,
        onlyGateIds: siteScopedIds,
        changedFilesOverride: files,
        checkNameSuffix: ` (${site.name})`,
      });
      absorb(withNotes(telemetry, runNotes, configNotes));
    }
  }

  if (urlBoundIds.size > 0) {
    // Serve only the sites this PR's diff can actually affect. A production build + crawl PER SITE
    // is the most expensive thing this stage does, and a dual-brand monorepo was paying for every
    // brand on every PR. Opt-in (SiteConfig.paths) and biased towards running: an unscoped tenant
    // is unchanged, and a changed file no site claims is shared and selects all of them. See
    // contracts/changed-paths.ts.
    const changedFiles = deps.target.changedFiles;
    const selected = sitesForChangedFiles(sites, changedFiles);
    for (const site of sites) {
      if (selected.includes(site)) continue;
      process.stdout.write(`[site] ${site.name}: not served -- out of this diff's path scope\n`);
      checks.push(...siteOutOfScopeChecks(site, urlBoundIds, changedFiles, 'was not served'));
    }
    for (const site of selected) {
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
          // Alias-resolved like every other per-site lookup. Dormant while no URL-bound gate has
          // been renamed -- and it must stay that way by construction, because unappliedConfigNote
          // only inspects the site-scoped ids, so a legacy key here would stop applying with
          // nothing to report it.
          configOverlay[id] = { ...(gateConfigFor(id, site.gateConfig) ?? {}), baseUrl: served.baseUrl };
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

  // Any site whose stranded config found no check to ride on gets one. This is the case the guard
  // above creates: the grant names no site-scoped gate, so the lane never ran and the per-site
  // values applied to nothing -- the exact silence this note exists to break. Synthetic and
  // non-blocking, like `heavy-serve (<site>)`, and carrying no `baseId` because there is no bare
  // gate id for the never-run ledger to match it against.
  for (const site of sites) {
    const stranded = strandedBySite.get(site.name);
    if (!stranded || reported.has(site.name)) continue;
    process.stdout.write(`[site] ${site.name}: ${stranded}\n`);
    checks.push({ name: `heavy-config (${site.name})`, status: 'pass', findings: [stranded] });
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
