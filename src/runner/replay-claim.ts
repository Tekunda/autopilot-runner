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
// FAIL-CLOSED, as of the GA gate (A2) -- this module used to fail OPEN, and the reasoning it did
// so under is worth keeping visible because it was not wrong, it was priced wrong:
//
//   "The blast radius of a replay is resource-abuse, not privilege-escalation (grants are
//    Ed25519-signed and scoped), so an infra blip on the claim store must never block a
//    legitimate run."
//
// True for a single-tenant pipeline spending our own budget. It stops being true the moment a
// run spends a CUSTOMER's model credential: "resource abuse" is then somebody's bill and
// somebody's force-push, an attacker who can trigger the claim store to fail is an attacker who
// can replay at will, and a guard that switches itself off exactly when it is being attacked is
// not a guard. So the trade is inverted: an unanswerable claim store now BLOCKS the run.
//
// What that costs is availability, and the whole design here is about paying that price
// deliberately rather than by accident:
//   * BOUNDED RETRY first, under a real wall-clock ceiling (CLAIM_PHASE_BUDGET_MS, with
//     CLAIM_RETRY_BACKOFFS_MS deciding how it is spent). A blip -- a 5xx, a dropped connection, a
//     secondary rate limit -- is retried before anything is refused, so the common transient case
//     never reaches a human at all. The ceiling is wall-clock rather than a count because the
//     layers underneath have their own retries and timeouts: see CLAIM_RETRY_BACKOFFS_MS.
//   * A permission failure (401/403) is NOT retried: the token cannot grow contents:write inside
//     one run, so retrying only delays a message the operator needs immediately.
//   * The refusal is LOUD and says what to fix -- never a silent stall, never a generic error.
//     A blocked run reports rejected telemetry and exits non-zero, which the control plane
//     surfaces like any other rejected grant.
//   * The ONE remaining fail-open is structural, not transient: a VCSHost with no createClaimRef
//     at all has no claim primitive to consult, so there is nothing to be closed about. Every
//     production host implements it (asserted in replay-claim.test.ts), which is what keeps this
//     exemption from quietly becoming the norm.

import type { ClaimRefResult, VCSHost } from '../contracts/adapters.ts';
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

// Outcome of a claim attempt.
//   `claimed`     -- first claimant, proceed.
//   `replayed`    -- the ref already existed: this grant already ran. Abort.
//   `blocked`     -- the claim store could not answer, so replay cannot be ruled out. Abort,
//                    loudly, carrying a `reason` the operator can act on.
//   `unavailable` -- the host has NO claim primitive at all (structural, see the module header):
//                    the guard is inert for this install and the run proceeds.
export type ClaimOutcome =
  | { status: 'claimed' }
  | { status: 'replayed' }
  | { status: 'blocked'; reason: string }
  | { status: 'unavailable' };

export type ClaimEvent = 'grant_claimed' | 'grant_replayed' | 'grant_claim_blocked' | 'grant_claim_unavailable';

// Backoffs between attempts: four retries over ~3.7s of SLEEPING.
//
// That number alone is not the bound, and saying it was would be the kind of claim that gets
// believed. Each attempt is a VCSHost call, and the GitHub adapter's own request layer
// (adapters/github/rest.ts, resilientRequest) already retries a transient fault twice with its own
// backoff under a 30s per-attempt timeout -- so ONE logical `createClaimRef` can take ~110s before
// it ever returns to this loop. Five outer attempts of that is ~9 minutes, and resolveClaimSha
// pays the same again: ~18 minutes against the control plane's 35-minute deadline. The circuit
// breaker usually cuts it far shorter, but "usually" is not a bound.
//
// So the real bound is a WALL-CLOCK BUDGET, enforced here: CLAIM_PHASE_BUDGET_MS caps the whole
// phase regardless of what the layers underneath do, by racing each attempt against the time
// remaining. Sha resolution and the claim itself each get one budget, so the pair costs at most
// ~2x that. The backoffs only decide how the budget is spent.
export const CLAIM_RETRY_BACKOFFS_MS = [200, 500, 1200, 1800];

// Wall-clock ceiling on each half of the claim phase. 30s is comfortably longer than a healthy
// claim (a single ref create, tens of milliseconds) and short enough that the pair cannot
// meaningfully erode the stage's own budget. A run refused at 60s is a run an operator can
// diagnose; a run refused at 18 minutes looks like a hang.
export const CLAIM_PHASE_BUDGET_MS = 30_000;

