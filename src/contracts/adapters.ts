// v0 adapter interfaces for the Delivery Autopilot engine.
// The engine speaks only through these six seams — implementations
// (adapters) come later. See AGENTS.md for the source of truth.

import type {
  CheckResult,
  CheckStatus,
  CodingActionInputs,
  CodingActionOutput,
  CodingExecutorInput,
  ExecutionGrant,
  ExecutorResult,
  PRStatus,
  Snippet,
  InFlightStage,
  ArchitectReview,
  StageResult,
  TicketState,
  TicketStatus,
} from './types.ts';

// One tracker comment/reply. `id` is the tracker's own stable comment id (used to
// dedup handled replies across restarts -- see CommentCursorStore); `author` is the
// tracker's author identifier (login/accountId/user id, '' when the tracker doesn't
// expose it); `isBot` is true when the author is a bot/integration (the pipeline's own
// comments or another bot), so the conversation loop can skip them.
export interface TaskReply {
  id: string;
  author: string;
  isBot: boolean;
  body: string;
}

export interface TaskBackend {
  listReady(): Promise<TicketState[]>;
  get(ticketId: string): Promise<TicketState>;
  setStatus(ticketId: string, status: TicketStatus): Promise<void>;
  comment(ticketId: string, body: string): Promise<void>;
  readReplies(ticketId: string): Promise<TaskReply[]>;
  createSubtasks(ticketId: string, subtasks: { id: string; title: string; body?: string }[]): Promise<void>;
  linkBlockedBy(ticketId: string, blockingTicketId: string): Promise<void>;
  // Idempotently RE-assert a blocked-by dependency, safe to call every drive tick. Optional and
  // implemented ONLY by backends whose blocked-by write is idempotent + needs deferral -- Notion,
  // whose relation to a just-created sibling page can't be written until Notion indexes it (which
  // takes minutes; see the notion adapter). The control plane calls this each tick to land the
  // relation once the page is indexed. Backends whose linkBlockedBy is a plain comment/issue-link
  // (github/jira) do NOT implement it -- their one-shot linkBlockedBy at decompose is enough and
  // re-calling it would spam. Resolves to true when the relation is present after the call
  // (written now or already there), false when it couldn't be asserted yet (e.g. Notion hasn't
  // indexed the sibling page -- the next tick's reconcile retries). Never throws.
  reassertBlockedBy?(ticketId: string, blockingTicketId: string): Promise<boolean>;
  // The ticket-level blocked-by dependency, as recorded on the tracker (the page's
  // "Blocked by" relation): the ticket/page ids blocking this one. Read by the control
  // plane's dependency-wake (a blocked ticket whose blockers have ALL shipped gets held
  // for a replan/continue decision). Optional:
  //  - undefined  => this backend can't expose ticket-level dependencies (feature off);
  //  - []         => no blockers recorded;
  //  - ids        => the blocking ticket ids (store keys, so the caller can look each up).
  // Only relations recorded in the backend's own blocked-by property are visible -- a
  // human linking pages via an unrelated property is invisible here.
  listBlockers?(ticketId: string): Promise<string[] | undefined>;
  // Render the architect's plan onto the PARENT ticket for a human: a PO-facing "For review"
  // block, the engineer plan narrative, touched areas, and (best-effort) assign the reporter
  // as reviewer. Optional -- backends that can't render rich bodies simply don't implement it.
  // Reporting, not control flow: a failure never fails the decomposition.
  writeArchitectReview?(ticketId: string, review: ArchitectReview): Promise<void>;
  // Record an architect HOLD on the ticket for a human: surface the open questions prominently
  // (e.g. at the top of the page body) so the PO sees why it's blocked. The control plane sets
  // the blocked STATUS separately -- that status is the only thing gating re-planning, so
  // clearing the hold is just: answer + move the ticket back to the ready status. Optional.
  // Returns whether the questions were actually rendered on the ticket, so the caller can fall
  // back to putting them in a comment (the durable, backend-agnostic surface) when it couldn't.
  writeHoldNotice?(ticketId: string, holdText: string): Promise<boolean>;
  // Reflect "the ticket's promotion PR merged into the base branch" on the tracker by moving
  // it to the tenant-configured merged status (e.g. a "test" column), instead of leaving it in
  // review. A one-way cosmetic write; no-op when the tenant hasn't configured it. Optional.
  notifyMergedToBase?(ticketId: string): Promise<void>;
}

