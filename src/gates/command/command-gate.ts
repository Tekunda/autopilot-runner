// H3 command gate (docs/ci-gate-refit-plan.md): a tenant-declared shell command
// (e.g. `yarn lint`, `yarn build`, `yarn seo:check`) run against the customer PR
// checkout (ctx.workspaceRoot). Exit 0 -> pass, non-zero -> fail with a bounded
// tail of the command's output as findings. This replaces the GitHub Actions the
// customer will not re-enable. A `blocking:false` gate that fails reports `warn`
// (report-only) instead of failing the grant -- see GateStatus in ../types.ts.

import { runCommand } from '../exec.ts';
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
}

// Cap on how much of a failed command's output rides back as findings -- only
// telemetry crosses the split plane, and a multi-MB build log is neither useful
// nor safe to ship whole.
const TAIL_LIMIT = 4000;

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > TAIL_LIMIT ? `...${trimmed.slice(trimmed.length - TAIL_LIMIT)}` : trimmed;
}

function failureFindings(run: string, exitCode: number, stdout: string, stderr: string): string[] {
  const findings = [`\`${run}\` exited ${exitCode}`];
  // stderr is where the actionable failure usually is; fall back to stdout.
  const detail = tail(stderr) || tail(stdout);
  if (detail) findings.push(detail);
  return findings;
}

export function createCommandGate(spec: CommandGateSpec, cwd?: string): Gate {
  const blocking = spec.blocking !== false;
  const failStatus = blocking ? 'fail' : 'warn';
  return {
    id: spec.name,
    async run(ctx: GateContext): Promise<GateResult> {
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
