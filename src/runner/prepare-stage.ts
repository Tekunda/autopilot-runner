// The thin runner's prepare phase: the only code that executes inside the customer's CI
// (AGENTS.md, "split plane"), before the coding-stage vendor Action step (a `uses:` step
// run separately in the runner workflow -- see action.yml) has done any work.
//
// Verifies the signed ExecutionGrant, then branches on stage kind:
//   - Judgment stages (enrich, plan, review): hand the signed prompt to the selected
//     vendor Action with read-only repository access, then let finalize map its conclusion
//     to telemetry.
//   - Coding stages (build, fix): there's real work for the vendor Action step to do, so
//     this computes the deterministic branch that step must push to (codingBranchName())
//     and translates the grant's prompt into that step's inputs via CodingExecutor.prepare(),
//     then leaves resolving the stage to finalizeCodingStage() (./finalize-stage.ts), run in
//     a later step once that Action has produced its own conclusion output. finalize
//     recomputes the same branch name from the grant and confirms it on the remote itself --
//     it never trusts the vendor step's own self-reported branch name (issue #113).

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CodingExecutor, VCSHost } from '../contracts/adapters.ts';
import { effortForTier, resolveModel } from '../config/model-tiers.ts';
import type { ExecutionGrant, Stage, StatusTelemetry } from '../contracts/types.ts';
import { slugify } from '../control-plane/branch-names.ts';
import { verifyGrant, type GrantEnvironment, type KeyInput } from '../control-plane/grant-verify.ts';
import { resolveBaseSha } from '../gates/git.ts';
import { buildMcpConfig } from './mcp-config.ts';
import { claimRejection, resolveClaimSha, tryClaimGrant, type ClaimEmitter } from './replay-claim.ts';

export interface PrepareStageDeps {
  codingExecutor: CodingExecutor;
  /** Customer repository's default branch, supplied by the runner workflow. */
  baseRef?: string;
  /** Public key(s) used to verify the grant's signature -- a list during a key rotation. */
  verifyKey: KeyInput | readonly KeyInput[];
  /**
   * The environment this run is executing in (repository slug, tenant), checked against the
   * grant's SIGNED tenantId/repoId. Read from the Actions env by action-entry.ts and threaded
   * here as data so verification stays pure. Absent -> unbound, the pre-GA behaviour where any
   * signed grant ran in any repository that trusted the same key.
   */
  environment?: GrantEnvironment;
  /**
   * The selected vendor Action's provider id (`claude-code` | `codex` | ...), used
   * to turn the grant's signed `modelTier` into a concrete model id for that
   * vendor's step. Absent -> no model is emitted and the vendor's own default
   * applies (which is exactly the tier-is-ignored behaviour this fixes).
   */
  executorProvider?: string;
  /** Customer-configured model id, which wins over the tier mapping. */
  configuredModel?: string;
  /**
   * The VCS host used to place the durable replay claim (src/runner/replay-claim.ts) before any
   * vendor step runs. Absent -> no claim is attempted (the pure prepare path, and any runner
   * install without git-refs write): the run proceeds exactly as before, without replay
   * prevention.
   */
  vcsHost?: VCSHost;
  /** Observability seam for the claim attempt; defaults to replay-claim's console/stdout emitter. */
  emitClaimEvent?: ClaimEmitter;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
}

export const CODING_STAGES: ReadonlySet<Stage> = new Set(['build', 'fix']);