export interface VCSHost {
  createBranch(repoId: string, name: string, fromRef: string): Promise<void>;
  openPR(
    repoId: string,
    params: { branch: string; base: string; title: string; body: string },
  ): Promise<{ url: string; number: number }>;
  merge(repoId: string, prNumber: number): Promise<void>;
  setLabel(repoId: string, target: number, label: string): Promise<void>;
  listChecks(repoId: string, ref: string): Promise<CheckResult[]>;
  reviewDecision(repoId: string, prNumber: number): Promise<'approved' | 'changes_requested' | 'pending'>;
  protectedRules(repoId: string, branch: string): Promise<{ requiredChecks: string[]; requiresReview: boolean }>;
  getPR(repoId: string, prNumber: number): Promise<PRStatus>;
  // Merges the PR's base into its head, append-only (GitHub's "Update
  // branch") -- used by the watchdog's keep-merges-live routine to un-stale
  // a PR without rewriting history.
  updateBranch(repoId: string, prNumber: number): Promise<void>;
  // The branch's current commit sha on the remote, or undefined if no branch by that
  // name exists there. Used by the runner to confirm a coding stage's deterministic
  // target branch was actually pushed to -- with commits beyond its base -- before
  // opening a PR from it, rather than trusting a vendor coding-agent Action step's own
  // self-reported branch name (src/runner/finalize-stage.ts, issue #113).
  getBranchSha(repoId: string, branch: string): Promise<string | undefined>;
  // The open PR whose head is `headBranch`, if there is one. A rebuild of the same
  // subtask reuses its existing PR instead of opening a second one for the same work
  // (src/runner/finalize-stage.ts) -- the live trace accumulated duplicate build PRs
  // because every build attempt opened a fresh PR from a fresh branch.
  findOpenPR(repoId: string, headBranch: string): Promise<{ url: string; number: number } | undefined>;
  // Every open PR targeting `baseBranch`. Used by the control plane's external-PR QA
  // sweep to find PRs it did not open itself (blog/SEO automations, human test->main
  // promotions) so it can QA them and publish the `qa` check they'd otherwise wait on
  // forever. Includes the head ref and author so the sweep can skip Autopilot's own
  // branches (which the ticket pipeline already gates).
  listOpenPRs(repoId: string, baseBranch: string): Promise<OpenPR[]>;
  // Close an open PR without merging it. Used to retire a superseded/abandoned build
  // PR so a blocked ticket doesn't leave an orphan open forever.
  closePR(repoId: string, prNumber: number): Promise<void>;
  // Delete a branch from the remote. Used to clean up a per-subtask build branch once
  // its work is merged or its subtask is terminally blocked, so stale `autopilot/*`
  // branches don't accumulate in the customer's repo. Deleting a branch that isn't
  // there is a no-op, never an error.
  deleteBranch(repoId: string, branch: string): Promise<void>;
  // Every actionable review + issue comment on a PR, so the control plane can react to
  // corrective feedback (a `changes_requested` review, or a review/PR comment) from a
  // human reviewer or an external review bot (e.g. Codex) and dispatch a fix -- the way
  // the old agent-fix did. Returns reviews and issue comments together, newest-inclusive.
  listPrFeedback(repoId: string, prNumber: number): Promise<PrFeedback[]>;
  // The actor's permission on the repo ('admin' | 'write' | 'read' | 'none'). Used to
  // gate whose PR feedback is allowed to drive a fix -- a write/admin human or a trusted
  // review bot, never a drive-by comment from an unprivileged account.
  collaboratorPermission(repoId: string, login: string): Promise<'admin' | 'write' | 'read' | 'none'>;
  // Publish an Autopilot result as a check on `ref` (a PR head branch or commit sha),
  // so a gate's verdict is visible on the PR itself instead of only in control-plane
  // telemetry. Requires the host app to hold check-write permission; adapters whose
  // credential lacks it should surface the failure to the caller, which treats
  // publishing as best-effort.
  publishCheck(repoId: string, ref: string, check: PublishedCheck): Promise<void>;
  // Re-trigger a FAILED deployment on `ref` (a merge commit sha): re-run the failed jobs of
  // the workflow run(s) that produced the failing deployment check, so a transient deploy
  // failure (registry blip, infra flake) recovers without a human. Returns true if a rerun
  // was actually requested. Best-effort -- the control plane bounds how many times it calls
  // this (deploy.maxRetries) before blocking the ticket.
  rerunDeployment(repoId: string, ref: string): Promise<boolean>;
  // Mark specific inline review-comment threads (by node id) as resolved -- the exact threads
  // whose feedback the autofixer just addressed, so it closes those conversations instead of
  // leaving them dangling for a human to click through (and without touching unrelated open
  // threads). Returns how many threads it resolved. Best-effort; a host that can't resolve
  // threads returns 0. An empty `threadIds` is a no-op.
  resolveReviewThreads(repoId: string, prNumber: number, threadIds: string[]): Promise<number>;
  // How many commits `headBranch` is ahead of `baseBranch` (commits on head not on base).
  // Used by the auto back-merge to open an upstream->downstream sync PR only when there is
  // actually something to merge. 0 when equal/behind or when the comparison can't be made.
  aheadBy(repoId: string, baseBranch: string, headBranch: string): Promise<number>;
  // Post a top-level comment on a PR. Used by the autofixer to ACKNOWLEDGE review feedback it
  // addressed -- resolving inline threads covers inline comments, but a top-level PR comment or
  // a review summary with no inline comments has no thread to resolve, so a reply is the only
  // acknowledgement. Best-effort.
  replyToPr(repoId: string, prNumber: number, body: string): Promise<void>;
  // The TAIL of a FAILED CI check's log -- the diagnostic evidence a fixer needs when
  // name/conclusion/detailsUrl alone rarely say what broke (Track F red-check self-heal).
  // Split-plane contract: log TEXT is diagnostic evidence, not source code and not a diff,
  // and the implementation MUST redact secrets from it (token-shaped strings, credential
  // assignments) before it crosses the boundary. Optional -- hosts that cannot read logs,
  // or whose credential lacks the log-reading permission, simply don't implement it.
  // Resolves undefined whenever the log isn't available (unknown check, expired logs,
  // permission denied) and NEVER throws for absence, so a caller treats "no tail" as
  // exactly today's name/conclusion/URL evidence. `headSha` is the head the check ran on
  // (branch name or commit sha); `maxLines` bounds the tail (default ~150 lines).
  getCheckLogTail?(
    repoId: string,
    checkRef: { name: string; detailsUrl?: string; headSha?: string },
    maxLines?: number,
  ): Promise<string | undefined>;
}

