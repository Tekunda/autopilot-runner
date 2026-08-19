// The thin runner's finalize phase runs after the selected vendor Action has produced its
// conclusion. Judgment stages map that conclusion directly to telemetry; coding stages
// additionally confirm the deterministic remote branch and open the PR.
//
// Recomputes the same deterministic branch name action.yml publishes after the agent edits
// the checkout (codingBranchName()) and confirms it directly against VCSHost -- present on
// the remote with commits beyond base -- rather than trusting a vendor output (issue #113).
// Maps the confirmed outcome to an ExecutorResult via CodingExecutor.finalize(), then --
// if a branch resulted -- opens the PR from it deterministically via VCSHost, never the
// model (AGENTS.md, "deterministic control, LLM only for judgment"; issue #70's settled
// execution boundary). Re-verifies the grant itself rather than trusting the prior
// process's word for it: each runner step is a fresh Node process sharing nothing but the
// job's inputs and workspace.

import type { CodingExecutor } from '../contracts/adapters.ts';
import type { VCSHost } from '../contracts/adapters.ts';
import type { ExecutionGrant, StatusTelemetry } from '../contracts/types.ts';
import { verifyGrant, type KeyInput } from '../control-plane/grant-verify.ts';
import { codingBranchName, DEFAULT_BASE_REF, digestFor, grantId, rejectedTelemetry } from './prepare-stage.ts';

export interface FinalizeStageDeps {
  codingExecutor: CodingExecutor;
  vcsHost: VCSHost;
  /** Customer repository's default branch, supplied by the runner workflow. */
  baseRef?: string;
  /** Public key used to verify the grant's signature. */
  verifyKey: KeyInput;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
}

// The vendor Action step's own raw conclusion output, read back by the runner workflow
// and passed straight through -- see action.yml. Carries no branch name: that comes from
// codingBranchName(grant), confirmed against VCSHost below, never from the vendor step.
export interface ActionOutcome {
  conclusion: string;
}

export function finalizeJudgmentStage(
  grant: ExecutionGrant,
  outcome: ActionOutcome,
  deps: Pick<FinalizeStageDeps, 'verifyKey' | 'now'>,
): StatusTelemetry {
  const verification = verifyGrant(grant, deps.verifyKey, deps.now ?? new Date());
  if (!verification.ok) return rejectedTelemetry(grant, verification.reason);

  return {
    grantId: grantId(grant),
    result: outcome.conclusion === 'success' ? 'pass' : 'error',
    checks: [],
    logDigest: digestFor(grant.repoId, grant.ticketId, grant.stage, outcome.conclusion),
  };
}

function prTitleFor(grant: ExecutionGrant): string {
  return `Delivery Autopilot: ${grant.stage}`;
}

function prBodyFor(grant: ExecutionGrant): string {
  return `Opened by Delivery Autopilot for the ${grant.stage} stage.`;
}

export async function finalizeCodingStage(
  grant: ExecutionGrant,
  outcome: ActionOutcome,
  deps: FinalizeStageDeps,
): Promise<StatusTelemetry> {
  const verification = verifyGrant(grant, deps.verifyKey, deps.now ?? new Date());
  if (!verification.ok) {
    return rejectedTelemetry(grant, verification.reason);
  }

  const branchName = codingBranchName(grant);
  const baseRef = deps.baseRef ?? DEFAULT_BASE_REF;
  const [branchSha, baseSha] = await Promise.all([
    deps.vcsHost.getBranchSha(grant.repoId, branchName),
    deps.vcsHost.getBranchSha(grant.repoId, baseRef),
  ]);
  // The branch must exist on the remote *and* differ from base -- a branch created but
  // never committed to (or never pushed at all) is the same valid no-op as no branch.
  const hasChanges = branchSha !== undefined && branchSha !== baseSha;

  const result = await deps.codingExecutor.finalize({
    stage: grant.stage,
    repoId: grant.repoId,
    conclusion: outcome.conclusion,
    branchName: hasChanges ? branchName : undefined,
  });

  let prUrl: string | undefined;
  if (result.branchName) {
    const pr = await deps.vcsHost.openPR(grant.repoId, {
      branch: result.branchName,
      base: baseRef,
      title: prTitleFor(grant),
      body: prBodyFor(grant),
    });
    prUrl = pr.url;
  }

  return {
    grantId: grantId(grant),
    result: result.outcome,
    checks: result.checks,
    ...(prUrl ? { prUrl } : {}),
    logDigest: result.logDigest,
  };
}
