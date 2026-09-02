// v0 adapter interfaces for the Delivery Autopilot engine.
// The engine speaks only through these six seams — implementations
// (adapters) come later. See AGENTS.md for the source of truth.

import type {
  CheckResult,
  CheckRunSnapshot,
  CheckStatus,
  CodingActionInputs,
  CodingActionOutput,
  CodingExecutorInput,
  ExecutionGrant,
  ExecutorResult,
  PRStatus,
  RunLiveness,
  Snippet,
  Stage,
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
  // Comment on a GENUINE escalation -- the ticket has run out of autonomous options and a human
  // has to look now (an architect hold, a repair-loop or fix-loop exhaustion). Backends that can
  // resolve a human owner for the ticket (e.g. the tracker page's reporter) should @-mention them
  // so the notice actually reaches someone, not just the tracker's activity feed. Optional: a
  // backend without a mentionable owner (or a bot reporter) falls back to a plain comment, and a
  // caller without this implemented calls `comment` directly -- every OTHER comment (progress,
  // routine gate/entitlement blocks, coverage notes) stays a plain `comment`, never this.
  escalate?(ticketId: string, body: string): Promise<void>;
  // Stamp a ticket/subtask's pull-request URL onto the tracker as structured data (e.g. Notion's
  // "Pull Request" URL property), so the board surfaces the PR without reading comments. Called
  // idempotently by the reconciler each tick; implementations MUST no-op when the value already
  // matches (avoid edit-churn) and when there's no configured property/resolvable page. Optional:
  // backends without a PR field (or where the host IS the PR, e.g. GitHub issues) don't implement it.
  setPullRequestUrl?(ticketId: string, url: string): Promise<void>;
  // WHO last edited this ticket on the tracker: 'self' when it was THIS integration (our own
  // credential), 'human' when it was anybody else, 'unknown' when the backend could not tell.
  //
  // The reconciler's mirror sweep needs it to answer a question it previously did not ask. When
  // the tracker's status differs from the store's, that shape has two causes with OPPOSITE right
  // answers: our own outbound status write was dropped (network, rate limit, crash), in which case
  // re-pushing the store's status is a silent, correct repair -- or a PERSON moved the ticket on
  // the board, in which case re-pushing it destroys the primary way a human communicates intent to
  // the pipeline, silently. Overwriting the second case is what made a customer drag a ticket to
  // Done and find it back at Blocked minutes later with nothing to explain it.
  //
  // 'unknown' MUST be read as human by callers, never as self -- see the fail-safe note in
  // reconciler.ts. Optional: a backend that cannot expose page authorship simply does not
  // implement it, and the reconciler keeps its pre-existing store-always-wins repair for that
  // backend (a capability gap, deliberately not a behaviour change).
  lastEditedBy?(ticketId: string): Promise<'self' | 'human' | 'unknown'>;
  readReplies(ticketId: string): Promise<TaskReply[]>;
  // Returns the tracker's own id for each subtask page/issue it created or adopted, so the
  // caller can record it durably (SubtaskState.externalId) and re-bind after a restart --
  // see bindSubtaskPages. Returning nothing is allowed and means "no stable id to offer".
  createSubtasks(
    ticketId: string,
    subtasks: { id: string; title: string; body?: string }[],
  ): Promise<{ id: string; externalId: string }[] | void>;
  // Re-establish the control-plane-id -> tracker-page mapping from the caller's durable
  // state. A backend that resolves synthetic subtask ids through an in-memory map built at
  // createSubtasks time loses it on restart, and rebuilding it by guesswork (relation order)
  // mislabels children once a replan has left more than one plan's worth of them behind.
  // Called each drive tick with whatever the store recorded; cheap and idempotent. Optional:
  // backends whose subtask ids are already the tracker's own ids don't need it.
  bindSubtaskPages?(bindings: { id: string; externalId: string }[]): void;
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
  // Remove the hold notice from the ticket once the hold is RESOLVED (the control plane lifts the
  // block on resume), so a stale "answer these" callout doesn't linger -- and so its raw remove/
  // keep text can never be re-read as spec and re-trip the contradiction detector. Best-effort and
  // idempotent (no notice present is a no-op). Optional: paired with writeHoldNotice.
  archiveHoldNotice?(ticketId: string): Promise<void>;
  // Reflect "the ticket's promotion PR merged into the base branch" on the tracker by moving
  // it to the tenant-configured merged status (e.g. a "test" column), instead of leaving it in
  // review. A one-way cosmetic write; no-op when the tenant hasn't configured it. Optional.
  notifyMergedToBase?(ticketId: string): Promise<void>;
  // Retire a subtask's tracker page/issue outright, for a subtask a REPLAN discarded: its
  // scope is gone from the new plan, so leaving the page linked to the parent hands the
  // architect (and a human) a child that no longer describes any work. Recoverable, never a
  // hard delete -- Notion archives to trash. Optional: backends without a delete simply
  // leave the page behind. Reporting, not control flow; a failure never fails the replan.
  deleteSubtask?(ticketId: string): Promise<void>;
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
  // The SAME reading as protectedRules, but with "the read failed" as a VALUE instead of a throw.
  //
  // protectedRules throws on a fault (deliberately -- see the fail-closed test on the ruleset
  // endpoint), and every caller of it in this repo writes `.catch(() => undefined)` and then
  // degrades to some default. That is defensible where the default is itself conservative (require
  // an approval; keep the tenant-configured check names), but it is fatal for a DRIFT detector: the
  // whole question it asks is "is the required check still configured on this branch?", and a
  // thrown read collapsed into `undefined` is indistinguishable from an answered read that found
  // none. One says "I could not look", the other says "the gate is gone" -- and this plane merges
  // with a ruleset BYPASS, so acting on the wrong one either freezes every merge on a transient 500
  // or announces a breach that never happened.
  //
  // So this method never throws and never omits: it resolves EITHER a reading or an explicit
  // `unreadable` carrying why. Optional because it is a capability, not a requirement -- a host
  // that does not implement it makes the drift detector inert, and the detector SAYS it is inert
  // rather than reporting the tenant clean (see control-plane/required-check-drift.ts).
  readBranchRules?(repoId: string, branch: string): Promise<BranchRulesReading>;
  getPR(repoId: string, prNumber: number): Promise<PRStatus>;
  // Merges the PR's base into its head, append-only (GitHub's "Update
  // branch") -- used by the watchdog's keep-merges-live routine to un-stale
  // a PR without rewriting history.
  updateBranch(repoId: string, prNumber: number): Promise<void>;
  // Merge one branch into another WITHOUT a PR, append-only (GitHub's repository merge
  // endpoint). Mind the direction, which reads backwards from the English sentence: `base`
  // is the branch that RECEIVES the merge and is the only one that moves; `head` is what
  // gets merged in and is left exactly where it was. So "fold `test` into `ticket/x`" is
  // mergeBranch(repo, 'ticket/x', 'test').
  //
  // This is the ONLY primitive that can refresh a long-lived branch the pipeline builds on.
  // updateBranch above needs a PR and only ever fires for a PR reporting `behind`, and a
  // subtask PR's base is the TICKET branch -- so nothing it does can bring the BASE branch's
  // new commits into `ticket/*`. A ticket branch sat 161 commits behind `test` for days
  // because of that gap, and the subtask builds and gates taken on it described a tree that no
  // longer existed. One caller (pr-ops.ts, refreshBranchFromBase) now serves BOTH long-lived
  // branches through it: the ticket branch before the subtask build/gate lane, and the
  // integration branch before the assembled review and the promotion PR opened from it. The integration
  // branch had the identical gap -- it merely read 0 behind for as long as it was still empty,
  // which is exactly while the destructive reset could still refresh it.
  //
  // Append-only by construction: it creates a real merge commit and never rewrites history,
  // so it is safe on a SHARED branch that open PRs and live runs are based on -- unlike the
  // delete-and-recreate reset the rebase* helpers use, which can only ever touch a branch
  // that carries nothing of its own.
  //
  // 'merged' = a merge commit was created; 'up-to-date' = base already contained head, so
  // there was nothing to do; 'conflict' = the merge cannot be done automatically and a
  // human or a conflict-fix agent has to resolve it. Anything else (a missing branch, an
  // API fault) THROWS: "the merge could not be attempted" is not "there was nothing to
  // merge", and collapsing the two would let a caller gate against a stale tree.
  mergeBranch(repoId: string, base: string, head: string): Promise<'merged' | 'up-to-date' | 'conflict'>;
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
  // Id-aware: WITHOUT `checkRunId`, a `pending` progress publish and its later pass/fail
  // completion would otherwise create TWO separate check-runs of the same name -- the
  // first left `in_progress` forever, hiding the completion's findings from a human on the
  // PR (the check-run never transitions). Callers that captured the id from an earlier
  // publish of the SAME check-run pass it here so the implementation UPDATES that run
  // instead of creating a new one. Callers that can't (a fresh process, an exception path
  // that never captured one) omit it; the implementation should still try to find and
  // update the latest same-name run on this ref's commit before falling back to creating
  // one, so a stray `pending` left by any path still gets completed. Resolves the id of
  // the check-run that was created or updated, so the caller can capture it for the next
  // publish in this same stage's lifecycle.
  publishCheck(repoId: string, ref: string, check: PublishedCheck, checkRunId?: number): Promise<{ id: number }>;
  // The read half of publishCheck: is check-run `checkRunId` still open, or has it already
  // been completed, and under what name? The ghost-check-run sweep (watchdog.ts) needs to tell
  // a check-run that is GENUINELY in flight from one whose backing run finished without ever
  // concluding it, and it must be able to say which before it claims either in an alarm. The
  // name comes back with it so the completing publish reuses it rather than renaming the run.
  // Optional -- a host without it simply has no ghost sweep.
  // Fail-safe, like RunLiveness: `undefined` means the check-run could not be READ (transport
  // error, 404, rate limit) and must never be taken for 'completed' (which would silently
  // retire a real ghost) nor for 'in_progress' (which would invite concluding a check-run on
  // no evidence). Every other answer is the host's own word.
  checkRunStatus?(repoId: string, checkRunId: number): Promise<CheckRunSnapshot | undefined>;
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
  // The full three-dot comparison of `base` against `head`: commits on head not on the merge
  // base (`aheadBy`) AND commits on base not on it (`behindBy`). `aheadBy` above cannot be used
  // to PROVE anything, because it folds three different answers into the same 0 -- "the refs are
  // equal", "head is behind", and "the comparison could not be made at all" (a deleted branch, a
  // transient API error). This one keeps them apart: `behindBy === 0` is positive proof that
  // `base` is contained in `head`, and `undefined` says the comparison failed and nothing may be
  // concluded from it. Used by the superseded-deploy recovery, where mistaking ignorance for
  // containment would unblock a ticket whose work never shipped.
  // Optional: a host that cannot compare refs simply doesn't implement it, and callers that need
  // proof get none (the safe direction).
  compareRefs?(repoId: string, base: string, head: string): Promise<{ aheadBy: number; behindBy: number } | undefined>;
  // Post a top-level comment on a PR. Used by the autofixer to ACKNOWLEDGE review feedback it
  // addressed -- resolving inline threads covers inline comments, but a top-level PR comment or
  // a review summary with no inline comments has no thread to resolve, so a reply is the only
  // acknowledgement. Best-effort.
  replyToPr(repoId: string, prNumber: number, body: string): Promise<void>;
  // Publish a REVIEW on a PR: a summary body plus per-file inline comments. This is the
  // emitting half of the feedback loop the pipeline already consumes -- listPrFeedback reads
  // other people's reviews and dispatches fixes for them, but Autopilot's own findings had
  // nowhere to go except the tracker and a check summary, so a maintainer never saw them
  // against the code. Comments whose anchor no longer exists in the diff are rejected by the
  // host, so callers should treat a failure as best-effort and keep the summary body
  // authoritative. Optional: a host without PR reviews simply never gets them.
  createReview?(
    repoId: string,
    prNumber: number,
    review: { body: string; comments?: { path: string; line: number; body: string }[] },
  ): Promise<void>;
  // The TAIL of a FAILED CI check's log -- the diagnostic evidence a fixer needs when
  // name/conclusion alone rarely say what broke (Track F red-check self-heal).
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
    checkRef: { name: string; headSha?: string },
    maxLines?: number,
  ): Promise<string | undefined>;
  // Atomically create a replay-claim ref (refs/autopilot-claims/*) pointing at `sha`, using git
  // ref creation as a create-if-not-exists: resolves 'created' when this call made the ref and
  // 'exists' when it was already there. The 'exists' case is the replay signal the runner acts on
  // (src/runner/replay-claim.ts), so the distinction is returned, never thrown -- a 422 "Reference
  // already exists" becomes 'exists', while any OTHER failure (network/5xx/403, an unresolvable
  // sha) throws so the caller can fail-open. Optional: a host without git-refs write (or a
  // read-only install) simply doesn't implement it and the guard is inert (harmless).
  createClaimRef?(repoId: string, ref: string, sha: string): Promise<ClaimRefResult>;
  // Every claim ref in the repo (refs/autopilot-claims/*), full ref names. Read by the control
  // plane's GC sweep to reclaim expired claims. Optional, paired with createClaimRef/deleteClaimRef.
  listClaimRefs?(repoId: string): Promise<string[]>;
  // Delete a claim ref by its full name (refs/autopilot-claims/*). Used by the GC sweep; deleting
  // one already gone is a no-op, never an error. Optional, paired with createClaimRef.
  deleteClaimRef?(repoId: string, ref: string): Promise<void>;
}