// An open pull request as seen by the external-PR QA sweep: enough to identify it,
// route a QA grant at its head, and decide whether Autopilot itself opened it.
export interface OpenPR {
  number: number;
  url: string;
  /** The PR title, used to name the external-PR pseudo-ticket and its CI runs meaningfully
   *  (so a run reads "... content: daily blog 2026-08-22" not the PR number twice). */
  title: string;
  headRef: string;
  author: string;
  /** "owner/repo" of the head branch's repository. Equals the base repo for a
   *  same-repo PR; differs for a fork. The QA sweep only runs a PR's build when
   *  its head lives in the tenant repo -- a fork head is untrusted code that also
   *  wouldn't resolve in the tenant checkout. Empty if the head repo is gone. */
  headRepo: string;
}

// One piece of PR feedback: a review (possibly requesting changes) or an issue comment.
// `id` is stable and monotonic per source, so the control plane can remember the highest
// it has already acted on and only fix on genuinely new feedback.
export interface PrFeedback {
  id: number;
  kind: 'review' | 'comment';
  author: string;
  authorIsBot: boolean;
  body: string;
  /** A review with state CHANGES_REQUESTED. Comments are never change-requests. */
  requestsChanges: boolean;
  /** A review with state APPROVED -- an approval, never a request to change anything, so it
   *  must not drive a fix even if its body has substance ("looks correct, nice work"). */
  approved: boolean;
  /** The review thread's node id, when this feedback is an inline review-thread comment; absent
   *  for review summaries and top-level PR comments, which have no resolvable thread. */
  threadId?: string;
}

