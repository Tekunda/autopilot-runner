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
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CodingExecutor } from '../contracts/adapters.ts';
import { effortForTier, resolveModel } from '../config/model-tiers.ts';
import type { ExecutionGrant, Stage, StatusTelemetry } from '../contracts/types.ts';
import { slugify } from '../control-plane/branch-names.ts';
import { verifyGrant, type KeyInput } from '../control-plane/grant-verify.ts';
import { buildMcpConfig } from './mcp-config.ts';

export interface PrepareStageDeps {
  codingExecutor: CodingExecutor;
  /** Customer repository's default branch, supplied by the runner workflow. */
  baseRef?: string;
  /** Public key used to verify the grant's signature. */
  verifyKey: KeyInput;
  /**
   * The selected vendor Action's provider id (`claude-code` | `codex` | ...), used
   * to turn the grant's signed `modelTier` into a concrete model id for that
   * vendor's step. Absent -> no model is emitted and the vendor's own default
   * applies (which is exactly the tier-is-ignored behaviour this fixes).
   */
  executorProvider?: string;
  /** Customer-configured model id, which wins over the tier mapping. */
  configuredModel?: string;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
}

export const CODING_STAGES: ReadonlySet<Stage> = new Set(['build', 'fix']);

// v0 drives a single default branch; per-ticket base refs are future work.
export const DEFAULT_BASE_REF = 'main';

// `model`/`effort` carry the grant's signed modelTier through to the vendor Action
// step's own inputs (action.yml), which is what actually makes a "deep" build stage
// run on the deep model instead of the vendor's default.
// `mcpConfigPath`/`mcpAllowedTools` are set on every agent stage when the grant authorizes
// MCP: the path of the claude-code-action `--mcp-config` file this phase wrote (from the
// grant's signed server definitions) and the mcp tool names to add to the vendor step's
// `--allowedTools`. Absent when the grant carries no `mcp`.
export type PreparedStage =
  | { kind: 'resolved'; telemetry: StatusTelemetry }
  | { kind: 'judgment'; repoId: string; baseRef: string; prompt: string; model?: string; effort?: string; mcpConfigPath?: string; mcpAllowedTools?: string[] }
  | { kind: 'architect'; repoId: string; baseRef: string; prompt: string; model?: string; effort?: string; mcpConfigPath?: string; mcpAllowedTools?: string[] }
  | { kind: 'coding'; repoId: string; baseRef: string; branchName: string; prompt: string; model?: string; effort?: string; mcpConfigPath?: string; mcpAllowedTools?: string[] };

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
function subtaskBranchKey(grant: ExecutionGrant): string {
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
export function codingBranchName(grant: ExecutionGrant): string {
  // A `fix` stage self-heals the PR already under test: it pushes its changes
  // onto that PR's existing head branch (carried as the grant's baseBranch by
  // the subtask pipeline) so the re-gate re-checks the same PR, rather than
  // deriving a fresh branch the gated PR never receives (a fix that lands
  // nowhere would exhaust the loop despite the agent doing real work). A
  // `build` stage always gets a fresh, per-grant branch to open its PR from.
  if (grant.stage === 'fix' && grant.baseBranch) return grant.baseBranch;
  const label = slugify(grant.ticketTitle ?? '') || slugify(grant.ticketId) || 'ticket';
  return `autopilot/${label}-${grant.stage}-${subtaskBranchKey(grant).slice(0, 8)}`;
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
  const verification = verifyGrant(grant, deps.verifyKey, deps.now ?? new Date());
  if (!verification.ok) {
    return { kind: 'resolved', telemetry: rejectedTelemetry(grant, verification.reason) };
  }

  const prompt = grant.stepPrompt ?? grant.ref ?? '';
  // The grant's server-set baseBranch (the ticket's integration branch) wins over
  // the runner workflow's repo-default baseRef, so subtask coding never bases on --
  // or opens a PR against -- the customer's live default branch.
  const baseRef = grant.baseBranch ?? deps.baseRef ?? DEFAULT_BASE_REF;

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

  // The architect and accept stages share one execution shape -- read-only repo plus a
  // single Write to the artifact file (plan.json), no branch and no PR. action.yml gives
  // the vendor step Write access (and uploads the artifact) on this kind, then finalize
  // maps its conclusion to telemetry like any other judgment stage. `accept` reuses the
  // architect plumbing deliberately: it checks out the ticket's assembled integration
  // branch (grant.baseBranch) and writes its acceptance verdict to plan.json, which the
  // control plane parses per grant.stage -- so no runner/action.yml change is needed to
  // add the acceptance walk.
  if (grant.stage === 'architect' || grant.stage === 'accept') {
    return {
      kind: 'architect',
      repoId: grant.repoId,
      baseRef,
      prompt,
      ...(model ? { model } : {}),
      effort,
      ...mcpFields,
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

    return {
      kind: 'coding',
      repoId: grant.repoId,
      baseRef,
      branchName,
      prompt: prepared.prompt,
      ...(model ? { model } : {}),
      effort,
      ...mcpFields,
    };
  }

  return {
    kind: 'judgment',
    repoId: grant.repoId,
    baseRef,
    prompt,
    ...(model ? { model } : {}),
    effort,
    ...mcpFields,
  };
}
