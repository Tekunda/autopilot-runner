// H3 command gate (docs/ci-gate-refit-plan.md): a tenant-declared shell command
// (e.g. `yarn lint`, `yarn build`, `yarn seo:check`) run against the customer PR
// checkout (ctx.workspaceRoot). Exit 0 -> pass, non-zero -> fail with a bounded
// head-and-tail capture of the command's output as findings. This replaces the
// GitHub Actions the customer will not re-enable. A `blocking:false` gate reports the SAME honest
// `fail`; what its flag decides is whether that failure blocks, and that decision belongs to the
// stage (run-gate-stage's nonBlockingIds), not to the gate. Rewriting the verdict here is how
// `unit-tests: pass -- \`yarn test\` exited 1` shipped a green check over a red suite for days.

import { diffTouches } from '../../contracts/changed-paths.ts';
import { classifyCommandFailure, DEFAULT_MAX_BUFFER, DEFAULT_TIMEOUT_MS, runCommand, type CommandFailureKind } from '../exec.ts';
import { boundedCapture } from '../output-capture.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

// One tenant-declared command gate. Rides in the signed grant (as a
// `{kind:'command'}` GateSpec) and lives in the tenant's PackConfig.
export interface CommandGateSpec {
  // The gate id AND the check name it reports under.
  name: string;
  // The shell command line, run via `sh -c` in the PR checkout.
  run: string;
  // Whether a failure fails the grant. Defaults to true; false makes it report-only. Read by the
  // STAGE (run-gate-stage's nonBlockingIds), never here: this gate always reports what it saw.
  blocking?: boolean;
  // Base branches this gate applies to (used by later phases to scope gates per
  // promotion target); carried through config but not consulted here.
  onBase?: string[];
  // Repo-relative path patterns this command is about. When set and the PR's diff touches NONE
  // of them, the gate SKIPS (`no-matching-files`) instead of running -- so a monorepo tenant can
  // declare `yarn lint:<app>` on `apps/<app>/**` and stop paying for it on a PR that touches
  // only a sibling app. Absent -> unchanged: the command runs on every gated PR.
  //
  // A skip is never a pass: it publishes as `skipped` with its reason, stays out of the coverage
  // record, and keeps `gate_never_fired` reachable for a matcher that never matches. Scoping
  // fails towards RUNNING at every ambiguity -- see contracts/changed-paths.ts.
  paths?: string[];
}

// What a rejected `runCommand` means for THIS gate's verdict, one row per shape ../exec.ts can
// produce. The line is drawn at "did the command look at the diff":
//
//   - it never started -> `unjudged`. Nothing was observed, so the gate reached no verdict, and
//     `blocking:false` may not excuse it: report-only excuses a FINDING, not a gate that never
//     got to look. It routes as `infra` (../types.ts) for the bounded gate-only retry.
//   - it started and then timed out, drowned the output budget, or was killed -> `fail`. It DID
//     look; what it found is that it cannot finish. That is a defect a fix round can plausibly
//     clear (a build that got slow, a suite screaming 10 MB of errors), and calling it `unjudged`
//     would take the whole fix budget away -- isInfraUnjudgedOnly makes maxFixRoundsFor return
//     ZERO -- and would also block a lane an operator deliberately marked non-blocking, because
//     `ok` in run-gate-stage refuses an `unjudged` regardless of nonBlockingIds. Neither is a
//     price the timeout case is worth: on a 10-minute default and a 10 MB buffer, "slow build" is
//     a far larger population than "missing binary".
//   - anything unrecognised -> `unjudged`, because we cannot establish that it started. Every
//     shape that is KNOWN to mean "it ran" is discriminated out above, so what is left really is
//     the fault `infra` plus a human is for.
export const RUN_FAILURE_VERDICT = {
  spawn: 'unjudged',
  unknown: 'unjudged',
  timeout: 'fail',
  'output-overrun': 'fail',
  signal: 'fail',
} satisfies Record<CommandFailureKind, 'fail' | 'unjudged'>;

