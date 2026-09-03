// v0 domain types for the Delivery Autopilot engine.
// Pure data shapes — no behavior. See AGENTS.md for the source of truth.

import type { BlockReason } from './block-reason.ts';

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

// How much review a diff has EARNED, classified deterministically from the changed-file list
// alone (gates/generic/risk-level.ts, shared verbatim with the `risk` gate so the two can never
// tell a tenant two different stories about the same diff):
//   'none'   -- nothing changed, or the change is entirely generated/binary artifacts.
//   'low'    -- prose and assets only (docs, markdown, images): no executable surface at all.
//   'medium' -- ordinary source/config change within the size threshold.
//   'high'   -- touches a high-risk path (CI workflows/actions) or is large enough that the
//               `risk` gate itself would flag it.
// Only 'none'/'low' ever REDUCE the lens set; 'high' additionally raises the primary reviewer's
// strictness. A diff that could not be read is classified by nobody -- the caller runs every
// lens instead (see VCSHost.listChangedFiles).
export type DiffRiskLevel = 'none' | 'low' | 'medium' | 'high';

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
  // findings at all severities, or an explicit all-clear), an aggregate line, and a summary
  // table carrying the file/line each finding names. Records a green round too, not just a
  // blocking one, so the review is auditable on the PR and not only via the check summary.
  // Per-tenant like every other gate field. Optional; defaults to TRUE (opt-out) -- a tenant
  // that reviews solely in the tracker sets it false to keep the bot off its PR conversation.
  //
  // The review SUMMARY only -- never an inline comment. GitHub turns an inline comment into an
  // unresolved review THREAD, and an unresolved thread is what holds the promotion merge, so
  // one opened under Autopilot's own identity wedges the promotion it is driving. See
  // publishFindingsToPr.
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
  // Which status check each MANAGED BASE BRANCH must still list as required, on the host itself
  // (branch protection or a repository ruleset). Keyed by branch name, e.g.
  // `{ test: ['qa'], main: ['qa'] }`.
  //
  // This is NOT `requiredChecks` above, and the two are not interchangeable. `requiredChecks` is
  // evaluated against a PR HEAD -- "did these checks pass on this commit". This one is evaluated
  // against the BRANCH's configuration -- "is the host still configured to demand them at all".
  // The plane merges through a GitHub App that is a ruleset BYPASS actor, so the host's own
  // enforcement is not what stops an ungated merge here; nothing does. Somebody editing a ruleset
  // and dropping the required check is therefore invisible by construction, which is exactly the
  // hole the retired watchdog-merge-liveness guard used to cover by RED-ing its run when `qa` was
  // missing from `repos/{owner}/{repo}/rules/branches/test`.
  //
  // Deliberately NOT defaulted to `{ test: ['qa'] }` or any other name: an unset entry makes the
  // detector inert for that branch (and it says so out loud), whereas a guessed default would hold
  // every merge for a brand-new tenant whose repo legitimately has no ruleset yet -- turning a
  // safety feature into a day-one wedge. A tenant opts in by naming its own branches and checks.
  // See control-plane/required-check-drift.ts.
  baseBranchRequiredChecks?: Record<string, string[]>;
  // Which of those branches the drift finding actually BLOCKS merging on. A branch named in
  // baseBranchRequiredChecks but NOT listed here is report-only: drift still raises the alarm, and
  // merges still go through.
  //
  // Same burn-in idiom, for the same reason, as `SECURITY_GATE_ENFORCED` and `E2E_REQUIRED_SITES`
  // in the Website pipeline: never flip a never-validated check straight to blocking. It matters
  // more here than usual, because a false positive does not fail one run -- it holds EVERY merge
  // onto that branch, indefinitely, and the ways to get one are mundane (a check actually named
  // `Autopilot / qa` written here as `qa`; a branch whose ruleset has not been created yet).
  //
  // It also contains the blast radius of an org policy. `resolveConfig` applies `orgPolicy` AFTER
  // `repoConfig` and replaces the whole map, so a tenant cannot clear an org-level
  // baseBranchRequiredChecks entry. With enforcement off by default, a mis-set org policy costs
  // one alarm per tenant per day instead of wedging every promotion in the fleet. An org that
  // deliberately mandates enforcement can still list branches here -- that is what an org policy
  // is for -- but it is then an explicit, reviewable act rather than a side effect.
  //
  // Empty/unset (the default) => report-only everywhere. See control-plane/required-check-drift.ts.
  baseBranchCheckEnforcedBranches?: string[];
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

