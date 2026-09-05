// e2e: the end-to-end heavy gate (docs/ci-gate-refit-plan.md P5). It runs the CUSTOMER's own
// end-to-end suite (a tenant-configured command, e.g. `yarn test:e2e`) against the SERVED
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

// The env var the customer's Playwright config reads its base URL from -- the conventional
// `baseURL: process.env.PLAYWRIGHT_BASE_URL` a tenant's playwright.config.ts declares. The heavy
// stage threads the served instance's baseUrl into ctx.config['e2e'].baseUrl; this gate exports it
// to the spawned command under this name so the suite targets the served site.
export const E2E_BASE_URL_ENV = 'PLAYWRIGHT_BASE_URL';

// Provision the browsers the tenant's OWN Playwright will look for, in the checkout, immediately
// before the suite runs.
//
// The heavy stage already installs a browser (action.yml's "Provision heavy gate stage" pins
// playwright@1.62.1 and runs `npx playwright install --with-deps chromium`), and that is NOT
// enough -- it is Autopilot's browser, for Autopilot's own gates. Playwright resolves a browser by
// BUILD REVISION, not by "some chromium is present": 1.62.1 downloads
// `~/.cache/ms-playwright/chromium_headless_shell-1234`, while a tenant whose lockfile pins
// @playwright/test 1.59.1 launches `chromium_headless_shell-1217` and dies with
// `browserType.launch: Executable doesn't exist at ...` on every spec that opens a page. That is
// exactly what the first PR to run this gate hit: most of the suite failed or never ran, on the
// missing binary alone -- while the specs that only use the `request` fixture passed against the
// same served site, which is why the run looked partially healthy rather than obviously broken.
//
// It has to happen HERE and not in action.yml, because the tenant's Playwright does not exist
// until the heavy stage's install step has populated the checkout's node_modules -- which is after
// every step in action.yml has run.
//
// `--no-install` is load-bearing, not caution: it makes npx run the CHECKOUT's own playwright CLI
// and refuse to fetch one from the registry. Without it a repo with no local Playwright would pull
// whatever `latest` is that day and install ITS revision -- reintroducing, from a second source,
// the exact version skew this line exists to remove.
//
// `--with-deps` is deliberately absent: the OS shared libraries are already installed by the
// action's own `--with-deps` run, and installing them again would need sudo for no gain. Only the
// browser binaries are missing, and `install chromium` fetches both `chromium-<rev>` and
// `chromium_headless_shell-<rev>` for the tenant's revision, which is the pair a headless run
// needs. Chromium alone, matching the single browser the heavy stage provisions for its own gates:
// a tenant whose suite drives firefox or webkit still gets Playwright's own explicit
// "run playwright install" error, exactly as it does today -- never a false pass.
export const E2E_BROWSER_PROVISION_COMMAND = 'npx --no-install playwright install chromium';

// PROVISIONAL. How long the tenant's suite may run before the gate kills it.
//
// It exists because exec.ts's DEFAULT_TIMEOUT_MS is 10 minutes and a real suite does not fit: the
// browser fix above turns "every spec dies instantly" into "the whole suite actually runs, one
// worker at a time", and a timeout REJECTS rather than returning an exit code, so the gate would
// swap a red `Executable doesn't exist` for a red `could not run: ...` and teach us nothing.
//
// THE CEILING IS NOT THIS GATE'S TO SPEND, and that is the part to read before raising it. The
// same budget ordering the Salesforce org gates document (org-gate-common.ts) applies here:
//
//     E2E_SUITE_TIMEOUT_MS x (number of sites)  <  HOSTED_STAGE_TIMEOUT_MS  <  runner.yml's
//                                                  `timeout-minutes: 40`  <  the 45-min grant TTL
//
// The heavy stage runs the URL-bound gates ONCE PER SITE, sequentially, inside ONE stage
// (serve-and-gate.ts's runPerSiteHeavyGates), and the hosted control plane cancels that stage at
// HOSTED_STAGE_TIMEOUT_MS = 35 minutes. A gate still running then produces no verdict and no
// gate-report.json -- so a too-generous per-gate budget does not buy a slow suite more room, it
// destroys the whole stage's output, including the seo-site-crawl and visual-qa verdicts that had
// already passed. A gate whose budget exceeds its stage's does not gate; it just loses.
//
// The arithmetic, against the MEASURED cost of the stage that produced this defect (a two-site
// tenant, whose `Autopilot / gate` took 9m46s of wall clock for both sites):
//
//     35.0   HOSTED_STAGE_TIMEOUT_MS
//   -  6.2   that stage's non-e2e cost: checkout, npm ci, the action's own browser install,
//            and per site yarn install + `yarn build:<site>` + serve + the full sitemap crawl
//            (the 9m46s total, less what the two fast-failing e2e runs spent)
//   -  2.0   NEW: the tenant browser download above -- a real fetch on the first site, a no-op
//            on the second
//   -  1.0   assembling and publishing gate-report.json, plus headroom
//   = 25.8   left, SHARED BY BOTH SITES
//
// 12 x 2 = 24 fits, with ~1.8 minutes of slack. It is the largest defensible value, not a
// comfortable one.
//
// WHY IT IS PROVISIONAL: no green run has ever reported how long these suites actually take, so
// 12 minutes is a ceiling sized by what the stage can afford, NOT by what the suite needs.
// Tighten it once a green run reports a real duration. If a green run instead shows the suites
// need MORE than this, RAISING THIS CONSTANT IS THE WRONG FIX -- it would blow the stage deadline
// and produce no verdict at all. The two right fixes both live elsewhere: give the suite more
// workers (Playwright defaults to ONE worker under CI, which is what serialises a large suite on
// a 4-vCPU runner -- a change in the tenant's own playwright.config.ts), or split the heavy stage
// per site so each site gets its own 35-minute budget.
//
// Hardcoded rather than tenant config on purpose: this is a property of OUR stage budget, not a
// tenant preference. A tenant that could set it would set it wrong -- the failure mode of a large
// value is a dead stage, not a slow one -- and it is a number we intend to tune once, from a
// measurement, and then leave alone.
export const E2E_SUITE_TIMEOUT_MS = 12 * 60 * 1000;

