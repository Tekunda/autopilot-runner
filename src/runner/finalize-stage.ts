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
import { GrantLedger } from '../control-plane/grant-ledger.ts';
import { verifyGrant, type KeyInput } from '../control-plane/grant-verify.ts';
import { codingBranchName, DEFAULT_BASE_REF, digestFor, grantId, rejectedTelemetry } from './prepare-stage.ts';

export interface FinalizeStageDeps {
  codingExecutor: CodingExecutor;
  vcsHost: VCSHost;
  /** Customer repository's default branch, supplied by the runner workflow. */
  baseRef?: string;
  /** Public key used to verify the grant's signature. */
  verifyKey: KeyInput;
  /**
   * Consume ledger for replay detection (Track G): once a grant verifies, its
   * consumption is recorded here, so finalizing the SAME issued grant again in this
   * process is flagged loudly (ledger log + counter) instead of silently re-reported.
   * Optional only so direct tests can skip it -- action-entry always supplies one.
   */
  grantLedger?: GrantLedger;
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
  deps: Pick<FinalizeStageDeps, 'verifyKey' | 'now' | 'grantLedger'>,
): StatusTelemetry {
  const verification = verifyGrant(grant, deps.verifyKey, deps.now ?? new Date());
  if (!verification.ok) return rejectedTelemetry(grant, verification.reason);
  deps.grantLedger?.markConsumed(grant, `${grant.stage}:${grant.ticketId}`);

  return {
    grantId: grantId(grant),
    result: outcome.conclusion === 'success' ? 'pass' : 'error',
    checks: [],
    logDigest: digestFor(grant.repoId, grant.ticketId, grant.stage, outcome.conclusion),
  };
}

function prTitleFor(grant: ExecutionGrant): string {
  return grant.ticketTitle
    ? `${grant.ticketTitle} (${grant.stage})`
    : `Delivery Autopilot: ${grant.stage}`;
}

function prBodyFor(grant: ExecutionGrant): string {
  const heading = grant.ticketTitle ? `**${grant.ticketTitle}**\n\n` : '';
  return `${heading}Opened by Delivery Autopilot for the ${grant.stage} stage (ticket \`${grant.ticketId}\`).`;
}

// Backoffs between PR-open attempts. The branch was just force-pushed with one token, but
// openPR runs on a DIFFERENT token (the tenant VCS token, not the checkout token), and
// GitHub's cross-token ref visibility is only eventually consistent -- for a second or two
// after the push the PR-open token 404s the head/base ref. A single attempt then fails and
// the control plane re-runs the entire ~12-minute agent build just to re-open the PR. So
// retry openPR here first (the work is already pushed; opening the PR is cheap + idempotent).
const PR_OPEN_BACKOFFS_MS = [400, 800, 1600, 3200];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Open the build PR, tolerating the brief post-push window where the PR-open token can't see
// the new ref yet. Retries with backoff; on every failure re-checks for a PR a sibling raced
// to open (idempotent -- one subtask's deterministic branch has at most one PR). Returns the
// PR url, or undefined once all attempts are spent -- the caller turns that into an `error`
// outcome (branch confirmed, no PR) so a genuinely-missing base still falls through to the
// control plane's re-ensure-and-retry path rather than being masked forever.
async function openPrWithRetry(
  vcsHost: VCSHost,
  grant: ExecutionGrant,
  branch: string,
  base: string,
): Promise<string | undefined> {
  for (let attempt = 0; attempt <= PR_OPEN_BACKOFFS_MS.length; attempt++) {
    try {
      const pr = await vcsHost.openPR(grant.repoId, { branch, base, title: prTitleFor(grant), body: prBodyFor(grant) });
      return pr.url;
    } catch {
      const raced = await vcsHost.findOpenPR(grant.repoId, branch).catch(() => undefined);
      if (raced) return raced.url;
      const backoff = PR_OPEN_BACKOFFS_MS[attempt];
      if (backoff === undefined) return undefined; // attempts spent -- let the caller surface `error`
      await sleep(backoff);
    }
  }
  return undefined;
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
  // Replay guard (Track G): record this grant's consumption before reporting the
  // result -- a second finalize of the same issued grant now announces itself via
  // the ledger instead of producing a second indistinguishable telemetry.
  deps.grantLedger?.markConsumed(grant, `${grant.stage}:${grant.ticketId}`);

  const branchName = codingBranchName(grant);

  // A `fix` stage updates the PR under test in place: the vendor step pushed
  // its self-heal onto that PR's existing head branch (codingBranchName returns
  // it for a fix grant), so there is no fresh branch to confirm against base
  // and no new PR to open -- the fix loop re-gates the same PR. Only a `build`
  // stage produces a new branch + PR.
  if (grant.stage === 'fix') {
    const result = await deps.codingExecutor.finalize({
      stage: grant.stage,
      repoId: grant.repoId,
      conclusion: outcome.conclusion,
      branchName,
    });
    return {
      grantId: grantId(grant),
      result: result.outcome,
      checks: result.checks,
      logDigest: result.logDigest,
    };
  }

  // Mirror prepare-stage: the grant's server-set baseBranch (ticket integration
  // branch) wins, so the subtask PR opens against it -- never the live default.
  const baseRef = grant.baseBranch ?? deps.baseRef ?? DEFAULT_BASE_REF;
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
    // A rebuild of the same subtask pushes to the same deterministic branch
    // (codingBranchName is keyed on the subtask, not the grant), so an open PR for
    // that branch already represents this work: reuse it rather than opening a second
    // build PR for one subtask. GitHub would reject the duplicate anyway; the live
    // trace accumulated duplicates because each attempt used a fresh branch.
    const existing = await deps.vcsHost.findOpenPR(grant.repoId, result.branchName);
    if (existing) {
      prUrl = existing.url;
    } else {
      // openPR can fail transiently -- the post-push cross-token ref-visibility race (see
      // openPrWithRetry), a sibling racing the same branch, or the integration base branch
      // momentarily missing. The build's work is ALREADY pushed to result.branchName, so this
      // must NOT crash finalize and orphan it: retry the open with backoff, and only once the
      // attempts are spent surface the confirmed branch with NO prUrl and an `error` outcome so
      // the control plane re-ensures the base branch and retries next tick -- never a hollow
      // "no-op done" that discards a real build. See finalize/#113 + control-plane.ts hardening.
      prUrl = await openPrWithRetry(deps.vcsHost, grant, result.branchName, baseRef);
      if (!prUrl) {
        return {
          grantId: grantId(grant),
          result: 'error',
          checks: result.checks,
          logDigest: digestFor(grant.repoId, grant.ticketId, grant.stage, 'pr-open-failed'),
        };
      }
    }
  }

  return {
    grantId: grantId(grant),
    result: result.outcome,
    checks: result.checks,
    ...(prUrl ? { prUrl } : {}),
    logDigest: result.logDigest,
  };
}
