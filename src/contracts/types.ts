// v0 domain types for the Delivery Autopilot engine.
// Pure data shapes — no behavior. See AGENTS.md for the source of truth.

export type Stage = 'enrich' | 'plan' | 'architect' | 'build' | 'review' | 'fix' | 'gate';

export type ModelTier = 'fast' | 'standard' | 'deep';

export type StageOutcome = 'pass' | 'fail' | 'error';

export type CheckStatus = 'pass' | 'fail' | 'pending';

export type TicketStatus =
  | 'new'
  | 'refining'
  | 'enriching'
  | 'planning'
  | 'building'
  | 'reviewing'
  | 'fixing'
  | 'blocked'
  | 'done';

export interface GatePolicy {
  requireHumanApproval: boolean;
  requiredChecks: string[];
}

// A `gate` stage's entitled gates, delivered JIT inside the signed grant so the runner
// never holds gate/pack logic of its own (AGENTS.md "split plane", issue #129):
//   - `generic` names one of the runner's own bundled, commodity gates (src/gates/generic/*
//     -- npm-audit thresholds, forbidden-path predicates; no licensed IP), optionally
//     narrowed by signed `config` (severity thresholds, path lists, ...) that -- being part
//     of the signed payload -- overrides anything the unsigned runner-side GateTarget.config
//     tries to set for that same gate id.
//   - `prompt` carried a licensed pack gate's full JIT instruction. Prompt gates are
//     disabled under the current stopgap (only deterministic generic gates run), so this
//     variant has no producer today; it is retained for the signed-payload shape.
export type GateSpec =
  | { kind: 'generic'; id: string; config?: Record<string, unknown> }
  | { kind: 'prompt'; id: string; prompt: string };

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detailsUrl?: string;
}

// Exactly one of stepPrompt (an inline instruction) or ref (a pointer to a
// stored prompt/spec) is present per grant, matching the `stepPrompt|ref`
// shape in AGENTS.md.
export type ExecutionGrant = {
  tenantId: string;
  repoId: string;
  ticketId: string;
  stage: Stage;
  modelTier: ModelTier;
  gatePolicy: GatePolicy;
  expiresAt: string; // ISO 8601
  sig: string;
  // The branch a coding stage (build/fix) must base its work on and open its PR
  // against -- set server-side to the ticket's integration branch so subtask
  // work never targets the customer's live default branch directly. The only
  // merge onto the protected base is the human-gated promotion (promote.ts).
  // Absent -> the runner falls back to the repo's default branch. Part of the
  // signed payload like every other field, so a tampered base fails verifyGrant.
  baseBranch?: string;
  // The ticket's human-readable title, carried so the runner can name branches
  // and PRs after it (a slug of this + a short id) instead of an opaque ticket
  // UUID. Metadata only (already present in the stepPrompt); never a secret.
  ticketTitle?: string;
  // The licensed pack this grant authorizes, when the grant is for a pack
  // invocation rather than a plain stage. Part of the signed payload, so a
  // hand-forged/tampered pack field fails verifyGrant like any other field.
  pack?: string;
  // The entitled gates this grant authorizes, for a `gate` stage -- resolved
  // server-side from the tenant's entitlement/packs (never from
  // tenant-editable config), so the runner runs exactly what's paid for and
  // nothing else. Part of the signed payload like every other field: a
  // tampered/added spec fails verifyGrant, and a gate id absent here never
  // runs even if it's registered runner-side. See AGENTS.md and issues #106, #129.
  gateSpecs?: GateSpec[];
} & ({ stepPrompt: string; ref?: never } | { ref: string; stepPrompt?: never });

// One planned subtask produced by the architect stage: the title that becomes its
// tracker entry, the architect note written back to that entry, the file paths/globs
// it owns (coverage, so nothing is silently dropped and work stays file-disjoint), and
// its 0-based dependencies on other subtasks in the same plan (advisory ordering). This
// is metadata only -- titles, prose, path globs -- never source, diff, or secret, so it
// respects the split-plane boundary that only telemetry crosses back.
export interface PlannedSubtask {
  title: string;
  plan?: string;
  coverage?: string[];
  blockedBy?: number[];
}

export interface StageResult {
  outcome: StageOutcome;
  checks: CheckResult[];
  prUrl?: string;
  logDigest: string;
  // Only an `architect` stage populates this: the ordered subtask plan it produced,
  // downloaded by the CIRunner from the run's `plan.json` artifact and persisted
  // deterministically by the control plane (createSubtasks + linkBlockedBy). Absent for
  // every other stage.
  subtasks?: PlannedSubtask[];
}

export interface StatusTelemetry {
  grantId: string;
  result: StageOutcome;
  checks: CheckResult[];
  prUrl?: string;
  logDigest: string;
}

// Input to CodingExecutor.prepare(): the stage's prompt and target, before the
// vendor's own coding-agent Action step (e.g. claude-code-action, run as a `uses:`
// step in the runner workflow -- see AGENTS.md, "split plane") has done any work.
// `prompt` is the same stepPrompt/ref the grant carries -- see CodingExecutor in
// contracts/adapters.ts.
export interface CodingExecutorInput {
  stage: Stage;
  prompt: string;
  repoId: string;
  baseRef: string;
  // The deterministic branch (src/runner/prepare-stage.ts's codingBranchName()) the
  // vendor Action step must commit and push its work to. Adapters fold this into the
  // translated prompt/inputs however their vendor tool expects -- there is no generic
  // "target branch" field most coding-agent Actions accept (issue #113).
  branchName: string;
}