export interface E2eConfig {
  // The tenant's e2e command line, run via `sh -c` in the PR checkout (e.g. `yarn test:e2e`).
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

// How much of a FAILED provisioning command's output rides along. Small on purpose: the suite's
// own report is the finding that matters, and this note only has to name the reason npx gave.
const PROVISION_CAPTURE_LIMIT = 600;

// Best-effort by design. A provisioning failure is NOT turned into a gate failure of its own,
// because the honest verdict belongs to the suite: if the browsers really are missing, the suite
// fails immediately after this with Playwright's own unmistakable "Executable doesn't exist ...
// run playwright install" message, which is a better diagnosis than anything this step could
// invent -- and if the tenant provisions browsers some other way (their e2e script installs them,
// a self-hosted runner bakes them in, the suite drives no browser at all), a repo with no local
// Playwright CLI must not start failing a gate it was passing. So this can only ever ADD a
// working browser; it can never subtract a verdict. The reason is kept and appended to the
// findings when the suite then fails, so a run that failed BECAUSE provisioning failed says so
// instead of leaving the reader to infer it.
async function provisionBrowsers(runCommand: typeof defaultRunCommand, cwd: string): Promise<string | undefined> {
  try {
    const { exitCode, stdout, stderr } = await runCommand('sh', ['-c', E2E_BROWSER_PROVISION_COMMAND], cwd);
    if (exitCode === 0) return undefined;
    const detail = boundedCapture(stderr.trim() || stdout.trim(), PROVISION_CAPTURE_LIMIT);
    return `\`${E2E_BROWSER_PROVISION_COMMAND}\` exited ${exitCode}${detail ? `: ${detail}` : ''}`;
  } catch (err) {
    return `\`${E2E_BROWSER_PROVISION_COMMAND}\` could not run: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function failureFindings(
  run: string,
  exitCode: number,
  stdout: string,
  stderr: string,
  provisionFailure?: string,
): string[] {
  const findings = [`\`${run}\` exited ${exitCode}`];
  // Both streams can carry real diagnostics (the spec report on stdout, a crash or a missing
  // browser binary on stderr), so ship both, as ONE budgeted capture -- stderr last, because a
  // short stderr diagnostic appended at the end lands inside the tail the capture retains, next
  // to the end of the stdout report. boundedCapture keeps the head too, so the first failed
  // spec's assertion diff survives a run in which hundreds of specs failed -- that first block is
  // the diagnosis a fixer needs, and it is the first thing a tail-only capture threw away.
  const detail = boundedCapture([stdout.trim(), stripRunnerNoise(stderr)].filter(Boolean).join('\n'));
  if (detail) findings.push(detail);
  // LAST, so the existing finding shape (`exited N`, then the run's own capture) is unchanged for
  // every run that provisioned cleanly -- which is all of them, once this works.
  if (provisionFailure) findings.push(`browser provisioning also failed first: ${provisionFailure}`);
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

      // Only once we know a suite is actually going to run -- a gate that skips must not spend a
      // browser download on nothing.
      const provisionFailure = await provisionBrowsers(runCommand, ctx.workspaceRoot);
      if (provisionFailure) process.stdout.write(`[e2e] ${provisionFailure}\n`);

      const env: NodeJS.ProcessEnv = { ...process.env, [E2E_BASE_URL_ENV]: config.baseUrl };
      try {
        const { exitCode, stdout, stderr } = await runCommand('sh', ['-c', config.run], ctx.workspaceRoot, {
          env,
          timeoutMs: E2E_SUITE_TIMEOUT_MS,
        });
        if (exitCode === 0) return { id: E2E_GATE_ID, status: 'pass' };
        return {
          id: E2E_GATE_ID,
          status: 'fail',
          findings: failureFindings(config.run, exitCode, stdout, stderr, provisionFailure),
        };
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