// Where the runner gets the DETERMINISTIC PACK GATES, and how it proves the bytes are ours.
//
// The runner used to bundle them. It cannot any more: runner-dist/ is mirrored verbatim into
// the PUBLIC repo Tekunda/autopilot-runner, so every licensed pack file it copied was
// world-readable (src/packaging/build-runner-dist.ts). The pack gates now ship as a PRIVATE
// release asset the runner fetches per gate stage, and this is the whole of what the control
// plane tells it about that asset -- resolved server-side from the tenant's PackConfig and
// signed like every other grant field, so none of it can be swapped in transit.
//
// EVERY field here is load-bearing for the trust boundary:
//   - `url`   the exact asset. https only, except a loopback host (tests / self-hosted
//             mirrors); no redirect is followed, so the bearer token below reaches this
//             origin and no other.
//   - `sha256` the digest of the EXACT bytes, verified before anything is parsed, written,
//             or imported (src/runner/checksum.ts). It is what makes the fetch trustworthy at
//             all: the release host is not trusted, the SIGNATURE over this field is. A
//             mismatch fails the stage closed -- never "run without those gates", which would
//             bank a green verdict over gates that never executed.
//   - `token` a SHORT-LIVED, READ-ONLY credential for the private release, minted per grant.
//             It rides INSIDE the signed payload so it is bound to this tenant/ticket/stage
//             and cannot be lifted onto a forged grant. It is a secret VALUE, unlike
//             McpServerSpec.authEnvVar's env-var NAME -- the customer's CI has no credential
//             of ours to name, so there is nothing to reference. It must never be logged:
//             see src/runner/pack-bundle.ts, which keeps it out of every error string, and
//             note the residual exposure in docs/runbooks/purge-packs-from-public-runner.md
//             (a workflow_dispatch input is visible to anyone with read access to the run).
//   - `tokenExpiresAt` when the token dies. Checked runner-side BEFORE the fetch so an
//             expired token fails with its own message instead of an opaque 401.
export interface PackBundleGrant {
  url: string;
  sha256: string;
  token?: string;
  tokenExpiresAt?: string; // ISO 8601
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
  // and no code fix can resolve it -- so the fix loop never spends a fix round on one,
  // routing it by `unjudgedReason` (below) to either a bounded infra retry or a human.
  // Distinct from an ordinary `fail`: this is "could not judge",
  // not "judged and failed". `CheckStatus` stays a three-value union; this flag rides
  // alongside it.
  unjudged?: true;
  // When `unjudged`, WHY the gate reached no verdict -- it NEVER lets an unjudged pass, it only
  // routes escalation. 'infra': the check could not RUN -- the vision model stayed rate-limited/429
  // past its own backoff (visual-qa.ts), or a site's install/build/serve died on a transient fault
  // (serve-and-gate.ts's `heavy-serve`). Both are the same fact: no verdict, for a reason outside
  // the diff. Nothing downstream may assume the rate-limit case; quote the check's own message. No code edit clears a 429, so a `fix` stage
  // is useless, but a re-run might reach a verdict: the dispatch path re-runs the gate on the
  // shared `fix.maxBuildRetries` infra budget and the blocking fix loop grants one gate-only retry,
  // and only a fault outliving that reaches a human. 'content': the judge RAN but reached no
  // verdict about the page -- no re-run helps, so it escalates to a human immediately. Absent ->
  // treated as 'content' (fail closed, escalate now), which is LOAD-BEARING across the gate-report
  // artifact round-trip: parseGateReport must carry the reason or every unjudged reads as one
  // (TEK-3788).
  unjudgedReason?: 'infra' | 'content';
  // The gate NEVER RAN (returned `skip`) -- the complement of `unjudged`'s "ran, no verdict". It
  // publishes with `status:'pending'` (a skip was never evaluated, not passed), but a skip is not
  // the same as a not-yet-run pending: this flag makes the two distinguishable so a perpetual-skip
  // gate can't be banked as coverage. `skipReason` explains WHY it skipped, driving benign-vs-
  // suspicious escalation. `CheckStatus` stays a three-value union; these ride alongside it.
  skipped?: true;
  skipReason?: string;
  // The gate RAN and REPORTED, but banked no verdict (`warn`): either an explicitly report-only
  // gate that judged and found something, or the cve gate's staged rollout answering an audit it
  // could not perform on a newly-covered repo (no osv-scanner on this runner, a dependency layout
  // it cannot read). The third "not a pass" alongside `unjudged` and `skipped`, and the one that
  // was missing: a `warn` mapped straight to `status:'pass'` and carried no flag, so it published
  // GREEN and counted as a real verdict in the promotion ledger -- `gate_never_fired` suppressed
  // forever while nothing was audited. It publishes `status:'pending'` (nothing was judged) and
  // is carried to the host as a CONCLUDED check-run, never left in_progress: an honest state that
  // wedges a required context is just a different outage.
  // Distinct from `skipped` on purpose, because the ledger reads them differently: a skip is
  // excused by the gate's own history, and audit-outcome.ts refused `skip` for exactly that
  // reason. A report-only result is never banked as coverage and never stamps a real verdict.
  reportOnly?: true;
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
  // Which signing key signed this grant: grantKeyId() of the key's public half
  // (control-plane/grant-verify.ts). Part of the signed payload like everything else, so it
  // cannot be re-pointed at a different trusted key without breaking the signature -- and it is
  // a SELECTOR, not a credential: it says which key should check the signature, never that the
  // grant is authorized.
  //
  // Two things depend on it. Per-TENANT keys: every tenant's grants are signed with that
  // tenant's own key, so a grant that escaped one customer's logs cannot verify in another's
  // repository at all. And ROTATION: while a tenant's verify secret holds both the outgoing and
  // incoming public keys, the keyId picks the right one immediately, so a grant signed by a key
  // the repo was never given reports exactly that instead of a bare "invalid signature".
  // Absent on legacy grants, which still verify against every configured key.
  keyId?: string;
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
  // Where to fetch the deterministic PACK gates, and the sha256 that proves the bytes are
  // ours -- see PackBundleGrant. Present on a `gate` grant whose signed gateSpecs name a
  // pack gate id, resolved server-side from PackConfig.packBundle at issuance. Signed like
  // every other field, so neither the URL, the digest, nor the token can be swapped.
  //
  // Absent is NOT permission to skip: if a signed spec names a gate the runner cannot
  // instantiate and no bundle is here to supply it, the gate stage fails closed rather than
  // reporting green over a gate that never ran (run-gate-stage.ts).
  packBundle?: PackBundleGrant;
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
  // Which GENERATION of a stage this dispatch belongs to: a short, deterministic token the
  // issuer derives from the generation's own identity (for a review round, its pinned start
  // plus the lens -- see reviewRunToken), so every driver that re-issues the SAME grant on a
  // later tick derives the SAME token while a different round derives a different one. `jti`
  // cannot serve here: it is freshly minted per issuance, so a re-issued grant would never
  // match the run it dispatched.
  //
  // runner.yml puts it in the run-name, which is the ONLY channel by which a dispatched run can
  // identify its generation back to us. That is what makes correlation exact between two
  // overlapping control-plane revisions dispatching the same lens over the same sha: without
  // it their run-names are byte-identical and the older driver adopts (or consumes the verdict
  // of) the younger round's run.
  //
  // CORRELATION, NOT AUTHENTICATION. The grant is signed, but the run-name is not: it is
  // rendered from `inputs.grant` by the customer's own workflow, so anyone with `actions:write`
  // on the repo can dispatch a run naming any token they like, and an 8-hex token has a small
  // enough space to guess besides. It disambiguates HONEST runs; it never proves one. Every
  // path that acts on a token match still bounds the run in time and still checks the rest of
  // the name. Absent on a legacy grant, and absent from the run-name of a tenant whose deployed
  // runner.yml predates it -- correlation then falls back to the name plus the tokenless time
  // bound (TOKENLESS_ADOPTION_WINDOW_MS).
  runToken?: string;
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

// A fix stage's claim that a gate finding is itself wrong: the finding it will not act on, and
// the evidence for why acting on it would be wrong. A dispute is a TERMINAL outcome that changes
// nothing -- the fixer's only other exits were "produce a diff" and "fail", and being forced to
// produce a diff for a finding it could not legitimately satisfy is exactly what drove it to
// damage the artifact instead (TEK-3784). The control plane escalates a dispute to a human; it
// never resolves it in the content and never lets it pass silently.
export interface FixDispute {
  /** The gate finding being disputed, quoted from the fix prompt. */
  finding: string;
  /** Why the finding is wrong -- file:line and what the matched text actually is. */
  evidence: string;
}

// A change a fix round made to the ENCODING of the artifact rather than to the artifact. Both
// kinds are deterministic (see src/runner/fix-verdict.ts): 'rendered-no-op' is a line replaced by
// one that renders identically, and 'gratuitous-escape' is newly introduced entity escapes,
// invisible characters, or homoglyphs whose only effect is on what a source-text matcher sees.
export interface FixEvasion {
  kind: 'rendered-no-op' | 'gratuitous-escape';
  path: string;
  detail: string;
}

// A fix stage's own verdict on the round it just ran, computed runner-side in finalize and
// carried back on the fix-report artifact. Empty disputes + empty evasions + no scanError is the
// ordinary case: the round is judged by re-gating it, exactly as before.
export interface FixVerdict {
  disputes: FixDispute[];
  evasions: FixEvasion[];
  // Why the evasion scan could not run. A diff that could not be COMPUTED and a diff that is
  // genuinely EMPTY are different facts, and only one of them means "no evasion" -- so an
  // undecidable scan is reported here and escalated as unjudged rather than read as clean.
  scanError?: string;
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
  // Set only where the run above was RE-CORRELATED by name (the in-flight marker carried no run
  // id) and the listing offered MORE THAN ONE run under this stage's name inside the correlation
  // window: the run handed over is a pick between candidates, not the only run it could have
  // been. The review round's ingest guard tightens its own bound to TOKENLESS_ADOPTION_WINDOW_MS
  // only here -- a lone candidate is refused only on the two POSITIVE disproofs (it predates the
  // pin, or runTokenMismatch below), because re-refusing the lens's own late run on a bound alone
  // is what wedged the round. Absent everywhere else, including every marker-by-id poll (which
  // can only ever describe the run the marker names).
  competingRuns?: boolean;
  // Set only where the run above was RE-CORRELATED by name and that correlation is DISPROVED by
  // the listing it came from: the grant carried a runToken, the correlated run's name carries NO
  // token, and some OTHER run for this ticket+stage in the same listing does name a round --
  // which can only come from a runner.yml that renders the token. So the deployed workflow
  // renders tokens, this control plane always sends one, and a run of this name carrying none was
  // not dispatched by this round. The flagged run names no round at all; it is never a run naming
  // a DIFFERENT round, because matchesRun rejects those before anything can correlate to one, so
  // no message derived from this flag may claim otherwise. Unlike competingRuns this is positive
  // evidence rather than ambiguity, so the ingest guard refuses on it outright and needs no time
  // bound.
  //
  // Absent for every marker-by-id poll, and for a tenant whose runner.yml predates the token
  // (nothing in that listing names a round, so nothing disproves anything -- such a tenant is
  // still protected by the created-before-the-pin refusal, which is purely temporal, but not
  // against a foreign run that is merely late). The evidence itself carries no time bound, so a
  // runner.yml upgrade landing mid-round can set this on the round's OWN pre-upgrade run; see
  // ci-runner.ts's contradictsRunToken for why the sound bound was rejected and why the failure
  // is in the safe direction (an escalation, not a wrong verdict).
  runTokenMismatch?: boolean;
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
  // Only a `fix` stage populates this: what the round itself reported about its own work --
  // findings it disputes as false positives, and encoding-only changes it made that the runner
  // rejected as evasions. Downloaded by the CIRunner from the run's fix-report artifact. Absent
  // for every other stage, and for a fix run whose runner predates the artifact.
  fixVerdict?: FixVerdict;
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
  // Set only by a `fix` stage's finalize: what that round said about its own work. It rides on
  // the telemetry so action-entry can write it to the fix-report artifact -- the only channel a
  // dispatched run's structured result can travel back on (GitHub exposes no API for a
  // dispatched run's step outputs), the same one the gate stage's gate-report.json uses.
  fixVerdict?: FixVerdict;
  // Set by the gate stages: one human-readable line per toolchain detected in the PR checkout
  // (gates/stack-profile.ts describeStack) -- which ecosystems, which manifest files proved
  // each, which package/dependency manager. It rides the telemetry so it lands in the
  // gate-report.json artifact for EVERY tenant, which is what makes "the gates thought this
  // was a Yarn-classic Node repo" checkable after the fact instead of re-derived by hand.
  // Diagnostic only: it carries no verdict and nothing downstream branches on it.
  stack?: string[];
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

// One dispatched CI run's LIVENESS, read without a grant: has it finished, and what did it
// conclude. This is the fact the ghost-check-run sweep reconciles against (watchdog.ts) -- a
// check-run left `in_progress` by a run that has already finished is a ghost, and only the run
// itself can say so.
//
// The three answers are deliberately distinct and must stay that way. A reader resolving
// `undefined` means the outcome COULD NOT BE DETERMINED (transport error, run not found, rate
// limit); an object with `status !== 'completed'` means the run is GENUINELY still going; a
// completed run with `conclusion: null` is a host that finished without saying how. Only the
// middle one is "not finished yet". Collapsing "cannot determine" into a normal-looking value is
// exactly the flaw that made a `.catch` on VCSHost.aheadBy dead code (its `?? 0` already looked
// like "equal or behind"), so nothing here defaults.
// One published check-run as the host currently holds it -- the read half of
// VCSHost.publishCheck. Carries the NAME as well as the status because completing a check-run
// goes back through publishCheck, whose payload includes `name`: a caller that guessed the name
// from the stage would silently RENAME any run it guessed wrong.
export interface CheckRunSnapshot {
  status: 'queued' | 'in_progress' | 'completed';
  name: string;
}

// One check-run the host still holds OPEN (queued/in_progress) on a ref, as returned by
// VCSHost.listOpenCheckRuns. This is the discovery half of the ghost story: CheckRunSnapshot
// answers "is the check-run I remember still open?", which only works while something still
// remembers its id. Once the marker carrying that id is gone the check-run is unreachable by id
// and can only be found by ASKING the ref what is still open on it -- which is what this is for.
export interface OpenCheckRun {
  id: number;
  name: string;
  // When the host says the check-run started (ISO). The orphan sweep's age bound is anchored
  // here, so a host that does not report one gives the sweep nothing to measure and the
  // check-run is left alone rather than retired on an unmeasured age.
  startedAt?: string;
  // The check-run's details link. Autopilot stamps its own stage runs with the backing workflow
  // run's URL (subtask-pipeline runUrl), so this is how an orphan -- whose marker, and with it
  // its runId, is gone -- can still be traced back to the run behind it.
  detailsUrl?: string;
  // The id of the GitHub App that created this check-run. The orphan sweep retires check-runs
  // only when this matches the app it authenticates as, so it can never conclude another app's
  // check even if a name collided.
  appId?: number;
}

export interface RunLiveness {
  status: 'queued' | 'in_progress' | 'completed';
  // GitHub's run conclusion once `status` is 'completed' ('success' | 'failure' | 'cancelled' |
  // 'skipped' | 'timed_out' | 'neutral' | ...). null while the run is unfinished, and also on a
  // completed run the host reported without one -- which is indeterminate, never a pass.
  conclusion: string | null;
  // When the run finished (ISO), when the host reports it. The ghost sweep's grace period is
  // anchored HERE so the drive loop gets its own chances to publish the real verdict first, and
  // there is no substitute anchor: absent (or unparseable) means the sweep cannot measure that
  // window at all, so it leaves the check-run pending and surfaces it rather than acting on a
  // window it never measured. Optional only because a host may not report one.
  completedAt?: string;
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
  // For an `origin: 'feedback'` marker: the review threads this fix was dispatched to address.
  // Review-thread items are no longer identified by the feedback CURSOR (an unresolved thread
  // re-drives a fix until it is resolved or the round budget runs out -- see
  // handleReviewFeedback), so the completion path cannot rebuild its acknowledgment set from a
  // cursor bound the way it still can for review summaries and top-level comments. This is that
  // set, recorded at dispatch. Absent on legacy markers, where the cursor bound is still used.
  feedbackThreadIds?: string[];
  // ...and the PR head sha when it was dispatched. Resolving a review thread is a claim about the
  // FINDING ("this no longer applies"), and a fix stage exiting clean only proves the STAGE
  // passed -- a fixer that misread the comment and changed nothing exits clean too, and the
  // reviewer is a bot that will not re-open what we resolved. This is the cheapest piece of real
  // evidence available at the boundary: the head moved, so something was actually pushed. Absent
  // on legacy markers and when the host could not answer, both of which read as "no evidence".
  feedbackHeadSha?: string;
  // The check-run id VCSHost.publishCheck returned for this stage's `pending` progress
  // publish, so the LATER publish that reports this stage's pass/fail can PATCH that same
  // check-run instead of POSTing a second one that never transitions out of `in_progress`
  // (the create-only publishCheck bug -- see subtask-pipeline.ts's publishStageProgress).
  // Absent when the pending publish failed, wasn't attempted, or predates this field.
  checkRunId?: number;
}

// The WRITE-AHEAD record of a stage dispatch: persisted BEFORE the paid `workflow_dispatch`
// that launches it, and replaced by the `inFlight` marker the moment that launch is recorded.
//
// It exists for exactly one window. dispatchStage spends the customer's Actions minutes and
// model budget the instant the CI host picks the run up; everything that REMEMBERS the launch
// (the notify, the progress publish, the store write that sets `inFlight`) happens after it
// returns. A crash in between -- a container killed mid rolling-deploy, an OOM, a lost CAS race
// on the state file -- leaves the launch REAL and the record ABSENT, so the next tick sees no
// `inFlight`, falls through, and bills a SECOND run on the customer's key. The grant ledger sees
// that duplicate and, by design, does not stop it (grant-ledger.ts's header: detection only).
//
// So the intent is written first and outlives the crash: a tick that finds one with no `inFlight`
// must ADOPT the run it may already have launched (correlating it by the same run-name facts
// checkStage uses) rather than dispatch again -- and where no run can be found it BLOCKS rather
// than re-dispatching on a guess. Never two sources of truth: the intent is cleared in the same
// write that sets `inFlight`, so at most one of the two is ever set for a given stage.
export interface DispatchIntent {
  // The stage about to be launched. An intent for a DIFFERENT stage than the one now being
  // dispatched belongs to another of the ticket's lanes; it is stood aside for while its owner
  // can still adopt it, and dropped once nobody can -- never adopted here.
  stage: Stage;
  // The ticket this intent was written for, so a record that was copied/merged from elsewhere
  // (a restored backup, a mis-keyed write) can be recognized as foreign instead of adopted.
  ticketId: string;
  // WHICH lane wrote it, mirroring InFlightStage.origin -- because `stage` alone does not say.
  // Four lanes dispatch stage `fix` on one ticket (external-PR QA autofix, promotion customer-CI
  // autofix, review feedback, conflict resolve) and all four record the ticket's single `inFlight`
  // slot; they are told apart by exactly this. Adopting another lane's run would bind this lane's
  // bookkeeping -- its attempt counter, its feedback cursor, its check-run -- to a run launched to
  // do something else. Absent for the ticket-level stage lane (architect/enrich/plan/accept/
  // review), whose marker carries no origin either.
  origin?: InFlightStage['origin'];
  // ...and WHICH episode of that lane, where one lane runs more than one. The conflict lane has
  // two per ticket -- a PR target and a branch target -- with separate attempt budgets and
  // separate published checks, told apart everywhere else by TicketState.branchConflictTarget.
  // Without it recorded here the two are indistinguishable (same stage, same origin, neither
  // pinning a sha) and whichever episode ticks first would adopt the other's run: charging the
  // wrong counter and publishing `Autopilot / conflict` about a merge that run never touched.
  // Absent for every lane that has exactly one episode.
  target?: string;
  // The UNITS this generation launched, where a generation is more than one run. Only the assembled
  // review round has any: it scales its lens set to the diff's risk (selectReviewLenses) and pins
  // the chosen set on the round, because a later tick that recomputed a different set would wait on
  // a lens the round never dispatched. The rebuild IS such a later tick, and it cannot recompute:
  // assessDiffRisk fails OPEN by design (an unreadable diff reduces nothing), so a GitHub blip on
  // the recovery tick would resurrect a two-lens round as a three-lens one and bill the reviewer
  // the risk gate had just declined. Recorded here instead, so the rebuild reproduces the round it
  // is recovering rather than the round today's compare call happens to describe.
  lenses?: ReviewLens[];
  // The grant this dispatch was about to spend -- grantLedgerId(grant), i.e. the signed `jti`,
  // falling back to the sig digest on a legacy grant. AUDIT only, never the adoption key: every
  // tick re-issues a fresh grant with a fresh jti, so the run that survived the crash was
  // launched under a jti no later tick will ever hold again. What correlates the run is the
  // run-name (stage + shortId), exactly as it does for an `inFlight` marker with no runId yet.
  jti: string;
  // The pinned revision the dispatch was about to judge (grant.headSha), when the stage pins
  // one. An intent whose sha no longer matches belongs to a superseded revision: its run judges
  // a tree this tick is no longer asking about, so it is dropped rather than adopted.
  sha?: string;
  // When the intent was written, ISO-8601 and from the control plane's own clock -- always just
  // BEFORE the dispatch it guards. Doubles as the run-correlation lower bound (the run's
  // created_at can only be later) and as the anchor for the adoption window.
  dispatchedAt: string;
  // The grant's own expiry (ISO-8601). Past it the grant can no longer be spent, so an intent
  // that survived this long belongs to nothing that is still runnable -- it is dropped, which is
  // what keeps an abandoned intent from outliving the ticket that wrote it.
  expiresAt: string;
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
  //
  // Typed as BlockReason, not string: only `blockReason()` can mint one, so a writer cannot
  // record an empty or non-string explanation. See block-reason.ts.
  blockedReason?: BlockReason;
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
  // Set when THIS subtask was blocked by a gate VERDICT (findings), naming the gate
  // implementation that produced those findings. See GateBlockProvenance.
  gateBlock?: GateBlockProvenance;
}

// WHICH gate implementation produced the findings that blocked a subtask (and, rolled up, its
// ticket). Recorded at the moment a findings-based block is persisted.
//
// Nothing else in the state says this. A findings block reads identically whether the findings
// describe a real defect in the customer's code or a defect in the GATE, so fixing the gate could
// not release the tickets that gate had wrongly blocked -- they stayed blocked until a human
// noticed and nudged them by hand. TEK-3694 is the worked example: a subtask that added
// `content/site/README.md` tripped two gate defects (an SEO-pack rootDir that defaulted to
// process.cwd() and so read the action's own directory, and a markdown-to-route mapper that turned
// the README into the route `/site/README`), escalated as "no code fix can resolve", and stayed
// blocked after PR #336 removed both defects.
//
// This is the record recoverBlockedOnGateChange reasons over -- see blocked-recovery.ts.
export interface GateBlockProvenance {
  // The deployed gate/runner implementation version, as the control plane knew its OWN version at
  // block time (ControlPlaneConfig.gateVersion). ABSENT means the plane was never told its version,
  // which is "cannot determine", NOT "version zero": every consumer treats an absent version as
  // never-stale and never auto-resumes on it. The runner action and the control-plane image ship
  // from the same repo and the same commit (runner-dist/ is not committed -- CI builds it from
  // src/ and publishes it on every push to main), so a change to gate CODE always changes this
  // string. The
  // converse does not hold -- a control-plane-only deploy changes it too -- which is why the
  // re-evaluation is bounded to once per version rather than run as a loop.
  gateVersion?: string;
  // Which check produced which findings. The block REASON flattens all of them into one prose blob
  // for the human; this is the only structured record of the attribution, so a later reader can ask
  // "which gate blocked this" without parsing English.
  checks: { name: string; findings: string[] }[];
  recordedAt: string; // ISO 8601
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
  // The gate RAN but only REPORTED (`warn`) -- see CheckResult.reportOnly. Banks no coverage and
  // stamps no real verdict, so a gate whose every result is report-only still fires
  // `gate_never_fired` instead of looking like a gate that has judged this branch.
  reportOnly?: true;
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
  // round awaiting aggregation looks the same); only a FULL round start -- a fresh sha pin
  // building a brand-new round object -- writes without this counter and resets it. The
  // partial-completion path that finishes a round already in flight (control-plane.ts,
  // `round = {...round, pending: pendingAfter}`) deliberately PRESERVES it instead, since
  // that is the very streak this field bounds.
  missingAttempts?: number;
  // Consecutive ticks on which at least one lens's poll returned an EVIDENCED result this round
  // could not attribute to its own dispatch -- a refused result whose correlation had a competing
  // candidate (StageResult.competingRuns) or was disproved by its own listing
  // (StageResult.runTokenMismatch) -- and no lens made progress (see
  // reviewResultBelongsToRound). The refusal is correct -- with two same-named runs in the
  // window, an unproven correlation may be judging a revision this round never pinned -- but
  // repeating it is not progress: the marker is left untouched, so the next tick re-polls the
  // same run and refuses it again, forever. Nothing else ends that loop: the drive stamps
  // lastEventAt every tick before the review path runs (driveDecomposedTicket), so
  // `ticket_wedged` never sees a round that only refuses -- only this counter can END it. At
  // MAX_FOREIGN_RESULT_TICKS the ticket blocks with the last refused run id as evidence.
  // Reset by any tick on which a lens settles OR reports `running` past the ingest guard: a
  // round still watching its own reviewers is advancing, whatever else its siblings polled.
  // A refusal the adapter could not evidence never counts here at all -- checkStage's own
  // run-not-found/timeout escalation is what ends that one.
  foreignResultTicks?: number;
  // The lens set this round actually DISPATCHED, pinned at round start alongside the sha.
  //
  // It must be persisted, not recomputed: the set is derived from the diff (see riskLevel), the
  // diff moves whenever the base or the integration branch does, and a later tick that
  // recomputed a SMALLER set would wait forever on a lens it no longer expects -- or, worse,
  // aggregate a round while a dispatched lens's verdict is still outstanding. Pinning the sha
  // and pinning the lens set are the same guarantee at two scopes. Absent on rounds persisted
  // before this field (and on any round whose diff could not be read): fall back to the
  // configured set, which is the conservative direction.
  lenses?: ReviewLens[];
  // Why that set: the diff's risk level and the human-readable justification behind it, carried
  // so the aggregate check can SAY why a docs-only PR got one reviewer instead of leaving a
  // customer to infer it. Recorded even when every lens ran.
  riskLevel?: DiffRiskLevel;
  riskReasons?: string[];
}

export interface TicketState {
  tenantId: string;
  repoId: string;
  ticketId: string;
  title?: string;
  description?: string;
  status: TicketStatus;
  subtasks: SubtaskState[];
  // The WRITE-AHEAD record of this ticket's subtask fan-out -- the DispatchIntent story (above)
  // for the one family that cannot carry a per-lane intent.
  //
  // A decomposed drive launches its subtasks through `Promise.allSettled` and persists what they
  // launched ONCE, afterwards, so every subtask shares that single write: a crash between a
  // `dispatchStage` inside the fan-out and that write loses EVERY marker the tick would have
  // recorded, not one. Worse, five of the pipeline's re-dispatches hand the runner
  // `adoptSince: now()` (subtask-pipeline.ts), which floors adoption at THIS instant and so
  // positively refuses the orphan the crash left running -- the duplicate is guaranteed, not
  // merely possible, and a fan-out's worth of model sessions is billed twice.
  //
  // Which subtask launched what is deliberately NOT recorded, because it cannot be known before
  // the fan-out (a drive decides its stage from a probe it has not made yet) and does not need to
  // be: this is a GENERATION instant, and the CI host's own run listing is the ground truth about
  // what it launched. Re-dispatching under the same instant makes the adapter adopt whatever run
  // is already there (DispatchStageOptions.adoptSince) and start one only where there is nothing
  // to adopt -- both halves of the crash, one path.
  //
  // Written before the fan-out and cleared by the write that records what it launched, so its
  // presence at the top of a tick IS the crash signature. Only useful while the adapter can still
  // adopt against it (TOKENLESS_ADOPTION_WINDOW_MS); past that the pipeline falls back to `now()`,
  // because a stale floor would let a re-dispatch adopt the very run it just cancelled.
  subtaskDispatchIntentAt?: string;
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
  // The areas the TICKET ITSELF declares out of scope, parsed out of the spec text
  // (control-plane/coverage.ts parseTicketExclusions) whenever the architect reads the
  // description, and forwarded into the assembled-branch PRIMARY reviewer.
  //
  // NOT `reviewSummary.outOfScope`, and never to be conflated with it: that one is a review
  // OUTPUT -- the architect's own plain-language note about what its plan deliberately does not
  // do. This is ticket INPUT: the human's declared off-limits areas, which are the contract.
  //
  // It VOIDS plan claims. A claim that could only be kept, restored, or verified by changing an
  // excluded area gets NO finding at all -- not a downgraded one -- because the ticket outranks
  // the plan. TEK-3766 burned three repair rounds on a `PLAN NOT KEPT` blocker demanding blog
  // changes the ticket itself had declared out of scope. Undefined for a ticket that declares
  // no exclusions (then the reviewer prompt is byte-identical to what it was before this field
  // existed).
  ticketExclusions?: string[];
  // How many times the assembled review (acceptance walk, now the three-lens review
  // round) found the branch UNMET and the control plane dispatched a repair build before
  // re-reviewing. Bounds the review -> repair -> re-review self-heal so a
  // genuinely-unbuildable ticket blocks for a human instead of looping.
  acceptRepairAttempts?: number;
  // Highest PR review/comment ids the control plane has already acted on, per source, so
  // corrective feedback (a Codex or human `changes_requested`/comment) drives a fix exactly
  // once. Persisted so a control-plane restart doesn't re-fix already-handled feedback.
  feedbackCursor?: { reviewId: number; commentId: number; threadCommentId?: number };
  // How many `fix` stages the review-feedback lane has run for this ticket. The cursor above
  // bounds each ITEM to one fix, but nothing bounded the item COUNT: a reviewer (or a bot) that
  // keeps commenting drove unbounded fix rounds forever, with no cap and no escalation -- alone
  // among the fix lanes, every one of which spends fix.maxFixRounds and then blocks
  // (resolveConflict, the external-PR lane, the promotion CI lane, fix-loop.ts). Counted when a
  // dispatched feedback fix TERMINATES, pass or fail -- never while one is in flight, so a
  // multi-minute run can't burn the budget one tick at a time.
  //
  // NEVER reset, unlike conflictFixAttempts -- this is a whole-lifetime budget for the ticket's
  // promotion PR, and deliberately so. (An earlier version of this comment claimed a reset "when
  // the ticket's promotion merges, alongside conflictFixAttempts", which never existed in code
  // and could not: conflictFixAttempts is reset at the ROLLUP merge, which happens BEFORE the
  // promotion PR is even opened, and the promotion merge is the ticket's terminal event -- this
  // lane never runs again after it, so a reset there would bound nothing at all.)
  //
  // The consequence is real and intended: two rounds spent on an early nit leave fewer for a P1
  // that arrives hours later, and the ticket then blocks for a human. That is the honest end
  // state -- the fixer has had its rounds on this PR and a finding still stands -- and the knob
  // for "a reviewer-heavy PR needs more rounds" is fix.maxFixRounds, not a reset that would let
  // an unfixable finding loop forever by re-earning its budget.
  feedbackFixAttempts?: number;
  // How many times a `fix` stage has been dispatched to auto-resolve a merge conflict on
  // this ticket's PR. Bounds the conflict self-heal so a genuinely unresolvable conflict
  // blocks for a human instead of looping. Reset once the PR merges.
  conflictFixAttempts?: number;
  // The same bound, on its OWN counter, for conflicts between the BASE branch and one of this
  // ticket's own branches (the per-cycle refresh, pr-ops.ts refreshBranchFromBase). Deliberately
  // not shared with conflictFixAttempts above: that budget is spent by rollup/promotion/external-PR
  // conflicts, and a ticket that had already spent it would block on its FIRST branch conflict
  // having dispatched no fix for it at all, while the blocked reason read as though it had tried.
  // Different branch, different conflict, different budget.
  //
  // Scoped to ONE conflict EPISODE on ONE branch, named by branchConflictTarget below -- not to
  // the ticket's lifetime. That distinction is load-bearing now that two branches (ticket and
  // integration) are refreshed and both route their conflicts here. A lifetime counter would be
  // spent by SUCCESSES: resolveConflict increments once per terminated fix run, pass or fail
  // (review-feedback.ts), so three conflicts that each resolved cleanly leave it at
  // fix.maxFixRounds having never blocked the ticket -- and the next conflict, on either branch,
  // returns 'exhausted' immediately and blocks with "could not be auto-resolved" having
  // dispatched nothing. That is verbatim the failure this counter was split off to prevent, so
  // the episode reset below is what makes the split actually hold.
  branchConflictFixAttempts?: number;
  // Which branch the branchConflictFixAttempts episode above belongs to, so the budget is
  // per-episode rather than per-ticket-lifetime. Set when a branch conflict is first acted on,
  // cleared when THAT branch comes back clean (the episode ended). A conflict on a different
  // branch starts a fresh episode with a fresh budget.
  //
  // It must be the branch, not merely "a branch conflict happened": the ticket lane refreshes
  // first and is usually clean, so a reset keyed on any clean refresh would zero the count every
  // tick while the integration lane was mid-episode, and that lane's conflict fix would loop
  // unbounded. Also identifies WHICH branch an in-flight `origin: 'conflict'` marker belongs to,
  // which is otherwise unrecorded -- with two branch lanes live, the ticket lane would otherwise
  // adopt and finalize the integration lane's run, charging an attempt and publishing its check
  // against a ref that run never touched.
  branchConflictTarget?: string;
  // The open FRESHNESS-HOLD episode on one of this ticket's branches: how many consecutive drive
  // cycles the freshness hold (control-plane.ts, holdOnStaleBranch) stopped the lane WITHOUT
  // dispatching anything, tallied per reason.
  //
  // The hold has two such outcomes, and both are the right DIRECTION -- neither ever lets a build,
  // a gate or a review judge a tree that could not be confirmed current -- but both were unbounded
  // until this existed:
  //   * `unknown`: the host could not say whether the branch is behind the base (an API fault, a
  //     ref that vanished). Nothing is dispatched, so nothing can ever escalate on its own.
  //   * `refused`: a real conflict was found but the AI-run budget refused the conflict fix, with
  //     no side effects. No attempt is consumed, so `exhausted` -- the conflict path's own
  //     escalation -- is unreachable by construction.
  // Either way the drive holds, refreshes lastEventAt (so the wedge alarm sees a live ticket) and
  // posts its pause notice once: a permanently unreadable host or a permanently refused budget
  // parked the ticket silently forever. A quiet stall rather than a visible block.
  //
  // ONE record, not two counters: one field to clear in every recovery reset, which is the wiring
  // an extra counter would have needed in each of them to avoid becoming the silently-stuck one.
  // Tallied per KIND because they are different operational problems and the escalation has to say
  // which -- and because a single count would never reach any cap under a host fault and a refused
  // budget alternating tick by tick, each resetting the other's streak.
  //
  // Keyed by `branch` for exactly the reason branchConflictTarget is: the ticket lane refreshes
  // first, so a record cleared on any clean refresh would be zeroed every tick while the
  // integration lane was mid-episode. Only the named branch's own clean refresh clears it.
  branchFreshnessHolds?: { branch: string; unknown?: number; refused?: number };
  // The blocked-branch freshness sweep's OWN copy of the two budgets above, for the branch it
  // names (control-plane.ts, refreshBlockedTicketBranches).
  //
  // Why a separate record instead of just spending branchConflictFixAttempts /
  // branchFreshnessHolds directly: those two fields are read by checkDependencyWake's `spent`
  // predicate, which FAILS CLOSED -- a ticket with any budget at its cap is never auto-woken when
  // the sibling it is `blocked by` finally ships. The sweep runs on tickets that are already
  // blocked, including ones blocked purely on a dependency, so spending the shared counters there
  // would drive them to the cap on a ticket whose block a wake was going to answer, and that
  // ticket would then never wake -- a permanent strand caused by a lane that is only supposed to
  // keep a branch mergeable. The sweep therefore SEEDS the shared fields from this record before
  // it calls the shared machinery and RESTORES them afterwards, so the machinery is reused
  // unchanged while the spend lands here, where no recovery predicate reads it.
  //
  // `fixInFlight` marks a conflict-fix run THIS lane dispatched: it is what makes the seeding
  // safe, because a ticket-level marker the sweep does not own must never be adopted (polling
  // another lane's run charges the wrong budget and publishes a check against a ref that run never
  // touched). `retiredAt`/`retiredCause` stop the sweep on a branch it cannot fix; a `conflict`
  // retirement is evidence about the BRANCH and stands until a human recovery clears it, while
  // `unknown` (host unreadable) and `refused` (tenant at its run cap) are evidence about the host
  // or the tenant and EXPIRE -- an expiry that also zeroes that cause's count, or the branch comes
  // back already at the cap and fires a false escalation on every check forever. Cleared by every
  // recovery reset, exactly like the two fields above.
  blockedBranchRefresh?: {
    branch: string;
    conflictAttempts?: number;
    unknownHolds?: number;
    refusedHolds?: number;
    fixInFlight?: boolean;
    retiredAt?: string;
    retiredCause?: 'conflict' | 'unknown' | 'refused';
  };
  // Consecutive ticks the rollup PR's merge has stayed `pending` (behind, not ready, or a
  // benign race that keeps recurring). Bounds the deferral so a merge error that never
  // clears escalates for a human instead of parking silently forever. Reset once the
  // rollup merges.
  rollupPendingTicks?: number;
  // Consecutive ticks the promotion PR has been WITHHELD because opening it would have
  // stacked an open rollup PR under it (the stacked-PR invariant, promote.ts
  // findStackedPrConflict). Transient by construction -- the rollup merges and the next tick
  // opens the promotion PR -- so the drive defers rather than blocking; this bounds that
  // deferral on the same MAX_REVIEW_ATTEMPTS budget the rollup-merge deferral uses, so a
  // conflict that never clears escalates with the verbatim reason instead of looping
  // silently. Deliberately NOT `rollupPendingTicks`: that one is reset every tick the rollup
  // has landed, which is exactly when this deferral fires. Cleared once the promotion PR
  // opens, and by the blocked-recovery re-drive like every other capped counter.
  promotionStackedTicks?: number;
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
  //
  // Typed as BlockReason, not string: only `blockReason()` can mint one, so a writer cannot
  // record an empty or non-string explanation. See block-reason.ts.
  blockedReason?: BlockReason;
  /**
   * Whether the block recorded in `blockedReason` is PERMANENT: a deterministic refusal that
   * retrying cannot change. Set alongside `blockedReason` by whichever writer establishes the fact;
   * cleared by every resume, exactly like `blockedReason` itself.
   *
   * WHY THIS IS A FIELD AND NOT A PHRASE. On 2026-09-02 an owner replied "try again" on a ticket
   * blocked by a GitHub 403 refusing to merge a stacked PR synchronously. The resume re-drove it,
   * the merge was retried eight times over three minutes, and it re-blocked with the byte-identical
   * refusal -- because nothing in the state said "this answer will not change". Retrying a
   * deterministic refusal can only reproduce it.
   *
   * The obvious fix -- match the reason text -- is the wrong one, and the audit names it as a root
   * cause: several recovery lanes already select on English prefixes (`entitlement:`, `budget: repo`,
   * `review not met`), which makes every reason string load-bearing, invisible to the compiler, and
   * broken by rewording. So permanence is recorded as a STRUCTURED FACT, decided where the host's
   * answer is actually in hand, and read as a boolean by the lane that must not re-drive.
   *
   * WHO SETS IT. Any writer that blocks a ticket on an answer it knows to be deterministic. The
   * merge path is the first: `permanentHostRefusal(err)` (contracts/adapters.ts) classifies a host
   * refusal, and a merge that returns `{ outcome: 'blocked', reason }` for one records
   * `blockPermanent: true` beside the reason it carries verbatim. Nothing infers it from text, here
   * or anywhere.
   *
   * WHO READS IT. `recoverBlockedOnReply`: a reply on a permanently-blocked ticket answers with what
   * is actually needed instead of re-driving. An unset field means "not known to be permanent" and
   * behaves exactly as before -- the safe direction, since the cost of a wrong `true` is a resume
   * that has to be asked for twice.
   */
  blockPermanent?: true;
  /**
   * A resume this ticket is still owed an OUTCOME report for: WHO asked for it, and what it was
   * resuming to do.
   *
   * It exists because "resumed" and "finished" are different events and only the first was ever
   * visible: the three-minute retry above ran entirely through the host API, so no Actions run
   * fired, nothing appeared on the PR, and the re-block was deduped against the block it repeated.
   * From the owner's seat their reply was ignored. A resume that reports its outcome cannot look
   * ignored, even when the outcome is "the same refusal, eight times".
   *
   * `by` is PROVENANCE, and it is load-bearing rather than bookkeeping. Most resumes on this system
   * are automatic -- an auto-replan when a repair budget runs out, a gate-version re-validation, a
   * dependency wake -- and an outcome report that says "your reply resumed this ticket" on one of
   * those is a lie told on the customer's board about something they never did. Only a resume a
   * PERSON asked for is owed this report; the automatic lanes narrate themselves at the moment they
   * fire and have nothing further to answer for.
   *
   * Absent means no report is owed, which is the state every automatic resume leaves behind.
   */
  resumeAwaitingOutcome?: { by: 'reply' | 'board-move'; intent: string };
  // Times the watchdog has nudged a stalled QA/fixer stage back to life without
  // the stage making progress. Not literally "consecutive": the watchdog only
  // observes status at its own tick boundaries, so a ticket that round-trips
  // `reviewing -> fixing -> reviewing` entirely between two watchdog passes
  // keeps its streak across the round trip, and reviewing's next stall counts
  // on top of it. The escalation this bounds is still honest about what it
  // names -- reviewing really did reach that count -- which is the property
  // that matters. Bounds the stall re-arm loop (watchdog.ts MAX_STALL_RECOVERIES)
  // so a genuinely dead runner is escalated to a human instead of being
  // re-armed forever. Counted per STAGE: it is reset once the ticket's status
  // moves to a different stage (see stallStage below).
  stallRecoveries?: number;
  // The stage the streak above was counted in -- stamped on every nudge, and read
  // only together with the count. A stall streak is a claim about ONE stage, and
  // three of the statuses a stalled ticket can hold are stallable, so `building ->
  // reviewing` is a real stage advance that leaves the status stallable: without
  // this stamp the count rides across the advance and the new stage's FIRST stall
  // escalates on a number that stage never reached -- a message the board shows a
  // customer that is false, and a force-block on a ticket that is making progress.
  // Absent means no streak is running (the count is absent too) -- except for one
  // sweep right after this field was introduced: rows persisted earlier with
  // stallRecoveries set and no stallStage read as `undefined !== status` on their
  // first pass and have their streak dropped once. Benign one-time rollout grace,
  // not a wedge.
  stallStage?: TicketStatus;
  // A dispatched ticket-level CI stage (architect/enrich/plan/accept, or a repair build)
  // awaiting completion. When set, the next drive CHECKS it (non-blocking) instead of
  // dispatching; cleared when it completes. Makes the ticket-level judgment/accept paths
  // per-tick state machines (see InFlightStage).
  inFlight?: InFlightStage;
  // The write-ahead record of a ticket-level dispatch that is ABOUT to be launched, covering the
  // crash window between spending the customer's money and recording that it was spent. Set only
  // between those two points; the write that sets `inFlight` clears it in the same operation, so
  // the two are never both live for one stage. See DispatchIntent.
  dispatchIntent?: DispatchIntent;
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
  // Set when this ticket blocked BECAUSE one or more of its subtasks was blocked by a gate
  // VERDICT: the provenance rolled up from those subtasks' own `gateBlock` records. Present only
  // while the ticket is blocked for that reason -- every resume clears it, so a re-block always
  // stamps a fresh record rather than inheriting a stale one. `gateVersion` is carried only when
  // every contributing subtask agrees on it; disagreement (subtasks blocked either side of a gate
  // deploy) is "cannot determine" and leaves it absent, which never auto-resumes.
  // See GateBlockProvenance and recoverBlockedOnGateChange.
  gateBlock?: GateBlockProvenance;
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
  // The two lanes SCOPE it differently: in the external-PR lane it is head-scoped (a new head
  // resets it -- see externalQaExhaustedSha below), while in the promotion lane it is
  // ticket-lifetime and never reset, so a promotion ticket that spends it stays spent.
  externalQaFixAttempts?: number;
  // How many times QA was auto-retried after a CLEAN run wrote no verdict (plan.json missing)
  // -- an infra/agent-behavior flake, not a content defect. Kept SEPARATE from
  // externalQaFixAttempts so a flake never eats the content fix-loop budget; capped at 1, then
  // the drive falls through to a terminal fail that names the real cause. Reset on a real verdict.
  qaNoVerdictRetries?: number;
  // How many consecutive dispatches the model PROVIDER refused before any model ran (a
  // rate/usage limit on the agent credential -- classified runner-side, see
  // runner/provider-rejection.ts). Counts the `fix` autofix AND the `accept` QA run that gates the
  // same PR, on one counter rather than two, because it is one fact about one credential: whether
  // the provider is refusing this ticket's dispatches right now. The observed incident interleaved
  // them -- external-pr-1534 was refused once as QA and three times as autofix inside 52 minutes
  // -- so a per-lane counter would have granted each lane its own free retry and still billed the
  // PR for the rest. Kept SEPARATE from externalQaFixAttempts for the same reason
  // qaNoVerdictRetries is: a request that never reached a model repaired nothing, so charging it
  // to the content fix-loop budget spends repair rounds on attempts nobody made and then reports
  // the PR as unfixable.
  //
  // ONE free re-dispatch per streak, then the drive falls through to ordinary accounting -- a
  // sustained outage still reaches a terminal state rather than re-dispatching forever, it just
  // does not pay for the first refusal. Reset ONLY by a fix run that actually reached a model:
  // resetting on every consume (including a rejected run past the cap) made the counter oscillate
  // 1,0,1,0... and charged every SECOND rejection, which is a half-fix wearing a cap's name.
  providerRejectionRetries?: number;
  // The PR head sha the EXHAUSTED external-QA budget above was charged against, stamped once
  // the budget is spent. externalQaFixAttempts only ratchets up, so without this a PR that
  // spent it was terminal forever: every later tick re-stamped the same qa=fail without
  // running QA, even after the author pushed exactly what the gate asked for. A head that no
  // longer matches this sha is somebody else's push -- new work, and it gets a fresh budget.
  // Only meaningful while the budget is spent; the reset clears it.
  externalQaExhaustedSha?: string;
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
  // How many times the live review round has been DISCARDED because the assembled branch's head
  // moved under it (control-plane.ts, the head-move guard in driveAssembledAccept).
  //
  // Restarting is the correct response to a moved head -- the revision the reviewers were judging
  // is no longer the one that would land -- but nothing counted the restarts, so a branch whose
  // head keeps moving restarted forever. It is invisible to BOTH alarms: the wedge alarm keys on
  // lastEventAt, which the restart itself refreshes (the restarts ARE activity), and the drift
  // alarm keys on how far behind the base a branch is, which a moving head does not affect. Each
  // restart cancels three superseded reviewer runs and dispatches three more, so the ticket burns
  // review runs while looking busy.
  //
  // Lives on the TICKET, not on ReviewRoundState, because the restart is exactly the event that
  // discards the round: a count on the round would die with it. And it is not
  // ReviewRoundState.missingAttempts under another name -- that streak is reset only by a FULL
  // round start, never by the partial-completion continuation, which deliberately preserves it.
  // But a restart wipes reviewRound to `undefined` (the head-move guard above), so there is
  // nothing left for the next tick to continue: the round it starts is necessarily a FULL one, and
  // missingAttempts can never accumulate here. Reset when a round actually reaches AGGREGATION
  // (green or blocking): the episode this bounds is "rounds that never produce a verdict", and a
  // round that produced one ends it.
  reviewRestarts?: number;
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
  // The base-advance re-validation this ticket's CURRENT findings block has already spent (see
  // recoverBlockedOnBaseAdvance). A findings block is a verdict about a TREE, and the only party
  // that can re-judge it is the gate -- so the re-validation IS a re-gate, and it has to be paid
  // for exactly once per base state or it becomes an unbounded blocked -> re-gate -> blocked loop.
  //
  //   `baseSha` -- the base branch head the last re-validation was spent against. The lane refuses
  //     to spend a second one while the base is still at that sha: the tree would be the same tree
  //     and the gate would reach the same verdict, so the second run is pure burn. A ticket that
  //     fails re-validation therefore costs ONE re-gate per genuine base advance, never one per
  //     tick and never one per sweep.
  //   `attempts` -- how many have been spent in total, ever, on this block. Capped
  //     (MAX_BASE_ADVANCE_REVALIDATIONS) so a busy base branch, which advances constantly, cannot
  //     buy an unbounded number of re-gates for a ticket whose finding is simply real.
  //
  // Deliberately survives the lane's own `auto` resume (that is what makes the cap a cap), and is
  // cleared only by a HUMAN resume -- a person answering a blocked ticket renews its budgets, the
  // same trade acceptRepairAttempts makes. Absent means no re-validation has ever been spent,
  // which is a KNOWN zero, not an unknown.
  blockRevalidation?: { baseSha: string; attempts: number };
  // The tree the ticket's CURRENT findings block was actually judged on: the branch the assembled
  // reviewers were pointed at, and the exact sha that was pinned into their grants. Written by both
  // writers of a `review not met` block (control-plane.ts -- the async driveAssembledAccept path and
  // the inline blocking-review fallback), each of which already HOLDS that sha (it is the one it
  // signed the review grants against) and used to discard it.
  //
  // recoverBlockedOnBaseAdvance exists to ask whether those findings are still true of the code as
  // it stands, and it used to answer by measuring the branch HEAD, on the premise that a blocked
  // ticket drives nothing so the head is still the judged revision. That premise does not hold:
  // refreshBlockedTicketBranches merges the base INTO `integration/<stem>` for blocked tickets with
  // an open PR -- the same ref, on the same population. After that fold-in `aheadBy(head, base)`
  // reads 0, which is the arm that asserts "the finding still describes the tree that would be
  // judged now" -- exactly backwards, because the head now carries base commits the reviewers never
  // saw. A sha pinned at block time is a FACT rather than a premise: it stays correct however many
  // other lanes move the branch afterwards.
  //
  // `branch` rides with the sha because the branch name is derived from the ticket TITLE, so a
  // retitled ticket resolves to a different stem. A pin naming some OTHER branch says nothing about
  // the one being measured and is ignored rather than trusted -- the same rule blockedBranchRefresh
  // already follows, and the reason a rename cannot make this field lie.
  //
  // Provenance about ONE block, never a budget. Cleared on every resume path exactly like
  // `gateBlock`, and unlike `blockRevalidation` above it has no reason to survive the lane's own
  // `auto` resume: a ticket that re-blocks is re-pinned by the writer that blocks it. Absent means
  // the block recorded no pin -- it predates this field, or the writer's own head read failed -- and
  // the lane then falls back to the branch head, from which it will conclude `advanced` but never
  // `unmoved`. Never `unmoved` UNCONDITIONALLY, not merely while `blockedBranchRefresh` is set:
  // that record is deleted whenever the branch comes back clean, so its absence is not evidence
  // that nothing folded the base in.
  blockJudgedTree?: { branch: string; sha: string };
}

// The ticketId prefix for an external-PR pseudo-ticket (see TicketState.externalPr). Such
// entries live in the same StateStore as real tickets but are driven by driveExternalPr and
// must be skipped by anything that assumes a backing TaskBackend ticket (the tracker poll,
// the reconciler's merged-PR/status sweeps).
export const EXTERNAL_PR_PREFIX = 'external-pr-';

export function isExternalPrTicket(ticketId: string): boolean {
  return ticketId.startsWith(EXTERNAL_PR_PREFIX);
}

// Whether two "owner/repo" slugs name the SAME repository. The one place any comparison between
// a CONFIGURED repoId and a HOST-supplied one is decided.
//
// A repoId reaches the plane verbatim from tenant config (the tenant-store entry), spelled
// however whoever wrote that entry spelled it -- `tekunda/website`. Nothing normalizes it. GitHub
// answers with the repository's own CANONICAL casing: `Tekunda/Website` in `head.repo.full_name`
// (OpenPR.headRepo) and in the runner's GITHUB_REPOSITORY. A GitHub slug is case-insensitively
// unique -- those two cannot be different repositories -- so `===` across that seam is not a
// stricter check, it is a WRONG one, and it fails SILENTLY in both directions: the external-PR
// sweep reads every same-repo PR as a fork and adopts nothing, and a legitimate grant reads as
// executing in the wrong repository. Comparisons between two values that came from the SAME side
// of the seam (a stored ticket's repoId against the tenant's, a fake's own key) need nothing from
// here and use `===`.
export function sameRepoId(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

// Clock slack between the control plane and the CI host: a dispatched run's `created_at` is
// GitHub's clock, not ours, and the listing itself lags the dispatch by a beat. Every lower
// bound on "was this run created for THIS generation" reaches back this far.
export const RUN_CORRELATION_SLACK_MS = 5_000;

// UPPER bound on the same question, and ONLY for a run-name that carries no run token: how
// long after a GENERATION started one of its own tokenless dispatches may still land.
//
// Sized on the drive loop, not on a guess: a round dispatches its lenses within one tick, and
// a partial fan-out is completed on the NEXT tick of the same round, so two tick intervals
// (DEFAULT_TICK_INTERVAL_MS, 60s in src/main.ts and src/service/main.ts) covers every dispatch
// a round legitimately makes for itself, plus a tick of slack. Everything past it is a LATER
// generation -- and it has to be tighter than the overlap it defends against: the 2026-09-02
// incident's two control-plane revisions pinned their rounds 274s apart, so the 5 minutes this
// bound used to be still let the orphaned revision's driver adopt the live round's runs, which
// is the whole failure. A tenant whose runner.yml predates the run token gets ONLY this bound,
// so it is the one that has to hold.
//
// Only the GENERATION-anchored paths use it (adoption against a round's pinned start, and the
// review ingest guard where the correlation was CONTESTED -- StageResult.competingRuns). A path
// anchored on this driver's OWN dispatch has no such hazard above it -- its own run can be
// minutes late through a retried dispatch and CI-host lag -- and bounds itself by the stage
// timeout instead; so does the ingest guard when the adapter had only one candidate to hand it.
// A lone candidate is NOT proof of the round's own run -- the round's run can be missing from
// the listing entirely (a dispatch that degraded to a bare handle, or a run aged off the 20-run
// page) leaving somebody else's as the only one there -- so that path is bounded by the positive
// disproofs instead (StageResult.runTokenMismatch, and a created_at that predates the pin).
export const TOKENLESS_ADOPTION_WINDOW_MS = 2 * 60_000;

// How long a dispatched stage is given to finish before the runner calls it timed out -- the
// CIRunner's default, overridable per deployment (ci-runner's `config.timeoutMs`).
//
// It lives here, next to the other two correlation bounds, because it is not only the adapter's
// deadline: it is also the horizon past which a run can no longer be ADOPTED. correlationWindow
// bounds a token-proven adoption at `startedAt + timeoutMs`, and checkStage anchors its deadline
// on the run's own created_at, so a run older than this escalates as timed-out rather than being
// waited on. A control-plane lane whose recovery IS an adoption must therefore know the same
// number, or it gives up while the adapter would still have adopted -- so this is the DEFAULT and
// the deployment's effective value is threaded to the plane (ControlPlaneConfig.stageTimeoutMs),
// never assumed.
export const DEFAULT_STAGE_TIMEOUT_MS = 15 * 60 * 1000;

// ...and the value the HOSTED multi-tenant service actually runs with. Named here, beside the
// default it overrides, because two things have to agree on it and they live in different layers:
// the CIRunner it is passed to (its run-completion ceiling) and the control plane whose adoption
// horizon has to reach as far as that ceiling does. It was a bare literal in tenant-adapters.ts,
// which is how the two silently disagreed by 20 minutes -- long enough for the plane to block a
// human on runs the adapter would still have adopted for free.
//
// 35 minutes, not the 15-minute default, because the external-PR QA stage runs the customer
// repo's real install+build+validate, which can exceed 15 minutes on a cold build -- and a
// timed-out poll would drop a verdict the run actually produced, false-failing the PR. A higher
// ceiling only affects genuinely slow or hung stages; normal ticket stages complete when done,
// well under it. Stays below the 45-minute grant TTL.
export const HOSTED_STAGE_TIMEOUT_MS = 35 * 60 * 1000;

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