// The least-privilege base tool allow-list keyed on the SIGNED grant stage (not the coarser
// PreparedStage kind, which collapses architect/accept/lensed-review into one). This is the
// deterministic choke point for what each stage's vendor agent may do:
//   - build/fix (coding): edits, commits, and pushes -- keeps the shell + Write. WebSearch/
//     WebFetch are dropped: the coding checkout is the one that keeps the push credential in
//     .git/config, so denying network egress removes the exfiltration channel there too.
//   - accept (external-PR QA): genuinely RUNS the repo's own gates, so it KEEPS Bash -- but
//     drops WebFetch/WebSearch (a gate run needs no outbound network).
//   - architect: reads the repo and Writes plan.json only. It concatenates attacker-
//     influenceable ticket text, so denying the shell (`cat .git/config`) and network egress
//     (WebFetch exfil) removes the credential-theft channel entirely -- the primary control.
//   - lensed review: read-only inspection that Writes a findings verdict to plan.json.
//   - review (lens-less) / enrich / plan: strictly read-only judgment.
function baseAllowedTools(grant: ExecutionGrant): string[] {
  if (CODING_STAGES.has(grant.stage)) return ['Bash', 'Edit', 'Read', 'Write', 'Glob', 'Grep'];
  if (grant.stage === 'accept') return ['Read', 'Glob', 'Grep', 'Write', 'Bash'];
  if (grant.stage === 'architect') return ['Read', 'Glob', 'Grep', 'Write'];
  if (grant.stage === 'review' && grant.reviewLens !== undefined) return ['Read', 'Glob', 'Grep', 'Write'];
  return ['Read', 'Glob', 'Grep'];
}

// v0 drives a single default branch; per-ticket base refs are future work.
export const DEFAULT_BASE_REF = 'main';

// `model`/`effort` carry the grant's signed modelTier through to the vendor Action
// step's own inputs (action.yml), which is what actually makes a "deep" build stage
// run on the deep model instead of the vendor's default.
// `mcpConfigPath`/`mcpAllowedTools` are set on every agent stage when the grant authorizes
// MCP: the path of the claude-code-action `--mcp-config` file this phase wrote (from the
// grant's signed server definitions) and the mcp tool names to add to the vendor step's
// `--allowedTools`. Absent when the grant carries no `mcp`.
// `debugFullOutput` mirrors the grant's signed `debugFullOutput` (DebugConfig.showFullOutput):
// true -> action.yml passes claude-code-action's own `show_full_output` input, revealing the
// raw SDK output for this run instead of the minimal result summary. Absent/false by default.
// `allowedTools` is the least-privilege vendor-agent tool allow-list for this stage, derived
// from the SIGNED grant stage (see baseAllowedTools) with any authorized MCP tool names
// appended. action.yml consumes it verbatim instead of a template-side stage-kind ternary, so
// the allow-list is deterministic and testable rather than a YAML expression a later edit
// could silently widen.
export type PreparedStage =
  | { kind: 'resolved'; telemetry: StatusTelemetry }
  | { kind: 'judgment'; repoId: string; baseRef: string; prompt: string; allowedTools: string; model?: string; effort?: string; mcpConfigPath?: string; mcpAllowedTools?: string[]; pluginMarketplaces?: string[]; plugins?: string[]; debugFullOutput?: true }
  | { kind: 'architect'; repoId: string; baseRef: string; prompt: string; allowedTools: string; model?: string; effort?: string; mcpConfigPath?: string; mcpAllowedTools?: string[]; pluginMarketplaces?: string[]; plugins?: string[]; debugFullOutput?: true }
  | { kind: 'coding'; repoId: string; baseRef: string; branchName: string; prompt: string; allowedTools: string; model?: string; effort?: string; mcpConfigPath?: string; mcpAllowedTools?: string[]; pluginMarketplaces?: string[]; plugins?: string[]; debugFullOutput?: true; committerName?: string; committerEmail?: string };

// A grant carries no id of its own -- its signature already uniquely
// fingerprints the issued grant, so hash it into a stable telemetry id.
export function grantId(grant: ExecutionGrant): string {
  return createHash('sha256').update(grant.sig).digest('hex');
}

export function digestFor(...parts: string[]): string {
  return `sha256:${createHash('sha256').update(parts.join(' ')).digest('hex')}`;
}

// The stable identity of the work a coding grant belongs to: the tenant's repo and the
// (sub)ticket being implemented, NOT the individual grant. Every rebuild of the same
// subtask hashes to the same suffix, so it reuses one branch instead of leaving a fresh
// `autopilot/<slug>-build-<newhash>` orphan behind on each attempt -- the accumulation
// the 2026-08-19 review found on the customer repo (three orphan build branches and a
// duplicate build PR for one ticket).
// The identity a build branch is keyed on. Deliberately NOT the grant and NOT the title:
// only (tenant, repo, subtask, stage). A replan reuses positional subtask ids, so a
// replanned subtask lands on this same key -- which is what lets the control plane
// recognize an old plan's branch as the new plan's own (control-plane.ts, replan
// reconciliation) instead of orphaning it.
function subtaskBranchKey(grant: BranchIdentity): string {
  return createHash('sha256')
    .update([grant.tenantId, grant.repoId, grant.ticketId, grant.stage].join('/'))
    .digest('hex');
}

