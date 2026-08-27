// v0 domain types for the Delivery Autopilot engine.
// Pure data shapes — no behavior. See AGENTS.md for the source of truth.

export type Stage = 'enrich' | 'plan' | 'architect' | 'build' | 'review' | 'fix' | 'gate' | 'accept';

export type ModelTier = 'fast' | 'standard' | 'deep';

// 'running' is only ever produced by CIRunner.checkStage when a dispatched CI run has not
// completed yet -- it signals "no terminal result this tick, check again next tick". It must
// NEVER reach advance()/StatusTelemetry (those describe a completed stage); every caller
// early-returns on 'running' before advancing a ticket.
export type StageOutcome = 'pass' | 'fail' | 'error' | 'running';

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

// The three independent review lenses (Track E) that judge the ASSEMBLED integration
// branch. Each is its own signed grant and its own model session -- never one prompt
// folding three perspectives (independence is the point; only the deterministic
// aggregation ever sees more than one lens's output).
export type ReviewLens = 'primary' | 'adversarial' | 'security';

export interface GatePolicy {
  requireHumanApproval: boolean;
  requiredChecks: string[];
  // The plan-review gate (PRD gate #2, the website's plan-review pause): when true, a
  // decomposed ticket HOLDS after the architect writes its plan and does not build any
  // subtask until a PO approves the plan (an approval reply on the tracker). Lets a human
  // catch an under-scoped/wrong plan before it wastes builds. Per-tenant: resolved from the
  // tenant's gates config like every other gate field. Optional; defaults to false (no hold).
  requirePlanApproval?: boolean;
  // The replan-confirmation gate: when true, a blocked ticket whose blockers have ALL shipped
  // (dependency-wake) HOLDS for a human replan/continue decision instead of resuming on its
  // own -- the checkpoint for tenants who want a person to judge whether a plan that sat
  // blocked is still valid. Per-tenant: resolved from the tenant's gates config like every
  // other gate field. Optional; defaults to false (the wake resumes the recorded plan).
  requireReplanConfirmation?: boolean;
  // Which of the three independent assembled-branch reviewers (Track E) actually run.
  // A lens explicitly disabled here is SKIPPED cleanly -- no grant, no check, and the
  // aggregate `Autopilot / review` judges only the enabled lenses. Anything NOT disabled
  // is mandatory: a missing/crashed reviewer fails the round (fail closed). Optional;
  // defaults to all three enabled. Resolved per-lens so a layer can switch one off without
  // restating the others.
  reviewLenses?: Partial<Record<ReviewLens, boolean>>;
  // Finding severities that fail the review round (and trigger the bounded repair loop).
  // Case-insensitive match against each finding's severity text. Defaults to ['blocker'].
  reviewBlockingSeverities?: string[];
  // Publish the review round's findings onto the ticket's promotion PR as a real PR review,
  // inline on the file/line each finding names. Per-tenant like every other gate field.
  // Optional; defaults to FALSE -- it writes into the customer's PR conversation, and a
  // tenant that reviews in the tracker should not suddenly find the bot commenting on its
  // pull requests.
  publishReviewFindingsToPr?: boolean;
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

// One MCP server an agent stage may use, carried in the signed grant (control-plane
// authority) so the runner writes a claude-code-action `--mcp-config` file for it. The
// `name` is the mcpServers key -- its tools are addressed as `mcp__<name>__<tool>`.
// `authEnvVar` names the env var the tenant's CI exposes the server's token under; it is a
// NAME, never a value -- the mcp-config file the runner writes uses a `${authEnvVar}`
// placeholder, so no secret ever appears in the grant, the config file, or any log.
export interface McpServerSpec {
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string; // for http/sse
  command?: string; // for stdio
  args?: string[]; // for stdio
  authEnvVar?: string; // NAME of the env var holding the token (never the value)
}

// The MCP access a grant authorizes: the server definitions plus the allowlist of mcp tool
// names the stage may call (`mcp__<server>__<tool>`). Both are resolved SERVER-SIDE from the
// tenant's config (never from ticket/tracker input), like gateSpecs.
export interface McpGrant {
  servers: McpServerSpec[];
  allowedTools: string[];
}

// The Claude Code plugin access a grant authorizes: the marketplace git URLs to register plus
// the `pluginName@marketplaceName` plugins to install. Both are resolved SERVER-SIDE from the
// tenant's config (never from ticket/tracker input), like mcp and gateSpecs. Unlike mcp these
// flow to claude-code-action as action INPUTS (plugin_marketplaces / plugins), not a temp file.
export interface PluginGrant {
  marketplaces: string[];
  plugins: string[];
}

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detailsUrl?: string;
  // Why the check failed, when its producer reports reasons (gates do; job-name
  // fallback checks don't). Carried so a fix prompt and human escalations can quote
  // the actual finding text instead of just a check name.
  findings?: string[];
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
  // A unique nonce for this ISSUED grant, minted server-side at issuance
  // (grant.ts, node:crypto randomUUID) and part of the signed payload like every
  // other field -- so a tampered jti fails verifyGrant, and two identical issueGrant
  // calls yield distinct jtis. It is the key the consume ledger
  // (control-plane/grant-ledger.ts) records executions under: replaying the SAME
  // grant collides on its jti and is flagged, while every re-issued retry is a fresh,
  // unconsumed id. Absent on legacy grants, which still verify; they fall back to
  // sha256(sig), the same stable telemetry id both planes already derive.
  jti?: string;
  // The branch a coding stage (build/fix) must base its work on and open its PR
  // against -- set server-side to the ticket's integration branch so subtask
  // work never targets the customer's live default branch directly. The only
  // merge onto the protected base is the human-gated promotion (promote.ts).
  // Absent -> the runner falls back to the repo's default branch. Part of the
  // signed payload like every other field, so a tampered base fails verifyGrant.
  baseBranch?: string;
  // The EXACT commit the runner must check out when a stage judges a PINNED revision
  // rather than "whatever the branch head is now": the Track E review round pins the
  // assembled branch's sha once at dispatch (control-plane.ts driveAssembledAccept) and
  // every reviewer grant carries it signed -- so the three parallel reviewer jobs, which
  // may start minutes apart, can never silently inspect different revisions if the
  // branch moves between snapshot and checkout (the external review finding: pinning was
  // bookkeeping-only). The runner folds this over baseBranch into its checkout ref
  // (runner/prepare-stage.ts); absent -> baseBranch's head is checked out exactly as
  // before. Part of the signed payload like every other field: a tampered sha fails
  // verifyGrant, so what was reviewed is provably what was pinned.
  headSha?: string;
  // The ticket's human-readable title, carried so the runner can name branches
  // and PRs after it (a slug of this + a short id) instead of an opaque ticket
  // UUID. Metadata only (already present in the stepPrompt); never a secret.
  ticketTitle?: string;
  // An EXPLICIT build branch, overriding the name codingBranchName would derive from the
  // title. Set only by replan reconciliation: a replan that RENAMES a subtask keeps its
  // identity (the branch hash is keyed on tenant/repo/subtask id/stage -- the title is only
  // the readable prefix), so the old branch provably holds this same subtask's prior work,
  // but the derived name has moved and the runner would push somewhere else and orphan it.
  // Carrying the old name here makes the rebuild continue that branch, so the existing
  // findOpenPR idempotency adopts its open PR. Signed like every other field, so a tampered
  // branch fails verifyGrant -- it can never redirect a push on its own.
  buildBranch?: string;
  // A short, high-entropy label for this grant's ticket (the uuid's last segment plus
  // any `.N` subtask suffix), computed server-side at issuance (grant.ts). The runner
  // names its workflow run "Autopilot <stage> <shortId>: <title>" from it, and the
  // control plane correlates the completed run back by that same prefix -- so the CI UI
  // shows the human title instead of a 36-char id crowding it out. Signed like every
  // other field; absent on a legacy grant, where correlation falls back to ticketId.
  shortId?: string;
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
  // The per-tenant MCP-server access every agent stage (planner/architect/build/fix/qa/
  // accept) runs with -- resolved server-side from the tenant's config (never from
  // ticket/tracker input). Part of the signed payload like every other field;
  // `authEnvVar` carries a NAME not a value, so no secret ever crosses the split plane.
  mcp?: McpGrant;
  // The per-tenant Claude Code plugin access every agent stage runs with -- resolved
  // server-side from the tenant's config (never from ticket/tracker input). Part of the
  // signed payload like every other field; the runner passes it as claude-code-action's
  // `plugin_marketplaces`/`plugins` inputs so the tenant's build runner installs them.
  plugins?: PluginGrant;
  // Server-side resolved from the tenant's debug.showFullOutput config (never from ticket/
  // tracker input, like every other field here): tells the runner to pass claude-code-action's
  // own `show_full_output` input, revealing the raw SDK output instead of the minimal result
  // summary. Absent/false by default -- see config/types.ts DebugConfig for why it's opt-in.
  debugFullOutput?: boolean;
  // Which independent review lens this grant runs, for a `review` stage. Part of the signed
  // payload like every other field, so a tampered lens fails verifyGrant -- and the runner
  // routes a lensed review grant through the read-only+plan.json profile while a lens-less
  // `review` grant behaves exactly as before (the linear ticket pipeline's generic review).
  reviewLens?: ReviewLens;
} & ({ stepPrompt: string; ref?: never } | { ref: string; stepPrompt?: never });