// What VCSHost.readBranchRules answers. Two arms, never collapsible into one:
//   - 'read'       -- the host answered. `requiredChecks` is then AUTHORITATIVE, and an empty
//                     array genuinely means the branch requires no status checks at all.
//   - 'unreadable' -- the host did not answer (transport fault, 5xx, rate limit, a credential
//                     without the permission). It says nothing whatsoever about the branch's
//                     rules, so `requiredChecks` is deliberately ABSENT from this arm: there is
//                     no field a caller could accidentally read as an empty set.
export type BranchRulesReading =
  | { outcome: 'read'; requiredChecks: string[]; requiresReview: boolean }
  | { outcome: 'unreadable'; reason: string };

// The result of an atomic claim-ref creation: 'created' when this caller won the ref, 'exists'
// when it was already present (the replay signal). Any hard failure throws instead.
export type ClaimRefResult = 'created' | 'exists';

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
  // The gate was enabled but never evaluated. CheckStatus has no `skip`, so a skip arrives
  // here as `pending` (run-gate-stage toCheckStatus: "a skipped gate was never evaluated, not
  // passed") -- which is the RIGHT internal answer, because a skip must never bank as coverage.
  // But `pending` publishes to a host as a check-run that is still RUNNING, so a skipped gate
  // left one hanging in_progress forever on the PR. This flag lets the adapter CONCLUDE it as
  // skipped without changing the internal status the coverage ledger reads.
  skipped?: boolean;
  // The stage this check reported was SUPERSEDED -- replaced by a newer run, or abandoned
  // when its subtask went terminal -- so its run was cancelled before it could report a
  // verdict. Same shape as `skipped` (it rides in on a `pending` status, because internally
  // there was no verdict), and for the same reason: without it the dispatch-time `pending`
  // check-run stays in_progress forever with nothing running behind it. Distinct from
  // `skipped` because a superseded stage DID start; the host concludes it `cancelled`, never
  // `failure` -- it did not fail on the merits.
  cancelled?: boolean;
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