// HTTP statuses no amount of retrying will change within one run: the token's scopes are fixed
// for the life of the job, so a 401/403 must surface immediately with the fix named rather than
// burn the backoff schedule first.
const PERMANENT_CLAIM_STATUSES = new Set([401, 403]);

function claimErrorStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status : undefined;
}

// Observability seam. The default emitter logs a BLOCKED claim and an inert store LOUDLY
// (console.error) -- an outage that stops runs, and one that silently disables the guard, both
// have to be visible -- and records the definitive outcomes on stdout. Tests inject their own to
// assert without capturing streams.
export type ClaimEmitter = (event: ClaimEvent, detail: string) => void;

export const defaultClaimEmitter: ClaimEmitter = (event, detail) => {
  if (event === 'grant_claim_blocked') {
    console.error(`grant-claim: ${event} -- ${detail} (fail-closed: refusing to run)`);
  } else if (event === 'grant_claim_unavailable') {
    console.error(`grant-claim: ${event} -- ${detail} (no claim store on this host: proceeding)`);
  } else {
    process.stdout.write(`grant-claim: ${event} -- ${detail}\n`);
  }
};

// The rejection text a blocked claim reports as telemetry. One place, so prepare and gate say the
// same thing, and so the sentence names the two things an operator has to check.
export function claimRejection(outcome: ClaimOutcome): string {
  if (outcome.status === 'replayed') return 'replayed grant';
  if (outcome.status !== 'blocked') return 'grant claim failed';
  return (
    `could not place the grant's replay claim, so this run cannot prove it is not a replay: ${outcome.reason}. ` +
    'Check that the runner token still has contents:write on this repository (the claim is a git ref ' +
    'under refs/autopilot-claims/), then re-dispatch the stage.'
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Injected only by tests, so the retry schedule can be asserted without spending real seconds.
export interface ClaimRetryDeps {
  backoffsMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock ceiling for this phase; defaults to CLAIM_PHASE_BUDGET_MS. */
  budgetMs?: number;
  /** Clock seam; defaults to Date.now. */
  now?: () => number;
}

const BUDGET_EXPIRED = Symbol('claim-budget-expired');

// Race one attempt against the remaining budget. The underlying request layer has its own retries
// and timeouts that this code does not thread a signal into, so the only way to hold a real
// ceiling is to stop WAITING on it. An abandoned attempt keeps running in the background; that is
// harmless, because ref creation is idempotent and the process is about to exit non-zero anyway.
async function withinBudget<T>(work: Promise<T>, remainingMs: number): Promise<T | typeof BUDGET_EXPIRED> {
  if (remainingMs <= 0) return BUDGET_EXPIRED;
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<typeof BUDGET_EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(BUDGET_EXPIRED), remainingMs);
    // Never hold the event loop open just to enforce a ceiling we may not reach.
    timer.unref?.();
  });
  try {
    return await Promise.race([work, expiry]);
  } finally {
    clearTimeout(timer!);
  }
}

// Resolve an existing commit sha to point the claim ref at. The target sha is irrelevant to the
// claim's correctness (ref creation is atomic regardless of what it points at), so any commit the
// runner can already reach works: the grant's signed headSha when present, else the head of the
// ref it bases on.
//
// RETRIED, for the same reason the claim itself is: a transient getBranchSha failure used to
// collapse to `undefined`, which the caller then read as "nothing to claim" and proceeded. Now
// that an unresolvable sha BLOCKS the run, swallowing a blip here would turn every network hiccup
// into a refused stage.
//
// But only a THROW is retried. A resolved `undefined` is getBranchSha's definitive answer -- its
// requestOptional turns a 404 into undefined -- and neither of the two things that produces (the
// ref does not exist, or this token cannot see the repo) will change during one job. Retrying it
// burned the whole budget to reach the same answer, delaying an actionable failure by the full
// backoff schedule. So: undefined returns immediately, a thrown transient is retried, and either
// way the phase is capped by the wall-clock budget above.
export async function resolveClaimSha(
  grant: ExecutionGrant,
  vcsHost: VCSHost,
  baseRef: string | undefined,
  retry: ClaimRetryDeps = {},
): Promise<string | undefined> {
  if (grant.headSha) return grant.headSha;
  if (!baseRef) return undefined;
  const backoffs = retry.backoffsMs ?? CLAIM_RETRY_BACKOFFS_MS;
  const wait = retry.sleep ?? sleep;
  const now = retry.now ?? Date.now;
  const deadline = now() + (retry.budgetMs ?? CLAIM_PHASE_BUDGET_MS);
  for (let attempt = 0; ; attempt++) {
    const settled = await withinBudget(
      vcsHost.getBranchSha(grant.repoId, baseRef).then(
        (sha) => ({ sha }),
        (err: unknown) => ({ err }),
      ),
      deadline - now(),
    );
    if (settled === BUDGET_EXPIRED) return undefined;
    if ('sha' in settled) return settled.sha; // definitive, including a definitive "no"
    const backoff = backoffs[attempt];
    if (backoff === undefined) return undefined;
    await wait(backoff);
  }
}

