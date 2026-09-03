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
import type { CheckResult, ExecutionGrant, FixVerdict, StatusTelemetry } from '../contracts/types.ts';
import { GrantLedger } from '../control-plane/grant-ledger.ts';
import { verifyGrant, type GrantEnvironment, type KeyInput } from '../control-plane/grant-verify.ts';
import { buildFixVerdict } from './fix-verdict.ts';
import { codingBranchName, DEFAULT_BASE_REF, digestFor, grantId, rejectedTelemetry } from './prepare-stage.ts';

export interface FinalizeStageDeps {
  codingExecutor: CodingExecutor;
  vcsHost: VCSHost;
  /** Customer repository's default branch, supplied by the runner workflow. */
  baseRef?: string;
  /** Public key(s) used to verify the grant's signature -- a list during a key rotation. */
  verifyKey: KeyInput | readonly KeyInput[];
  /**
   * The environment this run is executing in (repository slug, tenant), checked against the
   * grant's SIGNED tenantId/repoId. Threaded in as data by action-entry.ts so verification stays
   * a pure function. Absent -> unbound.
   */
  environment?: GrantEnvironment;
  /**
   * Consume ledger for replay detection (Track G): once a grant verifies, its
   * consumption is recorded here, so finalizing the SAME issued grant again in this
   * process is flagged loudly (ledger log + counter) instead of silently re-reported.
   * Optional only so direct tests can skip it -- action-entry always supplies one.
   *
   * DETECTION, NOT REFUSAL, and per-PROCESS: telemetry is reported whether or not the
   * ledger flags a duplicate. A replayed grant arrives in a FRESH Actions job with a
   * FRESH empty ledger, so the case this actually catches is a double finalize inside
   * one process -- not the attacker replay. See the grant-ledger.ts header.
   */
  grantLedger?: GrantLedger;
  /**
   * Where the customer checkout lives, for the `fix` stage's self-verdict (the dispute file and
   * the round's own diff). Defaults to the process cwd; action-entry passes GITHUB_WORKSPACE,
   * because the finalize step runs with working-directory ${{ github.action_path }} -- the
   * downloaded action copy, which is not the customer tree and has no .git.
   */
  workspaceRoot?: string;
  /**
   * The checkout's HEAD as it was BEFORE the vendor agent ran, recorded by action.yml right after
   * the checkout step. It is the only sound base for the fix round's diff: for a fix grant the
   * grant's own baseBranch is the PR head branch the round has just pushed to, so re-resolving it
   * here would return the fix's own commit and every scan would come back empty. Absent -> the
   * scan reports that it could not run, rather than reporting clean.
   */
  preAgentSha?: string;
  /**
   * Seam for the `fix` stage's self-verdict, so tests can supply one without a git checkout.
   * Defaults to buildFixVerdict() over `workspaceRoot`.
   */
  readFixVerdict?: (cwd: string, baseSha: string) => Promise<FixVerdict>;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
}

