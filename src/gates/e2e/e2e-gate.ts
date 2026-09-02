// e2e: the end-to-end heavy gate (docs/ci-gate-refit-plan.md P5). It runs the CUSTOMER's own
// end-to-end suite (a tenant-configured command, e.g. `yarn test:e2e:tekunda`) against the SERVED
// site the heavy stage brought up -- the same "we run/crawl the served site, we don't own the
// specs" split the SEO crawl and Visual-QA gates use. Autopilot owns the mechanism (run the
// configured command against the served baseUrl, judge the exit code); the specs are the
// customer's, in their repo.
//
// This runs ONLY in the dedicated heavy stage -- the only stage with a live served server
// (src/runner/serve-and-gate.ts). It judges a SETTLED local build (§11): the served instance the
// heavy stage brought up, never a mid-rollout production deploy.
//
// Everything site-specific is config (ctx.config['e2e']): the command to run and the served
// baseUrl (threaded in by the serve stage). The gate hardcodes neither. Exit 0 -> pass, non-zero
// -> fail with a bounded head-and-tail capture of the command's output as findings, mirroring
// the H3 command gate.
// Report-only is honored at the spec level (a `blocking:false` signed spec, from
// PackConfig.gateConfig['e2e']): the gate reports its honest `fail`, and run-gate-stage excludes a
// non-blocking gate's fail from the stage verdict -- exactly like the other pack gates.

import { runCommand as defaultRunCommand } from '../exec.ts';
import { boundedCapture } from '../output-capture.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

export const E2E_GATE_ID = 'e2e';

// The env var the customer's Playwright config reads its base URL from -- Tekunda/Website's
// apps/*/playwright.config.ts use `baseURL: process.env.PLAYWRIGHT_BASE_URL`. The heavy stage
// threads the served instance's baseUrl into ctx.config['e2e'].baseUrl; this gate exports it to
// the spawned command under this name so the suite targets the served site.
export const E2E_BASE_URL_ENV = 'PLAYWRIGHT_BASE_URL';

export interface E2eConfig {
  // The tenant's e2e command line, run via `sh -c` in the PR checkout (e.g. `yarn test:e2e:tekunda`).
  // Absent -> the gate skips (nothing to run), never fails.
  run?: string;
  // The served site root -- threaded in by the heavy stage (serve-and-gate.ts) at run time, since
  // the local server's URL cannot be known at grant-issue time. Absent -> the gate skips (no served
  // site to point the suite at), so a tenant with no serve stage wired is not blocked.
  baseUrl?: string;
}

export interface E2eDeps {
  // Injected for tests; defaults to the shared exec seam.
  runCommand?: typeof defaultRunCommand;
}

// Yarn writes a content-free `error Command failed with exit code 1.` (plus its docs pointer) on
// EVERY non-zero exit, so stderr is never empty when the suite fails. Preferring a non-empty
// stderr therefore shipped nothing but that boilerplate and dropped the one informative stream --
// Playwright writes its per-spec failure report to stdout. Strip the known-generic lines before
// judging whether stderr says anything of its own.
const RUNNER_NOISE = [
  /^error Command failed with exit code \d+\.$/,
  /^error Command failed with signal .*$/,
  /^info Visit https:\/\/yarnpkg\.com\/.*$/,
];

function stripRunnerNoise(text: string): string {
  return text
    .split('\n')
    .filter((line) => !RUNNER_NOISE.some((noise) => noise.test(line.trim())))
    .join('\n')
    .trim();
}

function failureFindings(run: string, exitCode: number, stdout: string, stderr: string): string[] {
  const findings = [`\`${run}\` exited ${exitCode}`];
  // Both streams can carry real diagnostics (the spec report on stdout, a crash or a missing
  // browser binary on stderr), so ship both, as ONE budgeted capture -- stderr last, because a
  // short stderr diagnostic appended at the end lands inside the tail the capture retains, next
  // to the end of the stdout report. boundedCapture keeps the head too, so the first failed
  // spec's assertion diff survives a run in which hundreds of specs failed -- that first block is
  // the diagnosis a fixer needs, and it is the first thing a tail-only capture threw away.
  const detail = boundedCapture([stdout.trim(), stripRunnerNoise(stderr)].filter(Boolean).join('\n'));
  if (detail) findings.push(detail);
  return findings;
}

function resolveConfig(ctx: GateContext): E2eConfig | undefined {
  const raw = ctx.config[E2E_GATE_ID] as E2eConfig | undefined;
  return raw && typeof raw === 'object' ? raw : undefined;
}

export function createE2eGate(deps: E2eDeps = {}): Gate {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  return {
    id: E2E_GATE_ID,
    async run(ctx: GateContext): Promise<GateResult> {
      const config = resolveConfig(ctx);
      if (!config?.run) {
        // No command configured -> nothing to run. Skip cleanly, never fail.
        return { id: E2E_GATE_ID, status: 'skip', findings: ['no e2e command configured'] };
      }
      if (!config.baseUrl) {
        // No served URL -> nowhere to point the suite. Skip cleanly (the serve stage that supplies
        // baseUrl is a prerequisite).
        return { id: E2E_GATE_ID, status: 'skip', findings: ['no served baseUrl (serve stage not wired)'] };
      }

      const env: NodeJS.ProcessEnv = { ...process.env, [E2E_BASE_URL_ENV]: config.baseUrl };
      try {
        const { exitCode, stdout, stderr } = await runCommand('sh', ['-c', config.run], ctx.workspaceRoot, { env });
        if (exitCode === 0) return { id: E2E_GATE_ID, status: 'pass' };
        return { id: E2E_GATE_ID, status: 'fail', findings: failureFindings(config.run, exitCode, stdout, stderr) };
      } catch (err) {
        return {
          id: E2E_GATE_ID,
          status: 'fail',
          findings: [`\`${config.run}\` could not run: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
    },
  };
}

// The default-wired gate for the heavy stage's registry (src/runner/gate-registry.ts).
export const e2eGate: Gate = createE2eGate();