// The branch a coding stage's vendor Action step must push its work to, computed
// deterministically from the grant alone so prepareStage() and finalizeCodingStage()
// (./finalize-stage.ts) -- separate processes sharing nothing but the grant -- always
// agree on it without either trusting the vendor step's own self-reported branch name,
// which claude-code-action leaves unset outside its entity-triggered auto-branch mode
// (issue #113). Prefers a readable slug of the ticket title over the opaque ticket
// UUID, with a short hash of the subtask's identity as a collision-proof suffix (two
// tickets can share a title).
// The fields codingBranchName actually reads. Narrower than ExecutionGrant so a caller that
// has no signed grant in hand (the control plane, deriving where a not-yet-built subtask
// WILL be built) can compute the same name without forging one. Real grants satisfy it.
export type BranchIdentity = Pick<ExecutionGrant, 'tenantId' | 'repoId' | 'ticketId' | 'stage'> &
  Partial<Pick<ExecutionGrant, 'ticketTitle' | 'baseBranch' | 'buildBranch'>>;

export function codingBranchName(grant: BranchIdentity): string {
  // A `fix` stage self-heals the PR already under test: it pushes its changes
  // onto that PR's existing head branch (carried as the grant's baseBranch by
  // the subtask pipeline) so the re-gate re-checks the same PR, rather than
  // deriving a fresh branch the gated PR never receives (a fix that lands
  // nowhere would exhaust the loop despite the agent doing real work). A
  // `build` stage always gets a fresh, per-grant branch to open its PR from.
  if (grant.stage === 'fix' && grant.baseBranch) return grant.baseBranch;
  // A build whose subtask was RENAMED by a replan continues its predecessor's branch (the
  // subtask identity below is unchanged by a rename, but the readable prefix isn't -- see
  // ExecutionGrant.buildBranch). Without this the rebuild pushes to the new name and the
  // work on the old one is orphaned despite being provably the same subtask's.
  if (grant.stage === 'build' && grant.buildBranch) return grant.buildBranch;
  const label = slugify(grant.ticketTitle ?? '') || slugify(grant.ticketId) || 'ticket';
  return `autopilot/${label}-${grant.stage}-${subtaskBranchKey(grant).slice(0, 8)}`;
}

// The identity half of a build branch produced by codingBranchName: the trailing hash of
// (tenant, repo, subtask id, stage). Everything before it is a readable title slug that a
// replan's rename moves; this part does not. Comparing two branches by it answers "same
// subtask?" independently of what the plan chose to call it.
export function branchIdentitySuffix(branch: string): string {
  return branch.slice(branch.lastIndexOf('-') + 1);
}

export function rejectedTelemetry(grant: ExecutionGrant, reason: string | undefined): StatusTelemetry {
  return {
    grantId: grantId(grant),
    result: 'error',
    checks: [],
    logDigest: `sha256:rejected-${reason ?? 'invalid grant'}`,
  };
}