// Attempt to claim the grant. The FIRST runner step for a grant calls this immediately after the
// signature verifies and before any vendor/gate work.
//
// `replayed` and `blocked` both abort the run (rejected telemetry, non-zero exit -- see
// claimRejection); `claimed` and `unavailable` proceed. See the module header for why everything
// but a structurally absent claim primitive now fails CLOSED.
export async function tryClaimGrant(
  grant: ExecutionGrant,
  vcsHost: VCSHost,
  sha: string | undefined,
  emit: ClaimEmitter = defaultClaimEmitter,
  retry: ClaimRetryDeps = {},
): Promise<ClaimOutcome> {
  const ref = claimRefName(grant);
  // The one structural fail-open: this host has no claim primitive at all, so there is no store
  // to be unavailable and nothing a retry could reach. Every production VCSHost implements it.
  if (!vcsHost.createClaimRef) {
    emit('grant_claim_unavailable', `${ref}: this VCS host has no claim primitive`);
    return { status: 'unavailable' };
  }
  if (!sha) {
    const reason = 'no commit could be resolved to anchor the claim ref to';
    emit('grant_claim_blocked', `${ref}: ${reason}`);
    return { status: 'blocked', reason };
  }

  const claimed = await claimWithRetry(grant, vcsHost.createClaimRef.bind(vcsHost), ref, sha, retry);
  if (claimed.result !== undefined) {
    const status = claimed.result === 'exists' ? 'replayed' : 'claimed';
    emit(status === 'replayed' ? 'grant_replayed' : 'grant_claimed', ref);
    return { status };
  }
  emit('grant_claim_blocked', `${ref}: ${claimed.detail}`);
  return { status: 'blocked', reason: claimed.detail };
}

// The bounded retry loop behind tryClaimGrant: create the claim ref, retry a non-permanent
// failure on the backoff schedule, and give up the moment the WALL-CLOCK budget is spent.
// Split out so tryClaimGrant stays inside the complexity budget -- the loop is where every one
// of its branches lived, and none of them are about the caller's guard clauses or its telemetry.
//
// Answers either the store's own verdict (`result`) or the reason the phase ended without one
// (`detail`). It never emits: the caller owns the telemetry, so the two cannot drift apart.
async function claimWithRetry(
  grant: ExecutionGrant,
  createClaimRef: (repoId: string, ref: string, sha: string) => Promise<ClaimRefResult>,
  ref: string,
  sha: string,
  retry: ClaimRetryDeps,
): Promise<{ result?: ClaimRefResult; detail: string }> {
  const backoffs = retry.backoffsMs ?? CLAIM_RETRY_BACKOFFS_MS;
  const wait = retry.sleep ?? sleep;
  const now = retry.now ?? Date.now;
  const budgetMs = retry.budgetMs ?? CLAIM_PHASE_BUDGET_MS;
  const deadline = now() + budgetMs;
  let lastDetail = 'unknown error';
  for (let attempt = 0; ; attempt++) {
    const settled = await withinBudget(
      createClaimRef(grant.repoId, ref, sha).then(
        (result) => ({ result }),
        (err: unknown) => ({ err }),
      ),
      deadline - now(),
    );
    if (settled === BUDGET_EXPIRED) return { detail: `the claim store did not answer within ${budgetMs}ms` };
    if ('result' in settled) return { result: settled.result, detail: lastDetail };
    const err = settled.err;
    lastDetail = err instanceof Error ? err.message : String(err);
    const status = claimErrorStatus(err);
    // A permission failure will read the same on attempt four as on attempt one; refuse now so
    // the operator sees the actionable message instead of a four-second pause first.
    if (status !== undefined && PERMANENT_CLAIM_STATUSES.has(status)) return { detail: lastDetail };
    const backoff = backoffs[attempt];
    if (backoff === undefined) return { detail: lastDetail };
    await wait(backoff);
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
