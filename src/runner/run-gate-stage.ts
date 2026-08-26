// The thin runner's `gate` stage (issues #106, #129): verifies the signed grant, builds a
// GateContext runner-side (no control-plane assumption -- gates run runner-side now, see
// gates/types.ts), and runs exactly the gates named by the grant's signed `gateSpecs` -- a
// gate absent there never runs. Only deterministic `{kind:'generic'}` specs run today, via
// the runner's own bundled GateRegistry (./gate-registry.ts, commodity gates only); prompt
// gates are disabled under the current stopgap, so a `{kind:'prompt'}` spec (should one
// appear) is ignored. Which specs land in the grant at all is decided entirely server-side
// by issueGateGrant (control-plane/grant.ts) from the tenant's entitlement. Resolves
// entirely within this one call, the same way judgment-only stages resolve within
// prepareStage() -- there is no vendor coding-agent Action step and no finalize phase for a
// gate stage.

import type { VCSHost } from '../contracts/adapters.ts';
import type { CheckResult, CheckStatus, ExecutionGrant, GateSpec, StatusTelemetry } from '../contracts/types.ts';
import { verifyGrant, type KeyInput } from '../control-plane/grant-verify.ts';
import type { GateRegistry } from '../gates/registry.ts';
import type { GateContext, GateResult } from '../gates/types.ts';
import { digestFor, grantId, rejectedTelemetry } from './prepare-stage.ts';

// Runner-side PR targeting for the gate run: which PR/diff to run the
// entitled gates against. Unlike `gateSpecs`, this is routing data, not
// authorization, so it never needs to be signed -- same as the CIRunner
// dispatch target not being part of the grant either. It IS bound to the
// grant at the one point where the grant makes a checkable claim about it:
// `prNumber` must match the PR the signed `ref` names (see grantPRNumber).
// `branch`/`baseRef`/`changedFiles` stay unbound -- the grant asserts nothing
// about them, and mismatching them needs Actions-write on the customer's own
// repo, which already outranks anything a gate report can do.
export interface GateTarget {
  prNumber: number;
  branch: string;
  baseRef: string;
  changedFiles: string[];
  config?: Record<string, unknown>;
}

export interface RunGateStageDeps {
  vcsHost: VCSHost;
  registry: GateRegistry;
  target: GateTarget;
  /** Public key used to verify the grant's signature. */
  verifyKey: KeyInput;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
}

// GateStatus has a `skip` a CheckStatus has no room for; the closest honest
// mapping is `pending` -- a skipped gate was never evaluated, not passed.
function toCheckStatus(status: GateResult['status']): CheckStatus {
  if (status === 'fail') return 'fail';
  if (status === 'skip') return 'pending';
  return 'pass';
}

function toChecks(results: GateResult[]): CheckResult[] {
  return results.map((result) => ({
    name: result.id,
    status: toCheckStatus(result.status),
    ...(result.findings?.length ? { findings: result.findings } : {}),
    ...(result.detailsUrl ? { detailsUrl: result.detailsUrl } : {}),
  }));
}

function isGenericSpec(spec: GateSpec): spec is Extract<GateSpec, { kind: 'generic' }> {
  return spec.kind === 'generic';
}

// A gate grant's signed `ref` IS the PR under gate (control-plane/subtask-pipeline.ts issues
// `ref: prUrl`, and the dispatcher derives the whole GateTarget from it -- adapters/
// github-actions/ci-runner.ts gateTarget). So the unsigned `gate-target` workflow input has
// exactly one claim on the grant to answer to: point at the same PR. Refuse otherwise, rather
// than gate one PR's diff and report the verdict against another's grant. Deliberately narrow:
// the pattern is the same `/pull/<n>` shape the control plane parses, and a grant whose ref
// names no PR makes no claim to check.
// (Rejecting here, not in verifyGrant: the target is runner-side input the signature never
// covers -- this is the seam where the two meet.)
function grantPRNumber(grant: ExecutionGrant): number | undefined {
  const match = grant.ref ? /\/pull\/(\d+)/.exec(grant.ref) : null;
  return match ? Number(match[1]) : undefined;
}

// Verify the grant, run exactly the gates named by its signed `gateSpecs`, and report the
// resulting checks as StatusTelemetry -- only results/checks cross back, never source or
// diffs (AGENTS.md, "split plane").
export async function runGateStage(grant: ExecutionGrant, deps: RunGateStageDeps): Promise<StatusTelemetry> {
  const verification = verifyGrant(grant, deps.verifyKey, deps.now ?? new Date());
  if (!verification.ok) {
    return rejectedTelemetry(grant, verification.reason);
  }
  if (grant.stage !== 'gate') {
    return rejectedTelemetry(grant, `runGateStage called with a "${grant.stage}" grant, expected "gate"`);
  }

  const claimedPR = grantPRNumber(grant);
  if (claimedPR !== undefined && claimedPR !== deps.target.prNumber) {
    return rejectedTelemetry(
      grant,
      `gate target PR #${deps.target.prNumber} does not match the grant's PR #${claimedPR}`,
    );
  }

  const specs = grant.gateSpecs ?? [];
  const genericSpecs = specs.filter(isGenericSpec);

  // A generic spec's signed `config` is authorization-adjacent policy (severity thresholds,
  // forbidden-path lists, ...) -- it overrides the runner-supplied, unsigned
  // GateTarget.config for that same gate id, never the other way around.
  const config: Record<string, unknown> = { ...(deps.target.config ?? {}) };
  for (const spec of genericSpecs) {
    if (spec.config !== undefined) config[spec.id] = spec.config;
  }

  const ctx: GateContext = {
    repoId: grant.repoId,
    prNumber: deps.target.prNumber,
    branch: deps.target.branch,
    baseRef: deps.target.baseRef,
    changedFiles: deps.target.changedFiles,
    vcsHost: deps.vcsHost,
    config,
  };

  const genericReport = await deps.registry.run(
    genericSpecs.map((spec) => spec.id),
    ctx,
  );

  const results = genericReport.results;
  const ok = results.every((result) => result.status !== 'fail');

  // Make the run's log self-describing: a legitimate gate failure must be legible in
  // Actions logs, not byte-identical to a crash (the 75-file diff that failed `risk`
  // for an hour with nothing in the log saying why).
  for (const result of results) {
    process.stdout.write(`[gate] ${result.id}: ${result.status}\n`);
    for (const finding of result.findings ?? []) {
      process.stdout.write(`  ${finding}\n`);
    }
  }

  return {
    grantId: grantId(grant),
    result: ok ? 'pass' : 'fail',
    checks: toChecks(results),
    logDigest: digestFor(grant.repoId, grant.ticketId, grant.stage, String(specs.length)),
  };
}
