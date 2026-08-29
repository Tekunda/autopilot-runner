// Durable grant-replay PREVENTION for the thin runner (the prevention half of Track G, whose
// grant-ledger.ts is detection-only). A signed, unexpired ExecutionGrant re-dispatched into a
// FRESH GitHub Actions job -- via workflow_dispatch, within its ~45-min TTL -- meets an empty
// per-process ledger and re-executes in full (extra AI spend, extra force-push, a stale gate
// re-published). The signature/expiry checks can't stop it: the grant IS authentic and live;
// what's missing is a durable "already ran" record the runner can consult BEFORE it acts.
//
// The runner is network-isolated -- no Azure creds, no control-plane callback -- but it CAN
// reach GitHub with the git-refs-write token it already uses (vcs-host.ts createBranch). Git
// ref creation is an atomic create-if-not-exists: POST /git/refs returns 201 for the first
// creator and 422 "Reference already exists" for every one after. So the FIRST runner step of a
// grant claims a ref named deterministically from the SIGNED grant -- refs/autopilot-claims/
// <expiryEpochMs>-<jti> -- and a replay, computing the identical name, collides on 422 and
// aborts before any vendor/gate work. The control plane GC-sweeps expired claim refs
// (control-plane.ts); the ref only has to outlive the grant's replay window.
//
// FAIL-OPEN by design: the blast radius of a replay is resource-abuse, not privilege-escalation
// (grants are Ed25519-signed and scoped), so an infra blip on the claim store must NEVER block a
// legitimate run. Only a DEFINITIVE 422 aborts; a network error / 5xx / 403 logs loudly, emits a
// `grant_claim_unavailable` signal, and proceeds. A read-only/judgment-only install whose token
// lacks contents:write simply fails-open here too -- harmless, but the guard is inert for it.

import type { VCSHost } from '../contracts/adapters.ts';
import type { ExecutionGrant } from '../contracts/types.ts';
import { grantLedgerId } from '../control-plane/grant-ledger.ts';

// The ref namespace the claim primitive lives in. A dedicated namespace (not refs/heads/*) keeps
// claims off the branch list and lets the GC sweep match them with one prefix.
export const CLAIM_REF_PREFIX = 'refs/autopilot-claims';

// How long past a grant's own expiry a claim ref is kept before the GC sweep may delete it. The
// grant is unusable once expired, so the ref only guards the replay window; a margin beyond
// expiry absorbs clock skew between issuance and the sweep before reclaiming the ref.
export const CLAIM_SWEEP_MARGIN_MS = 60 * 60 * 1000;

// The deterministic claim-ref name for a grant: refs/autopilot-claims/<expiryEpochMs>-<jti>.
// Both halves come from the SIGNED grant (expiresAt, jti -- unique per issuance, so a retry mints
// a fresh name while a replay reuses the captured one), so prepare, gate and heavy-gate all
// compute the identical name without coordinating. Legacy grants without a jti fall back to the
// same sha256(sig) id the ledger uses. A leading `<epochMs>-` lets the GC sweep read the expiry
// back with pure prefix arithmetic (the jti's own hyphens never matter -- only the first field).
export function claimRefName(grant: ExecutionGrant): string {
  const expiry = Date.parse(grant.expiresAt);
  const epochMs = Number.isNaN(expiry) ? 0 : expiry;
  return `${CLAIM_REF_PREFIX}/${epochMs}-${grantLedgerId(grant)}`;
}

// The embedded expiry epoch of a claim ref, or undefined if the ref isn't one this module wrote.
export function claimRefExpiry(ref: string): number | undefined {
  const prefix = `${CLAIM_REF_PREFIX}/`;
  if (!ref.startsWith(prefix)) return undefined;
  const rest = ref.slice(prefix.length);
  const dash = rest.indexOf('-');
  if (dash <= 0) return undefined;
  const epochMs = Number(rest.slice(0, dash));
  return Number.isNaN(epochMs) ? undefined : epochMs;
}