// Verify the grant, then prepare the selected vendor Action step. A bad/expired grant is rejected before
// any adapter is touched.
export async function prepareStage(grant: ExecutionGrant, deps: PrepareStageDeps): Promise<PreparedStage> {
  const verification = verifyGrant(grant, deps.verifyKey, deps.now ?? new Date(), deps.environment);
  if (!verification.ok) {
    return { kind: 'resolved', telemetry: rejectedTelemetry(grant, verification.reason) };
  }

  const prompt = grant.stepPrompt ?? grant.ref ?? '';
  // The grant's server-set baseBranch (the ticket's integration branch) wins over
  // the runner workflow's repo-default baseRef, so subtask coding never bases on --
  // or opens a PR against -- the customer's live default branch.
  const baseBranch = grant.baseBranch ?? deps.baseRef ?? DEFAULT_BASE_REF;
  // A signed headSha (the Track E round's pinned revision; judgment stages only) IS the
  // revision to inspect: action.yml checks out `steps.prepare.outputs.base-ref` verbatim,
  // so folding the sha in here pins the vendor step's tree even if the branch moves under
  // the round -- three reviewers dispatched in parallel can never land on different heads.
  const baseRef = grant.headSha ?? baseBranch;

  // Durable replay claim: this is the FIRST runner step for the grant, so before any vendor step
  // (and before the MCP file this phase writes), atomically claim the grant against GitHub. A
  // replay -- the same signed grant re-dispatched into a fresh job within its TTL -- collides on
  // the claim ref and is rejected here, before any AI spend or push. A claim store that cannot
  // ANSWER now also rejects, after a bounded retry: a run that cannot prove it is not a replay
  // must not spend the customer's model credential (see replay-claim.ts's header for the trade).
  // Skipped entirely when no VCS host is supplied.
  if (deps.vcsHost) {
    const sha = await resolveClaimSha(grant, deps.vcsHost, baseBranch);
    const claim = await tryClaimGrant(grant, deps.vcsHost, sha, deps.emitClaimEvent);
    if (claim.status !== 'claimed' && claim.status !== 'unavailable') {
      return { kind: 'resolved', telemetry: rejectedTelemetry(grant, claimRejection(claim)) };
    }
  }

  // The grant's signed tier decides the model for this stage; a customer-configured
  // model still wins (BYO config is never overridden). An unmapped provider yields
  // undefined and the vendor's own default applies.
  const model = deps.executorProvider
    ? resolveModel(deps.executorProvider, grant.modelTier, deps.configuredModel)
    : deps.configuredModel;
  const effort = effortForTier(grant.modelTier);

  // The grant's signed MCP access, materialized for the vendor Action step: write the
  // `--mcp-config` file this stage runs with (from the signed server definitions -- only
  // ${ENV} placeholders, never a secret) and carry its path + tool allowlist through. Every
  // agent stage kind gets this spread. Absent -> nothing written and the step runs MCP-free.
  const mcpFields = ((): { mcpConfigPath?: string; mcpAllowedTools?: string[] } => {
    if (!grant.mcp) return {};
    const { json, allowedTools } = buildMcpConfig(grant.mcp);
    const path = join(tmpdir(), `autopilot-mcp-${grantId(grant).slice(0, 16)}.json`);
    writeFileSync(path, json);
    return { mcpConfigPath: path, mcpAllowedTools: allowedTools };
  })();

  // The grant's signed plugin access, carried straight through to the vendor step: unlike mcp
  // there's no file to write -- the marketplace URLs and plugin refs become claude-code-action's
  // `plugin_marketplaces`/`plugins` action inputs. Every agent stage kind gets this spread.
  const pluginFields = grant.plugins
    ? { pluginMarketplaces: grant.plugins.marketplaces, plugins: grant.plugins.plugins }
    : {};

  // The signed-grant-derived least-privilege allow-list, with any authorized MCP tool names
  // appended (same base-then-mcp order action.yml previously assembled inline). Emitted for
  // every agent stage kind and consumed verbatim by the vendor step's --allowedTools.
  const allowedTools = [...baseAllowedTools(grant), ...(mcpFields.mcpAllowedTools ?? [])].join(',');

  // The architect, accept, and lensed-review stages share one execution shape -- read-only
  // repo plus a single Write to the artifact file (plan.json), no branch and no PR. action.yml
  // gives the vendor step Write access (and uploads the artifact) on this kind, then finalize
  // maps its conclusion to telemetry like any other judgment stage. `accept` reuses the
  // architect plumbing deliberately: it checks out the ticket's assembled integration branch
  // (grant.baseBranch) and writes its verdict to plan.json. A Track E review grant carries a
  // signed reviewLens and routes here too -- each independent reviewer inspects the assembled
  // branch read-only and writes its findings verdict to the same plan.json artifact. Backward
  // compatibility: a lens-less `review` grant (the linear ticket pipeline's generic review)
  // falls through to the strictly read-only judgment profile below, exactly as before.
  const debugFields = grant.debugFullOutput ? { debugFullOutput: true as const } : {};

  if (grant.stage === 'architect' || grant.stage === 'accept' || (grant.stage === 'review' && grant.reviewLens !== undefined)) {
    return {
      kind: 'architect',
      repoId: grant.repoId,
      baseRef,
      prompt,
      allowedTools,
      ...(model ? { model } : {}),
      effort,
      ...mcpFields,
      ...pluginFields,
      ...debugFields,
    };
  }

  if (CODING_STAGES.has(grant.stage)) {
    const branchName = codingBranchName(grant);
    const prepared = await deps.codingExecutor.prepare({
      stage: grant.stage,
      prompt,
      repoId: grant.repoId,
      baseRef,
      branchName,
    });

    // The grant's signed committer identity (Autopilot's own bot), surfaced only here on the
    // coding path -- it drives action.yml's vendor `bot_name`/`bot_id` and the deterministic
    // "Commit and push" step's git identity, so no pushed pipeline commit is authored
    // claude[bot]. Absent on a legacy grant -> action.yml's non-claude default applies.
    const committerFields = grant.committerName && grant.committerEmail
      ? { committerName: grant.committerName, committerEmail: grant.committerEmail }
      : {};

    return {
      kind: 'coding',
      repoId: grant.repoId,
      baseRef,
      branchName,
      prompt: prepared.prompt,
      allowedTools,
      ...(model ? { model } : {}),
      effort,
      ...mcpFields,
      ...pluginFields,
      ...debugFields,
      ...committerFields,
    };
  }

  return {
    kind: 'judgment',
    repoId: grant.repoId,
    baseRef,
    prompt,
    allowedTools,
    ...(model ? { model } : {}),
    effort,
    ...mcpFields,
    ...pluginFields,
    ...debugFields,
  };
}

