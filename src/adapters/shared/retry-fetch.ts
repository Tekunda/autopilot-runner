// Shared retry wrapper for provider-model HTTP calls (claude/agent-model.ts,
// openai/agent-model.ts). Model providers routinely return 429 (rate limit) or 503
// (overloaded) under load; a transient one of those must not fail a whole stage.
// Retries with exponential backoff + full jitter, honoring Retry-After when the
// provider sends one. Never retries a non-429 4xx, and never leaks request/response
// bodies (which may carry secrets or customer content) into the thrown error.

const RETRYABLE_STATUSES = new Set([429, 503]);

export interface RetryFetchOptions {
  /** Total attempts including the first, before giving up. Defaults to 4. */
  maxAttempts?: number;
  /** Base delay for exponential backoff, in ms. Defaults to 500. */
  baseDelayMs?: number;
  /** Upper bound on the computed backoff delay, in ms. Defaults to 8000. */
  maxDelayMs?: number;
  /** Injectable for tests; defaults to a real setTimeout-based sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Math.random. */
  random?: () => number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Full-jitter exponential backoff (AWS's recommended formula): a random delay in
// [0, min(maxDelayMs, baseDelayMs * 2^(attempt-1))].
function backoffDelayMs(attempt: number, baseDelayMs: number, maxDelayMs: number, random: () => number): number {
  const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  return random() * cap;
}

// Retry-After is either a number of seconds or an HTTP-date (RFC 7231 §7.1.3).
function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined;

  const seconds = Number(headerValue);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }

  return undefined;
}

/**
 * Calls fetchImpl(url, init), retrying on 429/503 responses and on network errors
 * (fetchImpl throwing) with exponential backoff + jitter, up to a bounded number of
 * attempts. Any other response (including non-429 4xx) is returned immediately for
 * the caller to interpret. Never retries a non-429, non-503 status.
 *
 * On final failure: the last response is returned (its !ok is left for the caller to
 * turn into a descriptive error, matching non-retried failures) if the failures were
 * HTTP responses, or the last network error is rethrown if the failures were network
 * errors.
 */
export async function fetchWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: RetryFetchOptions = {},
): Promise<Response> {
  const { maxAttempts = 4, baseDelayMs = 500, maxDelayMs = 8000, sleep = defaultSleep, random = Math.random } = options;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let response: Response;
    try {
      response = await fetchImpl(url, init);
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await sleep(backoffDelayMs(attempt, baseDelayMs, maxDelayMs, random));
      continue;
    }

    if (response.ok || !RETRYABLE_STATUSES.has(response.status) || attempt === maxAttempts) {
      return response;
    }

    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'));
    await sleep(retryAfterMs ?? backoffDelayMs(attempt, baseDelayMs, maxDelayMs, random));
  }

  // Unreachable: the loop above always returns or throws by the final attempt.
  throw new Error('fetchWithRetry: exhausted attempts without a result');
}
