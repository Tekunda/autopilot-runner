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
  // The rendering-surface-removal gate (plan-integrity gate #1): when true, a decomposed
  // plan that declares any `removals` (a user-visible section/band/component/... it deletes
  // or hides) HOLDS for human sign-off after the architect writes it, rather than building
  // the deletion unattended. Per-tenant like every other gate field. Optional; defaults to
  // TRUE (this is a safety pipeline -- removing what a user sees warrants a person's nod).
  // Independent of the always-on self-contradiction detector, which STOPs a "remove X / keep
  // X's essence" ticket regardless of this flag.
  holdOnRenderingSurfaceRemoval?: boolean;
  // The completeness gate (plan-integrity gate #3): when true, a plan that omits a deliverable the
  // ticket NAMES (an imperative spec/title instruction, or a DELIVERABLES: item) with no covering
  // subtask AND no justified removal is re-architected (bounded), then HELD for a human if a re-plan
  // still leaves it uncovered. Per-tenant like every other gate field. Optional; defaults to TRUE
  // (a silently dropped deliverable is the TEK-3727 failure). Re-architect-first, so a rare false
  // positive self-corrects rather than halting work.
  holdOnUncoveredDeliverables?: boolean;
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
  // Publish each terminal review round's OUTCOME onto the ticket's promotion PR as a real PR
  // review: a per-lens section (every enabled lens's pass/advisory/blocking result and its
  // findings at all severities, or an explicit all-clear), an aggregate line, and inline
  // comments on the file/line each finding names. Records a green round too, not just a
  // blocking one, so the review is auditable on the PR and not only via the check summary.
  // Per-tenant like every other gate field. Optional; defaults to TRUE (opt-out) -- a tenant
  // that reviews solely in the tracker sets it false to keep the bot off its PR conversation.
  publishReviewFindingsToPr?: boolean;
  // When the bounded repair loop is spent, REPLAN instead of blocking for a human: discard
  // the recorded plan and re-architect with every finding forwarded into the ticket, so the
  // gaps come back as properly scoped subtasks with their own budgets instead of one repair
  // stage being asked to close all of them at once. Optional; defaults to FALSE -- replanning
  // is destructive (it discards a plan) and a tenant should choose it deliberately.
  autoReplanOnExhaustedRepairs?: boolean;
  // Before a ticket escalates to a human -- an architect open-questions hold, or a fix-loop
  // exhaustion at the ticket level (one or more subtasks stopped before completing) -- give
  // freshRestart ONE shot at re-architecting with the hold text/blocked reasons forwarded in as
  // notes, same idiom and same shared `autoReplans` budget as autoReplanOnExhaustedRepairs (at
  // most one auto-replan per ticket, across every escalation reason that consults it). A second
  // hold/exhaustion on the fresh plan is a genuine escalation -- the guard fails and the
  // ordinary human-escalation path runs. Optional; defaults to TRUE -- unlike
  // autoReplanOnExhaustedRepairs this never discards WORK (pre-plan, or a plan already stalled
  // out), so it is a strictly-better bounded default rather than a destructive opt-in.
  autoReplanBeforeEscalation?: boolean;
}

// A `gate` stage's entitled gates, delivered JIT inside the signed grant so the runner
// never holds gate/pack logic of its own (AGENTS.md "split plane", issue #129):
//   - `generic` names one of the runner's own bundled, commodity gates (src/gates/generic/*
//     -- npm-audit thresholds, forbidden-path predicates; no licensed IP), optionally
//     narrowed by signed `config` (severity thresholds, path lists, ...) that -- being part
//     of the signed payload -- overrides anything the unsigned runner-side GateTarget.config
//     tries to set for that same gate id. `blocking` (default true) also rides here: a
//     report-only generic gate (`blocking:false`, from PackConfig.gateConfig[id]) still
//     publishes its per-gate check but its `fail` is excluded from the stage's blocking verdict.
//   - `prompt` carried a licensed pack gate's full JIT instruction. Prompt gates are
//     disabled under the current stopgap (only deterministic generic gates run), so this
//     variant has no producer today; it is retained for the signed-payload shape.
//   - `command` names an H3 command gate: a tenant-declared shell command line (`run`) the
//     runner executes against the customer PR checkout, exit code -> pass/fail. Synthesized
//     one-per-configured-gate from the tenant's PackConfig.commandGates (packs/registry.ts),
//     so a tenant declaring `yarn lint`/`yarn build` gets a signed spec per command. `blocking`
//     rides here so a report-only gate's failure never fails the grant (see GateStatus).
export type GateSpec =
  | { kind: 'generic'; id: string; config?: Record<string, unknown>; blocking?: boolean }
  | { kind: 'prompt'; id: string; prompt: string }
  | { kind: 'command'; id: string; run: string; blocking?: boolean };

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