// One normalized, source-free defect a review lens reports (Track E). Metadata only --
// a file/line POINTER and plain-language prose, never a diff, source, or secret -- so it
// respects the split-plane boundary on its way back from the runner.
export interface ReviewFinding {
  // Free text matched case-insensitively against the tenant's configured blocking
  // severities (gates.reviewBlockingSeverities). The prompts constrain the model to
  // blocker|major|minor; anything else counts as non-blocking.
  severity: string;
  summary: string;
  file?: string;
  line?: number;
  // Whether a code change can fix it at all ('fixable' | 'needs-human' | free text).
  fixability?: string;
}

// A review lens's verdict on the pinned assembled revision: pass is true only when the
// lens found no defect worth reporting; findings carry the structured evidence. A lens
// that reports findings while claiming pass still fails aggregation if any finding's
// severity blocks (a sloppy reviewer must not waive a named defect).
export interface ReviewVerdict {
  pass: boolean;
  findings: ReviewFinding[];
}

// One planned subtask produced by the architect stage: the title that becomes its
// tracker entry, the architect note written back to that entry, the file paths/globs
// it owns (coverage, so nothing is silently dropped and work stays file-disjoint), and
// its 0-based dependencies on other subtasks in the same plan (advisory ordering). This
// is metadata only -- titles, prose, path globs -- never source, diff, or secret, so it
// respects the split-plane boundary that only telemetry crosses back.
export interface PlannedSubtask {
  title: string;
  plan?: string;
  // The rich, PO-readable + grouped-technical markdown spec for this subtask (## What will
  // be done, ## Technical approach, ## Files, ## Acceptance criteria, ## Reuse, ## Obligations).
  // Written into the subtask's tracker page/issue body so it reaches BOTH the implementer
  // (build stage reads the page) and a human reader. `plan` stays the terse one-line note.
  body?: string;
  coverage?: string[];
  blockedBy?: number[];
}

