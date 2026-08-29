// Shared resilient-request wrapper for the REST clients (notion/rest.ts, github/rest.ts).
// One logical request may hit a transient provider fault -- a dropped connection, a
// timeout, a 429, or a 5xx -- that the very next attempt would sail through. This retries
// such faults a BOUNDED number of times with jittered exponential backoff (honoring a
// Retry-After when the provider sends one), so a blip costs a short pause instead of a
// failed drive step.
//
// It lives INSIDE the CircuitBreaker: the breaker wraps the whole logical request, so what
// it counts as a failure is the POST-retry outcome (one exhausted request = one failure),
// not each individual attempt. A caller-caused 4xx (bad id, missing page, auth) is NOT
// transient, so it fails fast on the first attempt and never wastes a retry.
//
// The transient classifier (isTransientFault) is exported deliberately: it is the single
// source of truth for "is this a provider blip worth another try", reused both as the
// breaker's countsAsFailure classifier here and by the control plane's own retry paths.

/** Errors thrown by fn that carry HTTP context the wrapper reads to decide backoff. Both
 *  REST clients' ApiError types satisfy this structurally; a bare network error / timeout
 *  satisfies no field and is treated as transient (no HTTP response ever arrived). */
interface HttpFault {
  /** HTTP status of the provider response, when one was received. */
  status?: number;
  /** Provider-requested backoff in ms (parsed from Retry-After), when present. */
  retryAfterMs?: number;
  /** Set when the response is a provider THROTTLE independent of its status -- notably
   *  GitHub's 403 primary/secondary rate limits, which are NOT 429. Makes such a 403
   *  retryable (with its Retry-After backoff) while a plain auth/permission 403 stays not. */
  rateLimited?: boolean;
}

export interface ResilientRequestOptions {
  /** RETRY budget on top of the first attempt: total attempts = maxRetries + 1. */
  maxRetries: number;
  /** First backoff; doubles per subsequent retry, capped at maxDelayMs. Default 1s. */
  baseDelayMs?: number;
  /** Ceiling on any single backoff -- also clamps an absurd Retry-After. Default 10s. */
  maxDelayMs?: number;
  /** Classifies a thrown error as a retryable provider blip. Default isTransientFault. */
  isTransient?: (err: unknown) => boolean;
  /** Injectable sleep for tests; defaults to a real setTimeout-backed pause. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0, 1); defaults to Math.random. */
  random?: () => number;
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 10_000;

/** Runs `fn`, retrying transient faults with jittered exponential backoff up to
 *  `maxRetries` times. A non-transient error (or an exhausted retry budget) rethrows the
 *  original error untouched. */
export async function resilientRequest<T>(fn: () => Promise<T>, opts: ResilientRequestOptions): Promise<T> {
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const isTransient = opts.isTransient ?? isTransientFault;
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= opts.maxRetries || !isTransient(err)) throw err;
      await sleep(backoffMs(attempt, err, baseDelayMs, maxDelayMs, random));
    }
  }
}

/** True when an error signals a PROVIDER blip worth retrying (and worth counting against the
 *  outage breaker): a network error or timeout (no HTTP response at all), a 408 (request
 *  timeout), a 429, a 5xx, or a rate-limit 403. A caller-caused 4xx (bad ref, missing page,
 *  validation, plain auth) is NOT transient -- retrying just repeats the same rejection and
 *  tripping the breaker on it would cool the provider down for one ticket's broken link.
 *  The 403 exception matters: GitHub returns 403 (not 429) for primary and secondary rate
 *  limits, so only a 403 carrying a throttle signal (Retry-After / rateLimited) is retried;
 *  a permission 403 has neither and fails fast. */
export function isTransientFault(err: unknown): boolean {
  const status = httpStatusOf(err);
  if (status === undefined) return true;
  if (status >= 500 || status === 429 || status === 408) return true;
  if (status === 403) return isRateLimited(err);
  return false;
}

function isRateLimited(err: unknown): boolean {
  const fault = err as HttpFault | null;
  return fault?.rateLimited === true || typeof fault?.retryAfterMs === 'number';
}

/** Parses a Retry-After value (seconds per HTTP) into ms. Absent, non-numeric or
 *  non-positive -> undefined, letting the caller fall back to exponential backoff. */
export function parseRetryAfterMs(headerValue: string | null): number | undefined {
  const sec = Number(headerValue);
  if (!Number.isFinite(sec) || sec <= 0) return undefined;
  return sec * 1_000;
}

function backoffMs(attempt: number, err: unknown, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  const retryAfterMs = (err as HttpFault | null)?.retryAfterMs;
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) return Math.min(retryAfterMs, maxDelayMs);

  // Equal jitter: half the (capped) exponential window is fixed so every retry actually
  // pauses, the other half is random so a fleet of clients doesn't resynchronize into a
  // thundering herd against a recovering provider.
  const window = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
  return window / 2 + random() * (window / 2);
}

function httpStatusOf(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null) {
    const status = (err as HttpFault).status;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