// The tenant-supplied recipe for bringing the customer site up in the dedicated heavy gate
// stage (src/runner/serve-and-gate.ts): install -> build -> start -> wait-for-ready. Because
// `startCommand` is an arbitrary shell command, this rides ONLY in the SIGNED grant
// (ExecutionGrant.serve, resolved server-side from the tenant's PackConfig.serve like mcp/
// plugins) -- never the unsigned, attacker-influenceable GateTarget.config -- so a forged
// serve recipe fails verifyGrant before any command runs. The runner reads it only in the
// heavy stage; the fast gate path ignores it.
export interface ServeConfig {
  // Optional dependency install (e.g. `yarn install --frozen-lockfile`), run before build.
  installCommand?: string;
  // Optional build (e.g. `yarn build:site`). A pure `yarn start` tenant can omit it.
  buildCommand?: string;
  // The long-running server command (e.g. `yarn start:site`). Required.
  startCommand: string;
  // The base URL the started server listens on (e.g. `http://localhost:3000`). Required -- this
  // is what gets threaded into the heavy gates as their runtime baseUrl.
  baseUrl: string;
  // Path polled to decide readiness. Default `/`.
  readyPath?: string;
  // How long to wait for the first OK response before giving up. Default 120s.
  readyTimeoutMs?: number;
  // Poll interval while waiting. Default 1s.
  readyIntervalMs?: number;
}