// The changed files a gate scopes over, computed IN THE RUNNER from its own checkout:
// fetch the base branch (best-effort -- a checkout without the base falls back to a local
// ref), then three-dot diff against HEAD. The control plane deliberately does NOT ship
// this list through the workflow_dispatch input: computing it here routes the data where
// the tree already lives and keeps the dispatch input small (every changed path would
// otherwise ride along, ~12KB for a large PR).
export async function computeChangedFiles(baseRef: string, cwd: string = process.cwd()): Promise<string[]> {
  const git = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });

  // Single source of truth for base resolution (shared with the assertion-delta gate).
  const base = await resolveBaseSha(baseRef, cwd);

  // A shallow checkout (actions/checkout defaults to depth 1) severs HEAD's ancestry, so a
  // three-dot diff has no merge-base and fails. The action's own checkout step sets
  // fetch-depth: 0; this unshallow-and-retry covers nonstandard workspaces. Best-effort:
  // if the deepen fails (or the retry still can't find a merge-base), the original error
  // surfaces rather than an empty file list silently gating over nothing.
  //
  // `-z` is not cosmetic. Without it git QUOTES any path that is not plain ASCII and
  // octal-escapes its bytes, so `tests/e2e/caf\u00e9.spec.ts` arrives as the literal
  // `"tests/e2e/caf\\303\\251.spec.ts"` -- surrounding quotes included. Every downstream
  // consumer then fails to recognize it: an `endsWith('.ts')` test-file selector says no, a
  // path-prefix scope test says no, and the file is dropped from the diff entirely. That is a
  // silent false green (a spec containing `it.only(...)` sails through the structure gate),
  // and it is invisible precisely because nothing errors. The NUL stream also preserves names
  // with trailing whitespace, which the old `.trim()` mangled.
  let out: string;
  try {
    out = await git(['diff', '--name-only', '-z', `${base}...HEAD`]);
  } catch (err) {
    await git(['fetch', '--unshallow', 'origin']).catch(() => undefined);
    out = await git(['diff', '--name-only', '-z', `${base}...HEAD`]).catch(() => {
      throw err;
    });
  }
  return out.split('\0').filter((line) => line.length > 0);
}