// The `accept` stage's verdict on the ASSEMBLED integration branch: does the
// merged work actually satisfy every deliverable/acceptance criterion the ticket
// requires? `met` is true only when nothing is missing; `unmet` lists, in plain
// language, each deliverable that is absent or only stubbed (empty when met). This
// is what catches an under-scoped architect plan even when the build is green --
// e.g. a ticket that asked for an ROI calculator that no subtask ever built.
// Metadata only (plain-language criteria), so it respects the split-plane boundary.
export interface AcceptanceVerdict {
  met: boolean;
  unmet: string[];
}

// The PO-facing plain-language summary of an architect plan, rendered as the parent ticket's
// "## For review" block so a non-technical reporter can sign off without reading the code plan.
// Every field is jargon-free (no file paths or symbols) -- that's enforced in the architect
// prompt. Ported from the old website architect's `review_summary`.
export interface ReviewSummary {
  whatChanges: string;
  userVisible: string;
  outOfScope: string;
  assumptions: string[];
  openQuestions: string[];
}

// Everything the architect writes back to the PARENT ticket beyond the subtasks themselves:
// the PO "For review" block, the engineer-facing plan narrative (rendered as formatted body
// blocks under a collapsed toggle), the touched-areas list, and any related tickets. All
// optional -- a plan may carry some and not others. Metadata only (prose), split-plane safe.
export interface ArchitectReview {
  reviewSummary?: ReviewSummary;
  // Engineer-facing plan narrative in markdown (## Overview / ## Why This Architecture /
  // ## Findings / ## Subtasks / ## Verification). Rendered as native Notion blocks, not a
  // code block, so it wraps.
  summary?: string;
  touchedAreas?: string[];
  relatedTickets?: string[];
}

