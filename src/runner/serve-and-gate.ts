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

import type { ExecutionGrant, ServeConfig, StatusTelemetry } from '../contracts/types.ts';
import type { ExecutorCredential } from '../gates/visual/judge.ts';
import { verifyGrant } from '../control-plane/grant-verify.ts';
import { runCommand as defaultRunCommand } from '../gates/exec.ts';
import { registerHeavyGatesForSpecs } from './gate-registry.ts';
import { rejectedTelemetry } from './prepare-stage.ts';
import { runGateStage, type RunGateStageDeps } from './run-gate-stage.ts';

// The serve recipe (install/build/start/baseUrl) is a signed grant field -- see ServeConfig and
// ExecutionGrant.serve in ../contracts/types.ts. Re-exported here for the modules and tests that
// already reach for it through this heavy-stage entry point.
export type { ServeConfig };

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

async function runOrThrow(
  runCommand: typeof defaultRunCommand,
  label: string,
  line: string,
  cwd: string,
): Promise<void> {
  const { exitCode, stderr, stdout } = await runCommand('sh', ['-c', line], cwd);
  if (exitCode !== 0) {
    const tail = (stderr.trim() || stdout.trim()).slice(-2000);
    throw new Error(`${label} \`${line}\` exited ${exitCode}: ${tail}`);
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
      throw new Error(`server \`${config.startCommand}\` exited before becoming ready (code ${serverExited})`);
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
      throw new Error(`server \`${config.startCommand}\` not ready at ${readyUrl} within ${timeoutMs}ms`);
    }
    await sleep(intervalMs);
  }
}

// Gate ids whose runtime baseUrl is the served instance this stage just brought up. The overlay
// wins over any baseUrl in the signed/target config (see run-gate-stage.ts configOverlay).
export const URL_BOUND_HEAVY_GATE_IDS = ['seo-site-crawl', 'visual-qa'] as const;

export interface RunHeavyGateStageDeps extends RunGateStageDeps {
  // The serve recipe. Defaults to the grant's SIGNED `serve` field (never the unsigned target
  // config -- the startCommand is a shell command, so it must come from the verified grant).
  // Absent on both -> the stage runs the gates WITHOUT bringing a server up (they skip cleanly
  // when they need a URL).
  serve?: ServeConfig;
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
  const serveConfig = deps.serve ?? grant.serve;
  const serveSiteImpl = deps.serveSiteImpl ?? serveSite;

  // Register the heavy-only gates (Visual-QA) for any id the grant names, so they resolve
  // to executable gates in the same registry runGateStage runs from.
  const heavyIds = (grant.gateSpecs ?? [])
    .filter((spec): spec is Extract<typeof spec, { kind: 'generic' }> => spec.kind === 'generic')
    .map((spec) => spec.id);
  registerHeavyGatesForSpecs(deps.registry, heavyIds);

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
