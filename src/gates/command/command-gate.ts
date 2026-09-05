// H3 command gate (docs/ci-gate-refit-plan.md): a tenant-declared shell command
// (e.g. `yarn lint`, `yarn build`, `yarn seo:check`) run against the customer PR
// checkout (ctx.workspaceRoot). Exit 0 -> pass, non-zero -> fail with a bounded
// head-and-tail capture of the command's output as findings. This replaces the
// GitHub Actions the customer will not re-enable. A `blocking:false` gate that fails reports `warn`
// (report-only) instead of failing the grant -- see GateStatus in ../types.ts.

import { diffTouches } from '../../contracts/changed-paths.ts';
import { runCommand } from '../exec.ts';
import { boundedCapture } from '../output-capture.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

// One tenant-declared command gate. Rides in the signed grant (as a
// `{kind:'command'}` GateSpec) and lives in the tenant's PackConfig.
export interface CommandGateSpec {
  // The gate id AND the check name it reports under.
  name: string;
  // The shell command line, run via `sh -c` in the PR checkout.
  run: string;
  // Whether a failure fails the grant. Defaults to true; false makes it report-only.
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
  const blocking = spec.blocking !== false;
  const failStatus = blocking ? 'fail' : 'warn';
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
        return { id: spec.name, status: failStatus, findings: failureFindings(spec.run, exitCode, stdout, stderr) };
      } catch (err) {
        return {
          id: spec.name,
          status: failStatus,
          findings: [`\`${spec.run}\` could not run: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
    },
  };
}