export interface StageResult {
  outcome: StageOutcome;
  checks: CheckResult[];
  prUrl?: string;
  logDigest: string;
  // Set by dispatchStage/checkStage so the caller can persist the in-flight run marker and,
  // on later ticks, re-correlate the same run (cross-tick deadline is anchored on
  // runCreatedAt -- the run's immutable created_at -- so a hung run still escalates).
  runId?: number;
  runCreatedAt?: string;
  // Only an `architect` stage populates this: the ordered subtask plan it produced,
  // downloaded by the CIRunner from the run's `plan.json` artifact and persisted
  // deterministically by the control plane (createSubtasks + linkBlockedBy). Absent for
  // every other stage.
  subtasks?: PlannedSubtask[];
  // Only an `accept` stage populates this: the acceptance verdict on the assembled
  // integration branch, downloaded by the CIRunner from the run's artifact. Absent
  // for every other stage.
  acceptance?: AcceptanceVerdict;
  // Only a lensed `review` stage populates this: the lens's structured findings on the
  // assembled revision, downloaded by the CIRunner from the run's plan.json artifact.
  // Absent for every other stage (and for a legacy lens-less review grant).
  reviewVerdict?: ReviewVerdict;
  // Only an `architect` stage populates this: the PO/engineer plan writeback (For-review
  // block, plan narrative, touched areas, related tickets) the control plane renders onto
  // the PARENT ticket after decomposing. Absent for every other stage and for a HOLD.
  review?: ArchitectReview;
  // Only an `architect` stage populates this, and only when it HELD instead of
  // decomposing: the plain-language fork explanation (what was asked / found / why it
  // stopped / the questions a human must answer) from plan.json's `hold` field. When set,
  // the plan is intentionally empty and the control plane blocks the ticket with this text
  // for a human, rather than treating the empty plan as an architect failure.
  hold?: string;
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

// A CI stage that was dispatched but hasn't been observed complete yet. Persisted on the
// ticket/subtask so the drive loop can DISPATCH a stage and RETURN immediately, then RECONCILE
// the run's result on a later tick -- instead of blocking the whole tick awaiting the run. This
// is what keeps every tick fast so tickets, imports, and recovery all advance in parallel.
export interface InFlightStage {
  // The logical step running (build | gate | fix | architect | enrich | plan | accept | review).
  stage: Stage;
  // When this stage was dispatched (ISO). Fallback deadline anchor + findRun lower bound until
  // the run's own created_at is known.
  dispatchedAt: string;
  // The dispatched run, once correlated by run-name. Absent until the first successful check.
  runId?: number;
  // The run's immutable created_at (ISO). The cross-tick deadline is anchored HERE (not on
  // Date.now()), so a genuinely hung/overlong run still escalates after the stage timeout.
  runCreatedAt?: string;
  // Fix-loop resumability: which fix round this is, and which half (fix vs re-gate) is running.
  fixRound?: number;
  fixPhase?: 'fix' | 'gate';
  // Assembled-acceptance repair counter mirror (ticket-level accept machine).
  acceptRepairs?: number;
  // Which ticket-level path dispatched this fix, so the fix paths sharing the ticket's single
  // inFlight slot (conflict auto-resolve, review-feedback autofix, external-PR qa autofix)
  // only reconcile runs they dispatched themselves -- a foreign marker would still correlate
  // by run-name (stage + ticketId), so consuming it here would mislabel its telemetry.
  // Absent on subtask markers (each subtask owns its own slot) and legacy persisted markers.
  origin?: 'conflict' | 'feedback' | 'qa';
}

// What a replan preserves about an old subtask it discarded, until the NEW plan exists and
// can be compared against it. Only what reconciliation needs: the tracker id (does the new
// plan still use this child page?) and the build branch (does the new plan reclaim it?).
export interface ReplanLeftover {
  id: string;
  branch?: string;
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
  // The subtask ids this one depends on (mapped from the architect plan's `blockedBy`
  // indices). The drive loop won't build a subtask until every id here is `done`, so a
  // plan with real ordering (e.g. an e2e that needs the page it tests) builds in order
  // rather than racing. Absent/empty means independent -- driven in parallel with siblings.
  blockedBy?: string[];
  status: TicketStatus;
  prMerged: boolean;
  // The subtask's own build PR and the branch it was built on, recorded so a
  // re-drive can reuse (never duplicate) that PR, clean the branch up on a terminal
  // outcome, and write the PR link back to the tracker. Absent until its build stage
  // has produced one.
  prUrl?: string;
  branch?: string;
  // The tracker's OWN id for this subtask's page/issue, recorded when the plan was
  // persisted. The control-plane id (`<parent>.<n>`) is a plan POSITION, not an identity: a
  // replan mints the same ids for different work, and a tracker whose children accumulate
  // across plans (Notion's child relation) cannot resolve one back to a page without help.
  // This is that help, and it belongs in OUR durable state rather than in a property on the
  // customer's database -- the fact is ours. Absent for plans persisted before this existed
  // and for backends that don't expose a page id; resolution then falls back as before.
  externalId?: string;
  // The branch this subtask must keep building on, overriding the title-derived name.
  // Set only when replan reconciliation matched this subtask to a RENAMED predecessor's
  // branch (see ExecutionGrant.buildBranch). Sticky for the subtask's life: dropping it
  // after one build would send the next tick back to the derived name and orphan the work
  // all over again. Absent -> the derived name, i.e. every subtask that was never renamed.
  adoptBranch?: string;
  // Consecutive failed build (coding) attempts for this subtask. The pipeline
  // re-drives the build while this is under `fix.maxBuildRetries` before
  // blocking the subtask for a human. Reset once a build produces a PR.
  buildAttempts?: number;
  // Consecutive ticks this subtask has re-driven through the gate/merge path
  // without completing (its merge stayed pending). The pipeline re-drives while
  // this is under `MAX_REVIEW_ATTEMPTS` before blocking the subtask for a human,
  // so a merge that never becomes mergeable can't loop CI forever. Reset once the
  // subtask completes (merged/done).
  reviewAttempts?: number;
  // How many times a `fix` stage has been dispatched to auto-resolve a merge
  // conflict on this subtask's build PR (the same bounded self-heal the
  // rollup/promotion/external-PR paths get). Bounds the conflict loop so a
  // genuinely unresolvable conflict blocks the subtask for a human.
  conflictFixAttempts?: number;
  // How many times a fix has been dispatched to repair a RED CUSTOMER check on this
  // subtask's build PR head (Track F's bounded self-heal, distinct from conflictFixAttempts
  // so a conflicted-then-red PR gets its full budget of each).
  ciFixAttempts?: number;
  // Consecutive ticks the customer-check READ itself threw (listChecks errored) while
  // gating this subtask's merge. Distinct from reviewAttempts, which a healthy-but-slow
  // customer check must never spend: a read that keeps throwing (the app lost access to
  // the repo, the branch is gone, GitHub is down on that endpoint) is stuck forever, not
  // waiting, so it escalates on this own bounded budget. Cleared by a successful read that
  // keeps holding the subtask (a green read merges it, so the count dies with the subtask).
  checkReadFailures?: number;
  // Why this subtask was blocked, when it was: an exhausted build/fix loop, a
  // real merge conflict on its PR, or an error that isolated to it (never the
  // whole ticket). Carried so a human sees a concrete reason.
  blockedReason?: string;
  // A dispatched CI stage (build/gate/fix) awaiting completion. When set, the next drive
  // CHECKS it (non-blocking) instead of dispatching; cleared when the stage completes. This
  // is what makes driveSubtask a per-tick state machine (see InFlightStage).
  inFlight?: InFlightStage;
}

// One enabled lens's finalized telemetry within a review round: the run outcome plus the
// parsed verdict when the run passed AND produced a readable artifact. A lens recorded
// without a verdict failed closed (crash, unreadable plan.json) -- aggregation treats it
// exactly like any other failed reviewer.
export interface ReviewLensResult {
  outcome: StageOutcome;
  verdict?: ReviewVerdict;
}

// The in-progress independent-review round over the assembled integration branch
// (Track E). Persisted on the TicketState so the fan-out survives ticks and restarts:
// `sha` pins the exact revision all three reviewers inspect (a head that moves mid-round
// discards the round and re-pins), `pending` carries one dispatch marker per lens until
// its run finalizes, and `results` accumulates finalized lens outcomes until aggregation.
export interface ReviewRoundState {
  sha: string;
  // When this round was pinned, ISO-8601. Threaded into a later tick's dispatch of a lens the
  // round still misses (DispatchStageOptions.adoptSince) so that dispatch adopts a reviewer run
  // this round already started -- a handle that never persisted (a dispatch that threw after
  // its siblings launched) is minutes old by then, far outside a same-instant floor, and would
  // otherwise be duplicate-dispatched. A DISCARDED round's runs stay unadoptable: the round
  // that replaces it carries a later startedAt. Absent on rounds persisted before this field.
  startedAt?: string;
  pending: Partial<Record<ReviewLens, InFlightStage>>;
  results: Partial<Record<ReviewLens, ReviewLensResult>>;
  // Consecutive ticks this round failed a completion attempt -- every reviewer launch
  // threw (e.g. a GitHub 422 on an oversized grant input) or the AI-run budget couldn't
  // cover the lenses still missing. Bounds what would otherwise be a SILENT
  // reviewing-forever loop (allSettled swallows rejections; nothing else observes them):
  // at the cap the ticket blocks with the recorded evidence, mirroring rollupPendingTicks.
  // A placeholder round ({pending:{},results:{}}) persists just this counter between failed
  // START attempts -- an EMPTY pending alone does not mean "no round" (a fully collected
  // round awaiting aggregation looks the same); any successful start writes a fresh round
  // without this counter, resetting the streak.
  missingAttempts?: number;
}

export interface TicketState {
  tenantId: string;
  repoId: string;
  ticketId: string;
  title?: string;
  description?: string;
  status: TicketStatus;
  subtasks: SubtaskState[];
  // Set once a PO has approved this decomposed ticket's plan under the plan-review gate
  // (gates.requirePlanApproval). While false/absent and the gate is on, the ticket holds
  // after decomposition and drives no subtask build. Ignored when the gate is off.
  planApproved?: boolean;
  // How many subtasks the architect's plan enumerated for this ticket. Recorded
  // when the plan is persisted (dispatchArchitect) and checked by rollupGuard: a
  // ticket may roll up only once every PLANNED subtask is present and done, so a
  // set that lost or never persisted some of its planned children can't promote a
  // partial delivery. Undefined for non-decomposed tickets (no architect plan).
  plannedSubtaskCount?: number;
  // How many times the assembled review (acceptance walk, now the three-lens review
  // round) found the branch UNMET and the control plane dispatched a repair build before
  // re-reviewing. Bounds the review -> repair -> re-review self-heal so a
  // genuinely-unbuildable ticket blocks for a human instead of looping.
  acceptRepairAttempts?: number;
  // Highest PR review/comment ids the control plane has already acted on, per source, so
  // corrective feedback (a Codex or human `changes_requested`/comment) drives a fix exactly
  // once. Persisted so a control-plane restart doesn't re-fix already-handled feedback.
  feedbackCursor?: { reviewId: number; commentId: number; threadCommentId?: number };
  // How many times a `fix` stage has been dispatched to auto-resolve a merge conflict on
  // this ticket's PR. Bounds the conflict self-heal so a genuinely unresolvable conflict
  // blocks for a human instead of looping. Reset once the PR merges.
  conflictFixAttempts?: number;
  // Consecutive ticks the rollup PR's merge has stayed `pending` (behind, not ready, or a
  // benign race that keeps recurring). Bounds the deferral so a merge error that never
  // clears escalates for a human instead of parking silently forever. Reset once the
  // rollup merges.
  rollupPendingTicks?: number;
  // How many times the architect has been re-run because its plan dropped a required
  // deliverable (the deterministic coverage gate). Bounds the re-architect loop before
  // blocking for a human. Reset once a covering plan is accepted.
  architectRetries?: number;
  // The deliverables the last architect plan failed to cover, fed back into the next
  // architect prompt so it stops dropping them. Cleared once coverage passes.
  architectCoverageGaps?: string[];
  prs: string[];
  // The promotion PR opened EARLY -- as soon as the rollup lands on the integration branch,
  // before the assembled review runs -- purely so a human can watch the review happen: the
  // diff is live and each lens's check-run lands on it as it finishes. Deliberately NOT in
  // `prs`: that array means "the official promotion PR is open and awaiting approval" and is
  // read as exactly that (independent of status) by the reply-handling path, which would
  // otherwise deflect every tracker reply for the whole of accept/review. Set once (the open
  // is find-or-open, so later ticks reuse it) and cleared when promote() folds the same PR
  // into `prs` -- it is no longer a preview then. Left set, pointing at the still-open PR,
  // when review blocks: that PR is the evidence the human needs.
  draftPromotionPr?: string;
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
  // Consecutive times the watchdog has nudged a stalled QA/fixer stage back to
  // life without the stage making progress. Bounds the stall re-arm loop
  // (watchdog.ts MAX_STALL_RECOVERIES) so a genuinely dead runner is escalated
  // to a human instead of being re-armed forever. Reset once the stage advances
  // (a real stage transition off reviewing/fixing).
  stallRecoveries?: number;
  // A dispatched ticket-level CI stage (architect/enrich/plan/accept, or a repair build)
  // awaiting completion. When set, the next drive CHECKS it (non-blocking) instead of
  // dispatching; cleared when it completes. Makes the ticket-level judgment/accept paths
  // per-tick state machines (see InFlightStage).
  inFlight?: InFlightStage;
  // The deployment of this ticket's promoted change, once its promotion PR has
  // merged. A ticket is complete when its deployment is observed, not when its PR
  // merges (see deploy-watch.ts): while this is `pending`, the ticket stays in
  // `reviewing` and neither the drive loop nor the reconciler may complete it.
  // `unverified` records that the host never reported a deployment result -- the
  // ticket is finished, but Autopilot did not see the deploy succeed.
  deployment?: {
    /** The commit the deployment runs on -- the merge commit SHA (pinned at promotion), so a
     *  failure is judged against THIS change, not whatever later lands on the moving branch. */
    ref: string;
    /** When the wait started (ISO 8601). Reset each time a failed deploy is re-triggered. */
    startedAt: string;
    status: 'pending' | 'passed' | 'failed' | 'unverified';
    detail?: string;
    /** How many times a failed/stalled deployment has been re-triggered (deploy.maxRetries
     *  bounds this before the ticket blocks for a human). */
    retryAttempts?: number;
  };
  // The last promotion-hold notice emitted for this ticket, so a ticket that sits
  // ready-but-unmergeable (auto-merge disabled, unmet checks, a host merge refusal)
  // is announced once per reason-change rather than on every 60s tick.
  lastNotice?: string;
  // Present ONLY on an external-PR pseudo-ticket (id "external-pr-<n>"): a human/automation
  // PR into a protected branch that the ticket pipeline did NOT open, which the control
  // plane picks up as a first-class driven workflow (QA -> autofix-on-fail -> conflict
  // resolve -> merge). Carries the PR number, its head branch, and the base it targets.
  // A pseudo-ticket is isolated from the tracker/reconciler (it has no TaskBackend ticket).
  externalPr?: { number: number; headRef: string; baseBranch: string };
  // How many times a `fix` has been dispatched to green an external PR after its QA failed
  // (a failing gate, or a QA that repeatedly could not complete). Bounds the external
  // autofix so a PR Autopilot can't get green is left for its author instead of looping.
  // Track F reuses the same counter (and its fix.maxFixRounds bound) for the customer-CI
  // autofix loop on PROMOTION PRs -- a ticket has one shared CI-repair budget either way.
  externalQaFixAttempts?: number;
  // Set when the control plane holds a decomposed ticket for a replan/continue decision --
  // its recorded plan is possibly stale (the ticket re-entered the ready status, or every
  // ticket blocking it has shipped) and a human must choose: reply "replan" to discard the
  // recorded plan and re-architect, or anything else to resume it with fresh budgets.
  // Cleared by the answer. Ask-once: while set, the hold never re-fires.
  replanPrompted?: boolean;
  // Set the first time dependency-wake fires for this ticket (every ticket blocking it in
  // the tracker's blocked-by relation has shipped). Wake-once: a ticket that blocks AGAIN
  // after waking is not auto-woken a second time -- the relation was consumed.
  dependencyWokenAt?: string;
  // Consecutive ticks the tracker has reported this known, decomposed, non-terminal ticket
  // at the ready status (the structure-drift signal). The replan/continue hold fires only on
  // the SECOND consecutive sighting: one sighting is indistinguishable from our own status
  // write not being indexed yet, and holding a live ticket over that would wedge delivery.
  readyDriftTicks?: number;
  // The live independent-review round over the assembled branch (see ReviewRoundState).
  // Absent whenever no round is running -- between rounds (e.g. while a repair build is
  // in flight) and once the aggregate passes.
  reviewRound?: ReviewRoundState;
  // Old subtasks a REPLAN discarded, held until the replacement plan exists. freshRestart
  // wipes `subtasks`, so without this the branches/PRs/child pages that plan left behind
  // have no record and orphan forever. Cleanup is DEFERRED rather than done at replan time
  // because the only sound way to tell a leftover from work the new plan reclaims is to
  // compare against the new plan -- which doesn't exist yet at that point. Cleared by
  // reconcileReplanLeftovers once a plan lands.
  pendingReplanSubtasks?: ReplanLeftover[];
  // Findings already published to the promotion PR (findingKey values). The repair loop
  // re-reports whatever a round still finds, so without this every surviving finding is
  // posted again each round and a three-repair ticket carries three copies of the same
  // comment. Plan-scoped like the other review state: cleared by a replan.
  postedFindingKeys?: string[];
}

// The ticketId prefix for an external-PR pseudo-ticket (see TicketState.externalPr). Such
// entries live in the same StateStore as real tickets but are driven by driveExternalPr and
// must be skipped by anything that assumes a backing TaskBackend ticket (the tracker poll,
// the reconciler's merged-PR/status sweeps).
export const EXTERNAL_PR_PREFIX = 'external-pr-';

export function isExternalPrTicket(ticketId: string): boolean {
  return ticketId.startsWith(EXTERNAL_PR_PREFIX);
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
  // The PR's base branch name, used to discover the base branch's OWN required
  // status checks (branch protection + rulesets) so a merge can't push past a
  // gate the repo enforces. Optional; adapters that don't surface it omit it.
  baseRef?: string;
}