// One site of a MULTI-SITE tenant (e.g. Tekunda/Website serves both `tekunda` and `serpent`
// from one repo): its own serve recipe and its own per-URL-bound-gate config, so each site is
// brought up on its own server and crawled/screenshotted with its own routes/brand-lists. Rides
// in the SIGNED grant (ExecutionGrant.sites) exactly like ServeConfig -- `serve.startCommand` is
// a shell command, so it must be signed, never taken from the unsigned GateTarget. The heavy
// gate stage (src/runner/serve-and-gate.ts) runs the URL-bound gates ONCE PER site, naming each
// site's checks `<gate> (<name>)` so a fail on either site is legible and blocks. Absent (no
// `sites`) -> the single-`serve` path is used unchanged.
export interface SiteConfig {
  // Disambiguates this site's per-gate checks (`seo-site-crawl (tekunda)`), so keep it short and
  // stable -- it becomes part of the published check name Track F matches as a matrix variant.
  name: string;
  // How to bring THIS site up (install/build/start/baseUrl), same shape as the single-site path.
  serve: ServeConfig;
  // Per-site overrides for the URL-bound heavy gates (routes, brand lists, budgets), keyed by
  // gate id, merged ON TOP of the signed base gateConfig at run time -- the site's baseUrl is
  // added over it. Absent -> only the base config plus this site's baseUrl.
  gateConfig?: Record<string, Record<string, unknown>>;
  // Where THIS site is deployed, per base branch: { test: 'https://test.example.com',
  // main: 'https://example.com' }. Mirrors the per-environment site URLs a tenant repo
  // already keeps for its own deploys, so nothing new has to be invented or kept in sync.
  //
  // issueGateGrant resolves the entry matching the grant's baseBranch and injects it as the
  // crawl gate's `baselineUrl`, so whole-site findings are judged against the branch this
  // work merges INTO rather than in absolute terms. Resolving it server-side is deliberate:
  // baselineUrl decides what gets EXCUSED, so unlike gate-target/gate-mode (which only say
  // what to check) an unsigned value would be a gate bypass -- point it at a host that fails
  // everything and every finding demotes to a warning. Riding in the signed grant means a
  // tampered value fails verifyGrant.
  //
  // Absent, or no entry for this base branch -> no baseline, every finding blocks as before.
  deployedBaseUrls?: Record<string, string>;
}

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detailsUrl?: string;
  // Why the check failed, when its producer reports reasons (gates do; job-name
  // fallback checks don't). Carried so a fix prompt and human escalations can quote
  // the actual finding text instead of just a check name.
  findings?: string[];
  // The gate RAN but reached no verdict (e.g. the vision judge stayed rate-limited
  // past its retry budget). It publishes with `status:'fail'` so it blocks the merge,
  // but no code fix can resolve it -- the fix loop treats it as non-revertable and
  // escalates to a human. Distinct from an ordinary `fail`: this is "could not judge",
  // not "judged and failed". `CheckStatus` stays a three-value union; this flag rides
  // alongside it.
  unjudged?: true;
  // When `unjudged`, WHY the gate reached no verdict -- it NEVER lets an unjudged pass, it only
  // routes escalation. 'infra': the judge could not RUN (the vision model stayed rate-limited/429
  // past its own backoff -- a transient infra fault). No code edit clears a 429, so a `fix` stage
  // is useless, but a re-run might reach a verdict: the fix loop grants exactly ONE gate-only retry
  // before escalating. 'content': the judge RAN but reached no verdict about the page -- no re-run
  // helps, so it escalates to a human immediately. Absent -> treated as 'content' (fail closed,
  // escalate now).
  unjudgedReason?: 'infra' | 'content';
  // The gate NEVER RAN (returned `skip`) -- the complement of `unjudged`'s "ran, no verdict". It
  // publishes with `status:'pending'` (a skip was never evaluated, not passed), but a skip is not
  // the same as a not-yet-run pending: this flag makes the two distinguishable so a perpetual-skip
  // gate can't be banked as coverage. `skipReason` explains WHY it skipped, driving benign-vs-
  // suspicious escalation. `CheckStatus` stays a three-value union; these ride alongside it.
  skipped?: true;
  skipReason?: string;
  // The gate's base id BEFORE any per-site display suffix is appended to `name`. A URL-bound gate
  // that runs once per site publishes distinct display names (`seo-site-crawl (tekunda)`), but the
  // never-run/no-baseline ledger and the enabled-gate set are keyed by the bare gate id -- so the
  // base id must survive the suffixing to match them. Absent (== `name`) when no suffix was applied.
  baseId?: string;
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
  // The tenant's heavy-gate serve recipe (install/build/start/baseUrl), resolved server-side
  // from PackConfig.serve at gate-grant issuance. Signed like every other field so the shell
  // commands it carries can't be tampered with in transit, and read ONLY by the heavy gate
  // stage (src/runner/serve-and-gate.ts) to bring the customer site up before the URL-bound
  // gates (seo-site-crawl, visual-qa) run. Absent -> the heavy stage skips serving and those
  // gates skip cleanly. NOT taken from the unsigned GateTarget.config.
  serve?: ServeConfig;
  // A MULTI-SITE tenant's per-site serve+gate recipes, resolved server-side from PackConfig.sites
  // at gate-grant issuance and signed like every other field (each site's `serve.startCommand` is
  // a shell command). When present, the heavy stage (src/runner/serve-and-gate.ts) runs the
  // URL-bound gates once per site instead of once for `serve`, naming each site's checks
  // `<gate> (<name>)`. Absent -> the single-`serve` path runs unchanged. Takes precedence over
  // `serve` when both are set.
  sites?: SiteConfig[];
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
  // The git identity every pipeline commit a CODING stage (build/fix) pushes is authored and
  // committed under -- Autopilot's OWN bot, resolved server-side from the control plane (never
  // the customer's runner.yml), so the identity of its own App bot isn't a leaky per-customer
  // config. Signed like every other field: a tampered committer fails verifyGrant. The runner
  // reads them only on the coding path (action.yml's vendor `bot_name`/`bot_id` and the
  // deterministic "Commit and push" step's `git config user.*`); other stages ignore them.
  // `committerEmail` is the GitHub noreply form `<id>+<name>@users.noreply.github.com`, whose
  // numeric `<id>` prefix the runner derives into the vendor Action's `bot_id`. Absent on a
  // legacy grant -> the runner falls back to `github-actions[bot]`, valid anywhere and never
  // `claude[bot]`.
  committerName?: string;
  committerEmail?: string;
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

// One line of the architect's ALREADY-SATISFIED checklist: a distinct deliverable CLASS of the
// ticket, checked against the checked-out base tree on its own.
//
// A CLASS is a KIND of change, never an instance of one. That distinction is the whole point:
// TEK-3782's ticket enumerated 1,476 individual findings (121 over-long titles, 50 images with no
// alt text, 39 orphan pages, ...) across five classes, and the architect planned 13 subtasks to
// redo work that was already merged -- it read the enumeration as the work list and never checked
// the five CLASSES against the tree. One global "is this whole ticket satisfied?" judgment is
// unanswerable at that scale; five per-class ones are each trivially answerable.
//
// `verdict` is deliberately three-valued and only the literal 'present' counts as done, so the
// checklist can also express the honest middle -- a class the architect could not confirm. Both
// 'absent' and 'unsure' mean "plan it": a needless build is cheap, a wrongly-closed ticket is not.
export interface DeliverableClassVerdict {
  // The class in the ticket's own vocabulary, e.g. "meta descriptions over the length cap".
  class: string;
  verdict: 'present' | 'absent' | 'unsure';
  // Why -- for 'present', the concrete repository PATHS that implement the class (files with their
  // extensions, lines and symbols where useful); otherwise what was looked for and not found.
  // Carried verbatim onto the ticket, so a close nobody watched is auditable per class rather than
  // as one unfalsifiable paragraph. A path is what the gates actually require of a 'present' row --
  // see coverage.ts evidenceHasRepoAnchor -- so this says "paths", not "paths or symbols": a bare
  // symbol name reads as evidence to a human but is not something the gate accepts, and a contract
  // that promises more than the code honours is how a correct close gets escalated to a person.
  evidence: string;
}

