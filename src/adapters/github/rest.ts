// Minimal REST client for the GitHub API. No dependencies beyond the global
// fetch (Node 24) — adapters stay dependency-free so package.json doesn't
// conflict while adapters build in parallel. See AGENTS.md.

import { CircuitBreaker } from '../shared/circuit-breaker.ts';
import { isTransientFault, parseRetryAfterMs, resilientRequest } from '../shared/resilient-request.ts';
import type { TokenProvider } from '../shared/token-provider.ts';

export type { TokenProvider } from '../shared/token-provider.ts';

export interface GitHubClientConfig {
  /**
   * A static GitHub personal access token. Never logged. Supply exactly one of
   * `token` or `tokenProvider` — for a real customer install, that's an App
   * installation-token provider (control-plane/github-app.ts), not a PAT.
   */
  token?: string;
  /** Resolves a fresh token on every request, e.g. a cached App installation token. */
  tokenProvider?: TokenProvider;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests; defaults to the real GitHub API. */
  baseUrl?: string;
  /** Per-request timeout in ms; defaults to 30s. A stalled request aborts rather than
   *  hanging the drive loop. */
  timeoutMs?: number;
  /** Outage breaker guarding each HTTP attempt. Defaults to a fresh process-local one
   *  so every client instance cools down independently; inject a shared instance (or a
   *  short-cooldown one in tests) to override. */
  breaker?: CircuitBreaker;
  /** Transient-fault retries per logical request (network error, 429, 5xx). Default 2,
   *  i.e. up to 3 attempts. Caller-caused 4xx never retry. */
  maxRetries?: number;
  /** Injectable backoff sleep for tests; defaults to real timers. */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class GitHubApiError extends Error {
  readonly status: number;
  /** Provider-requested backoff in ms parsed from a Retry-After header, when present. */
  readonly retryAfterMs?: number;
  /** True when GitHub signaled a rate limit (Retry-After or x-ratelimit-remaining: 0). Lets a
   *  rate-limit 403 -- GitHub's usual throttle status, not 429 -- be retried while a plain
   *  auth/permission 403 is not. */
  readonly rateLimited?: boolean;

  constructor(status: number, method: string, path: string, message: string, retryAfterMs?: number, rateLimited?: boolean) {
    super(`GitHub API ${method} ${path} failed: ${status} ${message}`);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.rateLimited = rateLimited;
  }
}

// Per-request timeout. Like the Notion client, every control-plane GitHub call must be
// bounded so a stalled connection can't hang the drive loop forever. Individual calls
// (dispatch, branch/PR ops, one poll of a run's status) are all short; the CIRunner's own
// 15-minute wait for a run to finish is a sequence of these bounded requests, not one.
const DEFAULT_TIMEOUT_MS = 30_000;

// A transient provider fault (network error, 429, 5xx) is retried this many times -- honoring
// a Retry-After when present -- before surfacing like any other failure. Inside the breaker,
// so one exhausted logical request counts as a single failure against the outage cooldown.
const DEFAULT_MAX_RETRIES = 2;

/** Read cap for raw-text bodies (requestText): job logs reach tens of MB, so stream-read
 *  only the first 512KB and cancel the rest. Diagnostic-only evidence -- a log whose
 *  failure lives beyond the cap loses its tail; the check's name/conclusion still gate.
 *  NOTE: this cut happens BEFORE redaction (redactSecrets in vcs-host.ts) and can split a
 *  multi-line secret across it, so that redactor must also match an unterminated block. */
const MAX_TEXT_BYTES = 512 * 1024;

// Stream-read at most maxBytes of the body, then cancel the reader (freeing the
// connection instead of draining the remainder). Non-fatal decode: a cap cut mid-codepoint
// becomes U+FFFD, which is fine for log diagnostics.
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
  }
  if (total >= maxBytes) await reader.cancel().catch(() => {});
  // A single chunk may overshoot the cap (read granularity), so the COPY is clamped --
  // the result never exceeds maxBytes.
  const kept = Math.min(total, maxBytes);
  const head = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= kept) break;
    const n = Math.min(chunk.byteLength, kept - offset);
    head.set(chunk.subarray(0, n), offset);
    offset += n;
  }
  return new TextDecoder().decode(head);
}

