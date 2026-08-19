// v0 adapter interfaces for the Delivery Autopilot engine.
// The engine speaks only through these six seams — implementations
// (adapters) come later. See AGENTS.md for the source of truth.

import type {
  CheckResult,
  CodingActionInputs,
  CodingActionOutput,
  CodingExecutorInput,
  Completion,
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

export interface AgentModel {
  invoke(stepPrompt: string, context: Record<string, unknown>): Promise<Completion>;
}

// Read-only source used by the enrich/PO stage.
export interface KnowledgeSource {
  search(query: string): Promise<Snippet[]>;
  fetch(ref: string): Promise<Snippet>;
}

export interface Notifier {
  notify(event: string, plainText: string): Promise<void>;
}