export interface StageResult {
  outcome: StageOutcome;
  checks: CheckResult[];
  prUrl?: string;
  logDigest: string;
  // When `outcome` is 'error', WHY -- so the control plane can tell a TERMINAL abandon
  // ('timeout'/'workflow-drift'/'run-not-found': block the ticket and cancel the run) from a
  // TRANSIENT poll blip on a still-healthy, in-deadline run ('transient': a dropped fetch / 5xx /
  // secondary rate-limit -- keep inFlight, re-poll the SAME run next tick, escalate only after
  // repeated blips, and NEVER cancel the run). Absent for non-error outcomes and for other error
  // sites (a completed run that failed to yield its artifact), which are treated as terminal.
  // 'no-verdict-clean-run' is a distinct sub-case of that last kind: the agent RAN cleanly
  // (is_error:false, in budget, conclusion 'success') but wrote no verdict artifact -- an
  // infra/agent-behavior flake, not a content verdict, so the caller can retry it separately
  // and message it honestly rather than surfacing a content-less failure.
  errorReason?: 'timeout' | 'workflow-drift' | 'run-not-found' | 'transient' | 'no-verdict-clean-run';
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
  // Only an `architect` stage populates these, from plan.json's top-level `removals` /
  // `claims` arrays (parsed by parseArchitectPlanMeta). `removals` names the rendering
  // surfaces this plan deletes/hides in user terms; `claims` are the positive,
  // individually-verifiable assertions of what still renders and where. The control plane
  // gates on them (surface-removal HOLD, paired-preservation) and the primary reviewer
  // verifies each claim against the assembled branch. Absent for every other stage.
  removals?: string[];
  claims?: string[];
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
  // The architect's ALREADY-SATISFIED verdict (plan.json's `satisfied` string), present only when
  // it emitted an empty plan because the ticket's deliverables ALREADY exist on the base tree.
  // Carries the evidence (the files that implement it) so the completion is auditable, never a
  // bare assertion. Distinct from `hold`: that one stops for a human, this one finishes the ticket.
  satisfied?: string;
  // Only an `architect` stage populates this, from plan.json's top-level `deliverableClasses`: the
  // per-class ALREADY-SATISFIED checklist behind the plan (or behind `satisfied`). Optional because
  // the MODEL may simply not emit the field -- a permanent possibility, not a rollout window (the
  // prompt asking for it rides in the grant, and the parse happens control-plane-side).
  //
  // An EMPTY checklist is not one behaviour, it is two, and the difference is the ticket's own
  // shape. Without a `DELIVERABLES:` line there is nothing deterministic to check, so a `satisfied`
  // close falls back to #328's whole-ticket judgment and the ticket goes `done`. WITH one, every
  // enumerated deliverable is unaccounted for, so the close is refused, re-architected twice, and
  // escalated. That asymmetry is deliberate -- an enumerated ticket must not close on zero per-class
  // evidence -- but it means a model that stopped emitting this field would cost three architect
  // runs and a human per genuinely-satisfied enumerated ticket, so the control plane counts every
  // empty checklist on the notify channel BEFORE the gates run, where it can see both populations.
  //
  // When present it is load-bearing twice over:
  //   - a `satisfied` close is REFUSED unless every verdict is 'present' (a close the architect
  //     itself contradicts is not a close), and
  //   - the 'present' classes are fed to the coverage gates as ACCOUNTED-FOR, like `removals`, so a
  //     plan covering only the REMAINING classes of a partly-landed ticket is not rejected as a
  //     scope-drop and re-planned into the full rebuild it just avoided -- capped at one deliverable
  //     per row, so no single row can account for a whole ticket.
  classVerdicts?: DeliverableClassVerdict[];
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
  // The check-run id VCSHost.publishCheck returned for this stage's `pending` progress
  // publish, so the LATER publish that reports this stage's pass/fail can PATCH that same
  // check-run instead of POSTing a second one that never transitions out of `in_progress`
  // (the create-only publishCheck bug -- see subtask-pipeline.ts's publishStageProgress).
  // Absent when the pending publish failed, wasn't attempted, or predates this field.
  checkRunId?: number;
}