export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly resolveToken: TokenProvider;
  private readonly timeoutMs: number;
  private readonly breaker: CircuitBreaker;
  private readonly maxRetries: number;
  private readonly sleepImpl?: (ms: number) => Promise<void>;

  constructor(config: GitHubClientConfig) {
    if (!config.token && !config.tokenProvider) {
      throw new Error('GitHubClient: one of token or tokenProvider is required');
    }
    this.resolveToken = config.tokenProvider ?? (async () => config.token as string);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.baseUrl = config.baseUrl ?? 'https://api.github.com';
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.breaker = config.breaker ?? new CircuitBreaker({ provider: 'github', countsAsFailure: isTransientFault });
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.sleepImpl = config.sleepImpl;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    // The breaker wraps the WHOLE logical request -- transient-fault retries and
    // status->error conversion included -- so a 5xx that survives every retry actually
    // reaches its failure counter (a bare fetch resolves even for a 502; only this level
    // sees the throw). While open it throws BreakerOpenError before any network attempt.
    return this.breaker.run(() =>
      resilientRequest(async () => {
        const res = await this.send(method, path, body);

        const text = await res.text();
        const data: unknown = text.length > 0 ? JSON.parse(text) : undefined;

        if (!res.ok) {
          const message = isRecord(data) && typeof data.message === 'string' ? data.message : res.statusText;
          throw new GitHubApiError(res.status, method, path, message, parseRetryAfterMs(res.headers.get('retry-after')), isRateLimited(res.headers));
        }

        return data as T | undefined;
      }, { maxRetries: this.maxRetries, sleep: this.sleepImpl }),
    );
  }

  /** Like request(), but resolves to undefined instead of throwing on a 404. */
  async requestOptional<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    try {
      return await this.request<T>(method, path, body);
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) return undefined;
      throw err;
    }
  }

  /** Raw-body variant for endpoints that answer text/plain rather than JSON (today:
   *  the Actions job-logs read behind VCSHost.getCheckLogTail). Resolves the body as a
   *  string, or undefined when the call fails for ANY reason -- these reads are
   *  best-effort diagnostics and their absence must degrade to "no evidence", never
   *  break the drive loop (403 = token lacks actions:read, 404 = logs expired or gone).
   *  Provider faults still count against the breaker: the throw happens inside run().
   *  The READ itself is capped at MAX_TEXT_BYTES -- job logs can be tens of MB, so bytes
   *  past the cap are never buffered (a log whose failure lives beyond the cap loses its
   *  tail; acceptable for diagnostic-only evidence). */
  async requestText(method: string, path: string): Promise<string | undefined> {
    try {
      return await this.breaker.run(async () => {
        const res = await this.send(method, path);
        const text = await readCapped(res, MAX_TEXT_BYTES);
        if (!res.ok) throw new GitHubApiError(res.status, method, path, res.statusText || 'error');
        return text;
      });
    } catch {
      return undefined;
    }
  }

  /** One raw HTTP attempt (token resolution included). Never called while the breaker
   *  is open. */
  private async send(method: string, path: string, body?: unknown): Promise<Response> {
    const token = await this.resolveToken();
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}

// GitHub throttles with a 403 (primary rate limit, secondary/abuse limits) far more often
// than a 429, and marks it either with a Retry-After or, on a burst without one, with
// x-ratelimit-remaining: 0. Either makes the response a rate limit rather than a real
// permission denial -- a plain auth/permission 403 has neither (you still had budget), so it
// stays non-transient and fails fast.
function isRateLimited(headers: Headers): boolean {
  return headers.get('retry-after') !== null || headers.get('x-ratelimit-remaining') === '0';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