// Per-call knobs for dispatchStage.
export interface DispatchStageOptions {
  // When THIS generation of the stage started, ISO-8601. A dispatch adopts an already-running
  // run for the same grant only when that run belongs to the same generation, and callers that
  // can name the generation's start (the review round's pinned start, persisted with the round)
  // must pass it: every driver of that round then agrees on the same floor no matter when it
  // ticks, so two overlapping drivers share one run instead of dispatching duplicates, while a
  // run left over from a DISCARDED earlier generation is still refused. Omit when the
  // generation starts with this call.
  //
  // It bounds adoption from ABOVE too, and ONLY here -- naming a generation is what makes an
  // upper bound meaningful. A run whose name carries no token and was created more than
  // TOKENLESS_ADOPTION_WINDOW_MS after this generation started belongs to a LATER one (the
  // overlapping-revision hazard) and is refused however exactly its run-name matches; a run
  // that names this generation's token gets the generous stage-timeout bound instead.
  adoptSince?: string;
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
  dispatchStage?(grant: ExecutionGrant, options?: DispatchStageOptions): Promise<StageHandle>;
  // Non-blocking probe: one check of a previously-dispatched run. Returns a terminal
  // StageResult once the run completes, `outcome:'running'` while it is still in flight
  // (within the stage timeout), or `outcome:'error'` once the timeout (anchored on the run's
  // created_at, carried in `inFlight`) has passed without completion -- so a hung run escalates.
  checkStage?(grant: ExecutionGrant, inFlight: InFlightStage): Promise<StageResult>;
  // Stop a dispatched run the control plane has decided to ABANDON -- the branch it was
  // judging moved, or a replan discarded the plan it belonged to. Without this the run keeps
  // going to completion: it holds one of the tenant's concurrent AI runs, spends the model
  // budget on a revision nobody will act on, and reports a verdict for a tree that no longer
  // exists, which is how a manual push mid-review ends up with two rounds racing. Optional
  // and best-effort -- a runner that cannot cancel simply lets the run finish, today's
  // behaviour. Never throws: abandoning is already the recovery path.
  // Resolves TRUE only when the host accepted the cancellation. A marker that was never
  // correlated to a run id has nothing to cancel and resolves false -- the caller can then
  // fall back to cancelStagesFor, which does not need one.
  cancelStage?(repoId: string, inFlight: InFlightStage): Promise<boolean>;
  // Cancel every in-flight run of `stage` belonging to `shortId`, matched on the run NAME
  // rather than a recorded run id. A round discarded seconds after dispatch has markers whose
  // run ids were never correlated, so id-based cancellation silently does nothing there --
  // which is exactly when a superseded round is most likely to still be running. Optional.
  cancelStagesFor?(repoId: string, opts: { stage: Stage; shortId: string }): Promise<number>;
  // Read one dispatched run's liveness WITHOUT issuing a grant: has it finished, and what did
  // it conclude (see RunLiveness). checkStage answers a much richer question -- it downloads the
  // verdict artifact and maps it to a StageResult -- and needs a signed grant for the stage,
  // because it is part of DRIVING one. Concluding a check-run the run already settled is
  // RECONCILIATION of a fact that happened on the host, so it must not have to mint a grant (or
  // pass a drive gate) to ask. Optional and fail-safe: resolves undefined when the outcome
  // cannot be determined, which callers must treat as "unknown", never as still-running and
  // never as a pass. A runner without it simply has no ghost sweep.
  runLiveness?(repoId: string, runId: number): Promise<RunLiveness | undefined>;
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

// Optional structured correlation fields a caller may attach to a notify() call so
// operators can filter logs by ticket/stage/run/tenant instead of grepping prose.
// Observability only -- implementations render these when present and are otherwise
// unchanged; nothing in the engine requires them.
export interface NotifyFields {
  ticketId?: string;
  stage?: Stage;
  runId?: number;
  tenantId?: string;
  gateIds?: string[];
}

export interface Notifier {
  notify(event: string, plainText: string, fields?: NotifyFields): Promise<void>;
}
