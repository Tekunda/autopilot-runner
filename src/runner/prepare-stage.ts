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

import type { CodingExecutor } from '../contracts/adapters.ts';
import type { ExecutionGrant, Stage, StatusTelemetry } from '../contracts/types.ts';
import { verifyGrant, type KeyInput } from '../control-plane/grant-verify.ts';

export interface PrepareStageDeps {
  codingExecutor: CodingExecutor;
  /** Customer repository's default branch, supplied by the runner workflow. */
  baseRef?: string;
  /** Public key used to verify the grant's signature. */
  verifyKey: KeyInput;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
}

export const CODING_STAGES: ReadonlySet<Stage> = new Set(['build', 'fix']);

// v0 drives a single default branch; per-ticket base refs are future work.
export const DEFAULT_BASE_REF = 'main';

export type PreparedStage =
  | { kind: 'resolved'; telemetry: StatusTelemetry }
  | { kind: 'judgment'; repoId: string; baseRef: string; prompt: string }
  | { kind: 'coding'; repoId: string; baseRef: string; branchName: string; prompt: string };

// A grant carries no id of its own -- its signature already uniquely
// fingerprints the issued grant, so hash it into a stable telemetry id.
export function grantId(grant: ExecutionGrant): string {
  return createHash('sha256').update(grant.sig).digest('hex');
}

export function digestFor(...parts: string[]): string {
  return `sha256:${createHash('sha256').update(parts.join(' ')).digest('hex')}`;
}

// The branch a coding stage's vendor Action step must push its work to, computed
// deterministically from the grant alone so prepareStage() and finalizeCodingStage()
// (./finalize-stage.ts) -- separate processes sharing nothing but the grant -- always
// agree on it without either trusting the vendor step's own self-reported branch name,
// which claude-code-action leaves unset outside its entity-triggered auto-branch mode
// (issue #113). Not signed/part of the grant itself: deriving it from the grant's own
// signature (via grantId) makes it unique per issued grant without adding a field.
export function codingBranchName(grant: ExecutionGrant): string {
  const ticket = grant.ticketId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `autopilot/${ticket || 'ticket'}-${grant.stage}-${grantId(grant).slice(0, 8)}`;
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

  if (CODING_STAGES.has(grant.stage)) {
    const baseRef = deps.baseRef ?? DEFAULT_BASE_REF;
    const branchName = codingBranchName(grant);
    const prepared = await deps.codingExecutor.prepare({
      stage: grant.stage,
      prompt,
      repoId: grant.repoId,
      baseRef,
      branchName,
    });

    return { kind: 'coding', repoId: grant.repoId, baseRef, branchName, prompt: prepared.prompt };
  }

  return {
    kind: 'judgment',
    repoId: grant.repoId,
    baseRef: deps.baseRef ?? DEFAULT_BASE_REF,
    prompt,
  };
}