// Outcome of a claim attempt. `claimed` = first claimant, proceed. `replayed` = the ref already
// existed, this is a replay, abort. `unavailable` = the store couldn't answer (fail-open: proceed
// but visibly, so a persistent outage is noticed rather than silently disabling the guard).
export type ClaimOutcome = { status: 'claimed' } | { status: 'replayed' } | { status: 'unavailable' };

export type ClaimEvent = 'grant_claimed' | 'grant_replayed' | 'grant_claim_unavailable';

// Observability seam. The default emitter logs an unavailable store LOUDLY (console.error) so an
// outage that silently defeats the guard is visible, and records the definitive outcomes on
// stdout. Tests inject their own to assert without capturing streams.
export type ClaimEmitter = (event: ClaimEvent, detail: string) => void;

export const defaultClaimEmitter: ClaimEmitter = (event, detail) => {
  if (event === 'grant_claim_unavailable') {
    console.error(`grant-claim: ${event} -- ${detail} (fail-open: proceeding)`);
  } else {
    process.stdout.write(`grant-claim: ${event} -- ${detail}\n`);
  }
};

// Resolve an existing commit sha to point the claim ref at. The target sha is irrelevant to the
// claim's correctness (ref creation is atomic regardless of what it points at), so any commit the
// runner can already reach works: the grant's signed headSha when present, else the head of the
// ref it bases on. Undefined when neither resolves (the caller then fails-open).
export async function resolveClaimSha(
  grant: ExecutionGrant,
  vcsHost: VCSHost,
  baseRef: string | undefined,
): Promise<string | undefined> {
  if (grant.headSha) return grant.headSha;
  if (!baseRef) return undefined;
  return vcsHost.getBranchSha(grant.repoId, baseRef).catch(() => undefined);
}

// Attempt to claim the grant. The FIRST runner step for a grant calls this immediately after the
// signature verifies and before any vendor/gate work. A `replayed` result must abort the run
// (rejected telemetry, non-zero exit); `claimed`/`unavailable` both proceed.
export async function tryClaimGrant(
  grant: ExecutionGrant,
  vcsHost: VCSHost,
  sha: string | undefined,
  emit: ClaimEmitter = defaultClaimEmitter,
): Promise<ClaimOutcome> {
  const ref = claimRefName(grant);
  // No createClaimRef (a host that can't claim) or no sha to point at: nothing to check -> the
  // guard is inert for this run, which is a fail-open, not a block.
  if (!vcsHost.createClaimRef || !sha) {
    emit('grant_claim_unavailable', `${ref}: no claim store available`);
    return { status: 'unavailable' };
  }
  try {
    const result = await vcsHost.createClaimRef(grant.repoId, ref, sha);
    if (result === 'exists') {
      emit('grant_replayed', ref);
      return { status: 'replayed' };
    }
    emit('grant_claimed', ref);
    return { status: 'claimed' };
  } catch (err) {
    // FAIL-OPEN: only a definitive "already exists" (surfaced as `exists` above) aborts. Any
    // other failure -- network, 5xx, 403, a bad sha -- must not block a legitimate run.
    const detail = err instanceof Error ? err.message : String(err);
    emit('grant_claim_unavailable', `${ref}: ${detail}`);
    return { status: 'unavailable' };
  }
}

// Control-plane GC sweep: which of the given claim refs are safe to delete now -- those whose
// embedded expiry is older than now minus the margin. Pure arithmetic on the ref names, so the
// sweep needs no per-grant state. A ref this module didn't write (no parseable expiry) is left
// alone.
export function expiredClaimRefs(
  refs: readonly string[],
  now: number,
  marginMs: number = CLAIM_SWEEP_MARGIN_MS,
): string[] {
  const cutoff = now - marginMs;
  return refs.filter((ref) => {
    const expiry = claimRefExpiry(ref);
    return expiry !== undefined && expiry < cutoff;
  });
}