// What a replan preserves about an old subtask it discarded, until the NEW plan exists and
// can be compared against it. `id` is positional and can be reused by a later plan, so the
// tracker-owned id identifies the exact old child page that may need retiring.
export interface ReplanLeftover {
  id: string;
  branch?: string;
  externalId?: string;
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
  // Consecutive ticks this subtask's gate stage returned an INFRA `error` (timeout /
  // workflow-drift / run-not-found) instead of a real pass/fail verdict. Such a run yields
  // no checks, so it must never enter the fix loop (an empty findings prompt that burns the
  // fix budget and escalates as a false "fix loop exhausted"). The pipeline re-dispatches the
  // gate while this is under `fix.maxBuildRetries` -- the same bounded transient-retry idiom
  // the build stage uses -- and escalates as an infra block only once the fault persists past
  // it. Cleared the moment a gate produces a genuine pass/fail verdict.
  gateErrorAttempts?: number;
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
  // The REAL per-gate checks this subtask's gate stage produced (each carrying its true
  // pass/fail and, for a `skip`, the `skipped` flag + reason). Captured when the gate passed so
  // the ticket-level promotion can bank coverage from what actually RAN rather than a config-
  // derived stand-in -- a gate that skipped every subtask is then correctly excluded from
  // coverage. Absent until a gate stage completed. Not persisted long-term meaning: overwritten
  // each gate pass.
  lastGateChecks?: RecordedGateCheck[];
  // The PR head sha the last PASSING gate ran against. Set only alongside lastGateChecks, so
  // its presence already implies "that gate passed". Used to tell a head that has genuinely
  // moved (rebuild, fix push, update-branch merge commit -- all of which MUST be re-gated)
  // from a merge that simply could not complete this tick on the identical revision, where a
  // re-gate can only reproduce the verdict it already has. Absent -> unknown -> always gate.
  lastGateHeadSha?: string;
}

