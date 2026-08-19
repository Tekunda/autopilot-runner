// The thin runner's finalize phase: runs after the coding-stage vendor Action step (a
// `uses:` step, e.g. anthropics/claude-code-action, run separately in the runner workflow
// -- see action.yml) has produced its own raw conclusion output. Only reachable for grants
// prepareStage() (./prepare-stage.ts) returned `kind: 'coding'` for.
//
// Recomputes the same deterministic branch name prepareStage() told the agent to push to
// (codingBranchName()) and confirms it directly against VCSHost -- present on the remote
// with commits beyond base -- rather than trusting the vendor Action step to self-report
// one: claude-code-action leaves its own `branch_name` output unset outside its
// entity-triggered auto-branch mode, which a `workflow_dispatch` run never is (issue #113).
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
import { codingBranchName, DEFAULT_BASE_REF, grantId, rejectedTelemetry } from './prepare-stage.ts';

export interface FinalizeStageDeps {
  codingExecutor: CodingExecutor;
  vcsHost: VCSHost;
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
  const [branchSha, baseSha] = await Promise.all([
    deps.vcsHost.getBranchSha(grant.repoId, branchName),
    deps.vcsHost.getBranchSha(grant.repoId, DEFAULT_BASE_REF),
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
      base: DEFAULT_BASE_REF,
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