// The clause each shape contributes to its finding. `\`yarn build\` could not run: Command failed`
// was WRONG for four of the five: a ten-minute timeout did run, at length, and an operator reading
// "could not run" goes hunting for a missing binary. Each row names what actually happened.
//
// Exported for the same reason RUN_FAILURE_VERDICT is: the wording IS the user-facing behaviour
// this table exists for, and `createCommandGate` offers no seam to reach the timeout row through
// (its budget is the 10-minute default), so the only way to assert that row is against the table
// itself. Left unexported, replacing the whole `timeout` entry with the literal `could not run`
// passed the entire suite -- restoring, unasserted, the exact sentence this table replaced.
export const RUN_FAILURE_WORDS = {
  spawn: 'never started, so this gate saw nothing of the diff',
  unknown: 'could not be run, and Autopilot cannot tell whether it ever started',
  timeout:
    `ran for its full ${DEFAULT_TIMEOUT_MS / 60_000}-minute budget without finishing and was killed -- ` +
    'it ran, so this is a command that no longer terminates, not a missing one',
  'output-overrun':
    `ran and wrote more than ${DEFAULT_MAX_BUFFER / (1024 * 1024)} MB to stdout/stderr, overrunning the ` +
    'capture budget, so it was stopped -- it ran, and the flood is what it had to say',
  signal:
    'started and was then killed by a signal it did not ask for, which on a build or a test run is ' +
    'usually the out-of-memory killer',
} satisfies Record<CommandFailureKind, string>;

function runFailureFindings(run: string, kind: CommandFailureKind, err: unknown): string[] {
  const signal = (err as { signal?: unknown } | null)?.signal;
  const named = typeof signal === 'string' && signal !== '' ? ` (${signal})` : '';
  const detail = (err instanceof Error ? err.message : String(err)).trim();
  return [`\`${run}\` ${RUN_FAILURE_WORDS[kind]}${named}: ${detail}`];
}

function failureFindings(run: string, exitCode: number, stdout: string, stderr: string): string[] {
  const findings = [`\`${run}\` exited ${exitCode}`];
  // stderr is where the actionable failure usually is; fall back to stdout. Bounded head-and-tail
  // (output-capture.ts), not a tail: a compiler or linter reports its FIRST error first and its
  // summary last, so a tail-only capture hands the fixer the count of what broke without the one
  // error that explains it.
  const detail = boundedCapture(stderr) || boundedCapture(stdout);
  if (detail) findings.push(detail);
  return findings;
}

export function createCommandGate(spec: CommandGateSpec, cwd?: string): Gate {
  return {
    id: spec.name,
    async run(ctx: GateContext): Promise<GateResult> {
      if (!diffTouches(ctx.changedFiles, spec.paths)) {
        return {
          id: spec.name,
          status: 'skip',
          skipReason: 'no-matching-files',
          findings: [
            `${spec.name} did not run: none of the ${ctx.changedFiles.length} changed file(s) matches ` +
              `[${(spec.paths ?? []).join(', ')}], so \`${spec.run}\` has nothing in this diff to judge. ` +
              'Nothing was asserted about this diff, and nothing was claimed.',
          ],
        };
      }
      const workdir = cwd ?? ctx.workspaceRoot;
      try {
        const { exitCode, stdout, stderr } = await runCommand('sh', ['-c', spec.run], workdir);
        if (exitCode === 0) return { id: spec.name, status: 'pass' };
        return { id: spec.name, status: 'fail', findings: failureFindings(spec.run, exitCode, stdout, stderr) };
      } catch (err) {
        // runCommand rejects on FIVE different faults, not one, and they do not share a verdict --
        // see RUN_FAILURE_VERDICT above for which is which and why.
        const kind = classifyCommandFailure(err);
        const findings = runFailureFindings(spec.run, kind, err);
        if (RUN_FAILURE_VERDICT[kind] === 'fail') return { id: spec.name, status: 'fail', findings };
        return { id: spec.name, status: 'unjudged', unjudgedReason: 'infra', findings };
      }
    },
  };
}