// One gate's REAL executed result on a promotion, distilled from the gate stage's CheckResult:
// its id, the published CheckStatus, and -- crucially -- whether it `skip`ped (never ran) and why.
// Coverage is banked only from non-skipped results, so a gate that perpetually skips can no longer
// be mistaken for a pass (the exact hole that let a never-run `layout-rules` be flipped to blocking).
export interface RecordedGateCheck {
  id: string;
  status: CheckStatus;
  skipped?: true;
  skipReason?: string;
  // The bare gate id when `id` carries a per-site display suffix (e.g. id `seo-site-crawl (tekunda)`,
  // baseId `seo-site-crawl`). The never-run/no-baseline ledger keys off this so a multi-site tenant's
  // URL-bound gates match the enabled-gate set instead of skipping the diagnostic entirely. Absent
  // (== `id`) for a single-run gate.
  baseId?: string;
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
  // The architect plan's positive preservation claims (plan.json `claims`): what still
  // renders and where, each individually verifiable. Persisted when the plan is accepted
  // (dispatchArchitect) and forwarded into the assembled-branch primary reviewer, which
  // verifies each against the built code -- an unmet claim is a blocking `PLAN NOT KEPT`
  // finding. Undefined for a plan that declared none.
  planClaims?: string[];
  // The rendering surfaces the architect plan deletes/hides (plan.json `removals`), in user
  // terms. Persisted alongside planClaims for the record; each removal must carry a paired
  // preservation claim (the deterministic preservation gate) and, under
  // gates.holdOnRenderingSurfaceRemoval, a non-empty set HOLDs the plan for human sign-off.
  // Undefined for a plan that removes nothing.
  planRemovals?: string[];
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
  // The same bound, on its OWN counter, for conflicts between the BASE branch and this ticket's
  // own branch (the cycle-start refresh, pr-ops.ts refreshTicketBranchFromBase). Deliberately not
  // shared with conflictFixAttempts above: that budget is spent by rollup/promotion/external-PR
  // conflicts, and a ticket that had already spent it would block on its FIRST branch conflict
  // having dispatched no fix for it at all, while the blocked reason read as though it had tried.
  // Different branch, different conflict, different budget.
  branchConflictFixAttempts?: number;
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
  // The gate/check coverage recorded when THIS ticket's promotion merged onto `branch` (the
  // P6 guardrail, docs/ci-gate-refit-plan.md §7). `gateIds` is the set of gate ids and customer
  // checks that gated the promotion; the next promotion onto the same branch (any of the
  // tenant's tickets) diffs against the most recently recorded set to catch silent coverage
  // loss. Keyed by branch because coverage is a per-protected-branch property, not per-ticket.
  promotionCoverage?: { branch: string; gateIds: string[]; recordedAt: string };
  // The REAL per-gate execution recorded from THIS ticket's most recent promotion attempt --
  // aggregated across the subtasks' gate stages (a gate that ran non-skip on ANY subtask counts as
  // run; one that skipped every subtask stays a skip). recordPromotionCoverage feeds these true
  // statuses into the coverage set instead of the config-derived `coverageGateResults()` stand-in,
  // so a perpetual-skip gate is no longer banked as false coverage. Absent for promotions recorded
  // before this existed (coverage then falls back to the stand-in). Keyed by branch like
  // promotionCoverage, since coverage is a per-protected-branch property.
  lastGateExecution?: { branch: string; results: RecordedGateCheck[]; recordedAt: string };
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
  // How many times QA was auto-retried after a CLEAN run wrote no verdict (plan.json missing)
  // -- an infra/agent-behavior flake, not a content defect. Kept SEPARATE from
  // externalQaFixAttempts so a flake never eats the content fix-loop budget; capped at 1, then
  // the drive falls through to a terminal fail that names the real cause. Reset on a real verdict.
  qaNoVerdictRetries?: number;
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
  // The user-visible removals gate #1b is CURRENTLY asking a human to sign off on -- exactly what
  // the outstanding hold callout names. Short-lived and QUESTION-scoped: written when that hold is
  // raised, and consumed the moment the human answers it (promoted into approvedRemovals below, or
  // dropped). Every hold overwrites it -- including holds raised by other gates -- so an unanswered
  // question can never leave a record behind for some later, unrelated answer to satisfy. Absent
  // when no surface-removal hold is open.
  heldRemovals?: string[];
  // The user-visible surfaces a human has AUTHORIZED deleting. Durable, and deliberately NOT
  // cleared by a replan.
  //
  // This is the correction to the mistake that made TEK-3745 loop four times in three hours. The
  // sign-off had been treated as PLAN-scoped, living only in the ticket's transient description, so
  // every re-read of the spec dropped it: when the fix loop exhausted and the ticket auto-replanned
  // (freshRestart re-reads the tracker, which never carried the answer), the approval vanished and
  // the byte-identical hold came back at a reviewer who had already answered it -- three times over.
  //
  // An approval is a fact about a SURFACE, not about a plan: "deleting the loading placeholder is
  // fine" does not stop being true because the architect re-planned. So it survives the replan, and
  // the safety property lives in the BINDING instead -- a removal is covered only when it names a
  // surface already in this list (removalCoveredByHeld), so a plan proposing a DIFFERENT surface
  // still holds for its own sign-off. Only a human answer ever adds to it (never a machine resume),
  // and every entry records a decision a person made after being shown that exact surface.
  approvedRemovals?: string[];
  // Consecutive ticks the tracker has reported this known, decomposed, non-terminal ticket
  // at the ready status (the structure-drift signal). The replan/continue hold fires only on
  // the SECOND consecutive sighting: one sighting is indistinguishable from our own status
  // write not being indexed yet, and holding a live ticket over that would wedge delivery.
  readyDriftTicks?: number;
  // Consecutive ticks the tracker has reported this known, BLOCKED ticket at the ready status
  // (the re-queue-on-status-move signal -- the PO moving a held ticket back to the front door to
  // resume it). Deliberately SEPARATE from readyDriftTicks: the structure-drift path never
  // touches this field, so a live ticket that accrued a readyDriftTicks count and THEN blocked
  // cannot carry that count into the blocked branch and resume on its first blocked sighting.
  // Like the drift counter, the resume fires only on the SECOND consecutive sighting: the
  // reconciler writes the blocked status onto the tracker at the end of the tick, and until that
  // indexes a just-blocked ticket still reads ready here -- resuming on that echo would re-drive
  // work the moment it legitimately blocked. Cleared by the resume (recoverBlockedOnReply /
  // freshRestart) so each blocked episode starts its sighting history fresh.
  blockedReadyTicks?: number;
  // ARMS the ready-status re-open: set when completeAsSatisfied finished this ticket WITHOUT a
  // build (the architect judged every deliverable already present on the base and emitted an empty
  // plan) AND all three arming conditions held, because each one is what makes re-opening on a
  // status move safe rather than destructive:
  //   1. the ticket has never shipped (see everShipped) -- otherwise a board tidy-up could re-drive
  //      merged, possibly deployed work, which is the whole hazard this feature must not create;
  //   2. its one automatic re-open is unspent (see satisfiedReopens) -- the bound on close ->
  //      re-open -> close cycling, each round of which costs a paid architect run;
  //   3. the close's own `done` write to the tracker LANDED -- if it did not, the page is still
  //      sitting at the ready status because of OUR failed write, and every later "it reads ready"
  //      observation would be our own echo rather than a person disagreeing.
  // Cleared by the re-open (freshRestart / recoverDoneOnRedrive), so it can never survive into a
  // later normal completion. It deliberately survives the mirror giving up on one unclaimed
  // gesture (see humanStatusEdit): the episode is closed when the page is repaired, so a LATER
  // move gets its own full grace window rather than inheriting an expired one, and there is no
  // longer any reason to spend the whole escape hatch on the first move nobody happened to
  // consume. MAX_SATISFIED_REOPENS still bounds what the gesture can cost.
  satisfiedWithoutBuild?: boolean;
  // Consecutive ticks the tracker has reported an ARMED ticket back at the ready status (the
  // disagree-with-the-auto-close signal), counted from the ready query AND from the per-page
  // bypass read that covers tickets the query hides. Deliberately SEPARATE from blockedReadyTicks
  // and readyDriftTicks for the reason those two are separate from each other: a count accrued in
  // one state must never let another state's branch act on its first own sighting. Two consecutive
  // sightings are necessary but NOT sufficient here -- unlike the blocked resume, the re-open costs
  // a whole fresh architect run on a ticket that already closed, so it is additionally confirmed
  // against the page's own status property before it fires (see handleReadySighting).
  satisfiedReadyTicks?: number;
  // The OPEN human-status-edit episode: a person moved this ticket on the tracker board to a
  // status the store disagrees with, and the reconciler's mirror has decided not to silently
  // overwrite them (see human-status-edit.ts and the mirror sweep in reconciler.ts).
  //
  // This generalises what shipped as `satisfiedDriftSince` for exactly one slice of the problem (a
  // ready-status move on a completed-without-a-build ticket). The bug was never specific to that
  // slice: the mirror reads the page DIRECTLY, so it sees a human's edit within a tick, while every
  // path that could honour the edit reads the ready QUERY, which lags page writes by minutes. The
  // mirror therefore reverted the person before anything could consume them -- for ANY status, on
  // ANY ticket, with no comment and no notification. Two mechanisms for one rule would have left
  // the general case broken, so there is one.
  //
  // It is an EPISODE, not a flag, because both halves of its identity matter:
  //   - `status`/`storeStatus` are the disagreement itself. A drift whose pair still matches this
  //     record is the SAME episode, so the explanatory comment is posted once per episode rather
  //     than once per 60s tick (the same anti-spam discipline as `lastNotice`). A different pair is
  //     a NEW gesture by the person and deserves its own answer.
  //   - `since` bounds the tolerance. "Don't overwrite them" must never become "the board and the
  //     store disagree forever", so a move nothing consumed within HUMAN_EDIT_GRACE_MS is repaired
  //     -- with the explanation, never silently.
  // Matching the pair also settles authorship WITHOUT re-reading it: once an episode is open, our
  // own later page writes (a PR-url stamp) would make this integration the page's last editor and
  // launder the person's move back into "our own dropped write".
  // CLOSED the moment the page and the store agree again -- by the sweep that repaired the page,
  // not by a later one observing the result. Everything after that repair is a fresh disagreement
  // and is answered like one, because the most natural reaction to a board that just snapped back
  // is to drag it again: a re-drag matches the stale pair exactly, so an episode left open would
  // hand it an already-expired `since` (no grace) and a spent `notified` (no comment) and revert it
  // in silence.
  humanStatusEdit?: {
    /** The status a person put on the tracker. */
    status: TicketStatus;
    /** The store status it contradicted -- the other half of the episode's identity. */
    storeStatus: TicketStatus;
    /** ISO 8601: when the mirror FIRST saw this episode. */
    since: string;
    /** Whether this episode's one explanatory comment has been posted. */
    notified?: boolean;
    /** Set when a drive-loop path ACTED on the move (a resume, a re-open, a redrive): the store
     *  status changed BECAUSE of it, and the tracker page is now merely behind. Without it the
     *  mirror would find a ready page against a freshly-`building` store, re-derive "a human moved
     *  this and it cannot take effect", and explain to the person that the gesture they just
     *  successfully used had failed -- while the honouring path's own comment sat right above it.
     *  With it, the repair is silent, because that repair IS our own write catching up. It grants
     *  silence, so it lives exactly as long as the episode does and no longer -- retired with the
     *  repair, never available to a move made afterwards. */
    honoured?: boolean;
  };
  // The explanatory human-status-edit comment's RATE LIMIT for this ticket: how many have been
  // posted inside the window that opened at `windowStartedAt` (MAX_HUMAN_EDIT_NOTICES per
  // HUMAN_EDIT_NOTICE_WINDOW_MS).
  //
  // Episode dedupe alone cannot stop a tracker AUTOMATION that re-applies the same status every few
  // minutes -- an episode closes as soon as the page and store agree again, so each flip -> repair
  // -> flip round opens a genuinely new one -- and answering each would bury the ticket's real
  // conversation under identical notices.
  //
  // A rolling window, and deliberately NOT the lifetime counter this was first written as. A
  // lifetime cap silences the ticket for good: the fourth genuine human edit, months later, from a
  // different person, would be reverted with no comment -- exactly the behaviour the mirror exists
  // to forbid, made permanent. The window bounds a fight without ever buying the right to be
  // silent again.
  humanStatusEditNotices?: { count: number; windowStartedAt: string };
  // How many times this ticket has been automatically re-opened by the ready-status gesture. It is
  // the loop guard, and like `autoReplans` it is deliberately NOT reset by a restart: a re-close
  // re-arms nothing once this reaches its bound, so close -> re-open -> close terminates instead of
  // spending a paid architect run every couple of ticks forever. The human still has "redrive",
  // which is not automatic and therefore cannot cycle.
  satisfiedReopens?: number;
  // Whether this ticket has EVER merged work. Durable, and deliberately never cleared: it is a fact
  // about the repository, not about the current plan.
  //
  // It exists because the restart paths destroy the evidence. freshRestart and recoverDoneOnRedrive
  // both wipe `subtasks` and `prs` and then re-enter the architect, so a ticket whose subtask PRs
  // merged and whose promotion deployed arrives at the next completeAsSatisfied looking exactly
  // like one that never built anything -- and would arm the ready-status re-open on genuinely
  // delivered work. Both paths therefore record the truth at the moment they wipe it (see
  // hasShippedWork), and the arming check reads THIS rather than the emptied state.
  everShipped?: boolean;
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
  // How many times this ticket has been auto-replanned -- shared across every gate that
  // consults it (gates.autoReplanOnExhaustedRepairs, gates.autoReplanBeforeEscalation), so a
  // ticket gets at most ONE auto-replan total regardless of which escalation reason trips it.
  // Deliberately NOT reset by freshRestart: it is the loop guard, and a counter the replan
  // clears would let a ticket replan forever, each round costing a full architect run plus a
  // rebuild of every subtask.
  autoReplans?: number;
  // Consecutive drive ticks whose only failure was a TRANSIENT infrastructure fault (a dropped
  // connection, timeout, 429, or 5xx -- see isTransientFault). Such a blip is not a ticket
  // defect: the next tick usually sails through, so the drive retries rather than escalating a
  // human on a network hiccup. Bounded: after MAX_TRANSIENT_FAILURES consecutive transient
  // ticks the fault is treated as a real outage and the ticket blocks for a human. Reset to
  // undefined on any successful drive tick, so intermittent blips never accumulate into a
  // false escalation.
  transientFailureCount?: number;
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
  // The head commit sha. Lets a caller tell "this is the exact revision we already gated"
  // from "the head moved", which is the difference between a wasted re-gate and a needed one.
  // Optional: an adapter that doesn't surface it omits it, and every consumer must treat
  // absent as "unknown", never as "unchanged" (the compareRefs discipline from #311).
  headSha?: string;
  // The PR's base branch name, used to discover the base branch's OWN required
  // status checks (branch protection + rulesets) so a merge can't push past a
  // gate the repo enforces. Optional; adapters that don't surface it omit it.
  baseRef?: string;
  // The sha of the merge commit once the PR is merged (GitHub's merge_commit_sha).
  // The host reports a PR merged a beat BEFORE it advances the base branch ref, so a
  // caller pinning work to the base head can catch the pre-merge revision; comparing
  // the base head against this confirms the merge has actually settled. Absent until
  // merged / when the adapter doesn't surface it.
  mergeCommitSha?: string;
}