// Turn a fix round's self-verdict into the checks that carry it, and into the outcome the run
// exits with. Three refusals, all of which used to be impossible to express:
//
//   DISPUTED -- the fixer says the finding is wrong and changed nothing. Deliberately NOT a pass:
//   a disputed finding must reach a human, not merge quietly.
//
//   EVADED -- the round re-encoded the artifact instead of changing it. Another fix round is not
//   the answer to a fixer that already tried to slip past the matcher once.
//
//   UNSCANNABLE -- the diff could not be read, so whether the round evaded is UNKNOWN. Reported,
//   never assumed clean. This is the fail-safe direction and it costs a human escalation on a git
//   fault; reading it as "no evasion" would cost a silent one.
//
// WHAT ROUTES THE ESCALATION, and what does not. The block is driven by the FixVerdict itself --
// isFixRefused(result.fixVerdict), tested directly on the fix stage's result before any budget is
// computed (subtask-pipeline.ts's fix-completion branch, and runFixLoop's loop body). These checks
// do NOT route it. maxFixRoundsFor is only ever fed a GATE stage's checks (fix-loop.ts's
// `current`, subtask-pipeline.ts's gate branch), so a fix stage's checks never reach the fix
// budget at all. The checks exist to CARRY THE REASON into the report a human reads.
//
// `unjudged` is therefore corroborating metadata, not the mechanism: it states that no further fix
// round can resolve this, so nothing that later reasons about these checks mistakes a refusal for
// an ordinary failure. `unjudgedReason: 'content'` pins the half that matters -- explicitly NOT
// 'infra', so a refusal can never be read as a transient fault worth re-running. That distinction
// is the one under active revision elsewhere; this path does not depend on which way it settles,
// and fix-dispute.test.ts pins that independence.
export function fixVerdictChecks(verdict: FixVerdict): CheckResult[] {
  const checks: CheckResult[] = [];
  if (verdict.disputes.length > 0) {
    checks.push({
      name: 'fix-disputed-finding',
      status: 'fail',
      unjudged: true,
      unjudgedReason: 'content',
      findings: verdict.disputes.map((d) => `disputed: ${d.finding}\n  evidence: ${d.evidence}`),
    });
  }
  // Both go on ONE check: a duplicate name in a checks array is read as two verdicts about the
  // same thing downstream, and these are two findings about one scan.
  const evasionFindings = verdict.evasions.map((e) => `${e.kind} in ${e.path}: ${e.detail}`);
  if (verdict.scanError !== undefined) {
    evasionFindings.push(`could not scan this fix for encoding evasion, so it is unverified: ${verdict.scanError}`);
  }
  if (evasionFindings.length > 0) {
    checks.push({ name: 'fix-evasion', status: 'fail', unjudged: true, unjudgedReason: 'content', findings: evasionFindings });
  }
  return checks;
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
  deps: Pick<FinalizeStageDeps, 'verifyKey' | 'environment' | 'now' | 'grantLedger'>,
): StatusTelemetry {
  const verification = verifyGrant(grant, deps.verifyKey, deps.now ?? new Date(), deps.environment);
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
  const verification = verifyGrant(grant, deps.verifyKey, deps.now ?? new Date(), deps.environment);
  if (!verification.ok) {
    return rejectedTelemetry(grant, verification.reason);
  }
  // Replay DETECTION (Track G): record this grant's consumption before reporting the
  // result, so a second finalize of the same issued grant announces itself via the ledger
  // instead of producing a second indistinguishable telemetry. It does not refuse -- the
  // PR-open below runs either way, and this process's ledger cannot see another job's
  // consumption anyway (FinalizeStageDeps.grantLedger).
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
    // What the round says about ITSELF, before anyone re-gates it. Scanned here because this is
    // the only point in the pipeline that can still see both sides of the fix: the checkout holds
    // the fixer's dispute file, and the diff from `preAgentSha` to HEAD is what says whether the
    // round changed the artifact or only its encoding. A re-gate cannot answer either question --
    // a successful evasion is, by construction, a gate that goes quiet.
    const verdict = await (deps.readFixVerdict ?? buildFixVerdict)(
      deps.workspaceRoot ?? process.cwd(),
      deps.preAgentSha ?? '',
    );
    const verdictChecks = fixVerdictChecks(verdict);
    return {
      grantId: grantId(grant),
      // A refused round must not report `pass`. The control plane blocks on the verdict itself
      // (subtask-pipeline), but the run's own conclusion has to agree with it: exitCodeFor turns
      // a non-pass into a failing step, so a runner whose verdict artifact never arrives still
      // shows red rather than a green fix that quietly re-gates.
      result: verdictChecks.length > 0 ? 'fail' : result.outcome,
      checks: [...result.checks, ...verdictChecks],
      logDigest: result.logDigest,
      fixVerdict: verdict,
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