// What prepare() computes for the vendor's own coding-agent Action step's inputs
// (e.g. claude-code-action's `prompt`). Pure translation, no I/O -- the actual
// coding work happens in that step, outside this process.
export interface CodingActionInputs {
  prompt: string;
}

// The vendor Action step's own conclusion, plus the runner's *confirmed* branch --
// fed to CodingExecutor.finalize() once the step is done. `branchName` is never the
// vendor step's own self-reported branch output (unreliable: e.g. claude-code-action
// leaves it unset outside its entity-triggered auto-branch mode); finalizeCodingStage
// (src/runner/finalize-stage.ts) sets it only once it has confirmed, via VCSHost, that
// the deterministic branch it told the agent to use actually landed on the remote with
// commits beyond base (issue #113). An absent branchName is a valid no-op (the model
// made no changes), not a failure.
export interface CodingActionOutput {
  stage: Stage;
  repoId: string;
  conclusion: string;
  branchName?: string;
}

// Only telemetry crosses back out of a CodingExecutor -- never source/diff/prompt,
// same boundary StageResult observes for CIRunner. `branchName` (not a PR url) is
// as far as this adapter goes -- opening the PR from it is the runner's job via
// VCSHost, deterministically, never this adapter's (AGENTS.md, "deterministic
// control, LLM only for judgment").
export interface ExecutorResult {
  outcome: StageOutcome;
  checks: CheckResult[];
  branchName?: string;
  logDigest: string;
}

export interface Snippet {
  ref: string;
  title: string;
  content: string;
  sourceUrl?: string;
}

export interface SubtaskState {
  id: string;
  title?: string;
  // The architect's per-subtask scope, carried from the plan so the build is dispatched
  // for THIS slice only -- `plan` is the "what to change / where / how verified" note and
  // `coverage` the files/globs this subtask owns. Without these a subtask build only knows
  // its title and falls back to "do the whole parent ticket", which makes file-disjoint
  // subtasks collide. Absent when the plan carried none.
  plan?: string;
  coverage?: string[];
  status: TicketStatus;
  prMerged: boolean;
  // The subtask's own build PR and the branch it was built on, recorded so a
  // re-drive can reuse (never duplicate) that PR, clean the branch up on a terminal
  // outcome, and write the PR link back to the tracker. Absent until its build stage
  // has produced one.
  prUrl?: string;
  branch?: string;
  // Consecutive failed build (coding) attempts for this subtask. The pipeline
  // re-drives the build while this is under `fix.maxBuildRetries` before
  // blocking the subtask for a human. Reset once a build produces a PR.
  buildAttempts?: number;
  // Why this subtask was blocked, when it was: an exhausted build/fix loop, a
  // real merge conflict on its PR, or an error that isolated to it (never the
  // whole ticket). Carried so a human sees a concrete reason.
  blockedReason?: string;
}

export interface TicketState {
  tenantId: string;
  repoId: string;
  ticketId: string;
  title?: string;
  description?: string;
  status: TicketStatus;
  subtasks: SubtaskState[];
  prs: string[];
  lastEventAt: string; // ISO 8601
  // Consecutive fail count for the ticket's *current* judgment stage
  // (enrich/plan -- no PR exists yet for a `fix` stage to work against).
  // The orchestrator retries the same stage while this is under the
  // configured cap, then blocks; a stage change (pass or a non-judgment
  // stage) resets it. See orchestrator.ts `advance()` and issue #123.
  judgmentAttempts?: number;
  // Set by the orchestrator when `advance()` blocks a ticket, so a human
  // has a concrete reason without re-deriving it from telemetry.
  blockedReason?: string;
  // The deployment of this ticket's promoted change, once its promotion PR has
  // merged. A ticket is complete when its deployment is observed, not when its PR
  // merges (see deploy-watch.ts): while this is `pending`, the ticket stays in
  // `reviewing` and neither the drive loop nor the reconciler may complete it.
  // `unverified` records that the host never reported a deployment result -- the
  // ticket is finished, but Autopilot did not see the deploy succeed.
  deployment?: {
    /** The promoted branch whose head carries the deployment. */
    ref: string;
    /** When the wait started (ISO 8601). */
    startedAt: string;
    status: 'pending' | 'passed' | 'failed' | 'unverified';
    detail?: string;
  };
  // The last promotion-hold notice emitted for this ticket, so a ticket that sits
  // ready-but-unmergeable (auto-merge disabled, unmet checks, a host merge refusal)
  // is announced once per reason-change rather than on every 60s tick.
  lastNotice?: string;
}

// `mergeable` abstracts the host's merge-readiness signal for the watchdog's
// keep-merges-live routine: 'clean' can be merged now, 'dirty' has a
// conflict, 'behind' needs the base branch merged into it first, and
// 'unknown' covers every other host-specific state (still computing,
// blocked on checks/reviews, draft, ...) that isn't actionable by itself.
// Optional -- adapters that don't surface mergeability simply omit it.
export type PRMergeability = 'clean' | 'dirty' | 'behind' | 'unknown';

export interface PRStatus {
  number: number;
  state: 'open' | 'closed' | 'merged';
  merged: boolean;
  mergeable?: PRMergeability;
  // The PR's head branch name, used to look up the PR's own CI checks
  // (listChecks resolves a branch to its head commit's check-runs) before a
  // merge -- e.g. re-verifying a promotion PR's required checks at merge time.
  // Optional: adapters that don't surface it simply omit it.
  headRef?: string;
}
