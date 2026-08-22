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
  StageResult,
  TicketState,
  TicketStatus,
} from './types.ts';

export interface TaskBackend {
  listReady(): Promise<TicketState[]>;
  get(ticketId: string): Promise<TicketState>;
  setStatus(ticketId: string, status: TicketStatus): Promise<void>;
  comment(ticketId: string, body: string): Promise<void>;
  readReplies(ticketId: string): Promise<string[]>;
  createSubtasks(ticketId: string, subtasks: { id: string; title: string }[]): Promise<void>;
  linkBlockedBy(ticketId: string, blockingTicketId: string): Promise<void>;
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
}

// An open pull request as seen by the external-PR QA sweep: enough to identify it,
// route a QA grant at its head, and decide whether Autopilot itself opened it.
export interface OpenPR {
  number: number;
  url: string;
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

export interface CIRunner {
  runStage(grant: ExecutionGrant): Promise<StageResult>;
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