// One Autopilot-authored check on a PR: the gate/stage name, its verdict, and a short
// human-readable summary. Deliberately smaller than any host's native check payload --
// only what every host can represent.
export interface PublishedCheck {
  name: string;
  status: CheckStatus;
  title?: string;
  summary?: string;
  detailsUrl?: string;
}

// The reference to a CI stage that dispatchStage started, persisted (as InFlightStage) so a
// later tick can re-correlate the same run via checkStage without re-dispatching it.
export interface StageHandle {
  runId?: number;
  runCreatedAt?: string;
  dispatchedAt: string;
}

export interface CIRunner {
  // Blocking: dispatch a stage and await its completion. Retained for on-demand callers
  // (e.g. runPack) and as the simple path; the non-blocking drive loop uses dispatch/check.
  runStage(grant: ExecutionGrant): Promise<StageResult>;
  // Non-blocking dispatch: adopt an already-in-flight run with this grant's run-name, or
  // dispatch a new one, and return immediately with a handle. Never awaits the run.
  // Optional during the blocking->non-blocking migration: the real GitHub Actions runner
  // implements it; a caller that wants non-blocking drive uses dispatchStage+checkStage when
  // present and falls back to the blocking runStage otherwise (so existing fakes keep working).
  dispatchStage?(grant: ExecutionGrant): Promise<StageHandle>;
  // Non-blocking probe: one check of a previously-dispatched run. Returns a terminal
  // StageResult once the run completes, `outcome:'running'` while it is still in flight
  // (within the stage timeout), or `outcome:'error'` once the timeout (anchored on the run's
  // created_at, carried in `inFlight`) has passed without completion -- so a hung run escalates.
  checkStage?(grant: ExecutionGrant, inFlight: InFlightStage): Promise<StageResult>;
}

// The pluggable coding-agent seam the thin runner drives for coding stages
// (build, fix), vendor-agnostic like the other adapters (e.g. claude-code, codex,
// opencode, a generic command provider). The actual coding work -- editing,
// committing, producing a branch -- happens in the vendor's own Action step (a
// `uses:` step run separately in the runner workflow), never in this process; this
// seam only translates in (prepare) and out (finalize) of that step, both pure, no
// I/O. Opening the PR from the resulting branch is the runner's own job via
// VCSHost, deterministically -- never this adapter's, and never the model's. Only
// telemetry crosses back -- never source/diff/prompt. See AGENTS.md ("split
// plane", "deterministic control, LLM only for judgment").
export interface CodingExecutor {
  prepare(input: CodingExecutorInput): Promise<CodingActionInputs>;
  finalize(output: CodingActionOutput): Promise<ExecutorResult>;
}

// Read-only source used by the enrich/PO stage.
export interface KnowledgeSource {
  search(query: string): Promise<Snippet[]>;
  fetch(ref: string): Promise<Snippet>;
}

export interface Notifier {
  notify(event: string, plainText: string): Promise<void>;
}
