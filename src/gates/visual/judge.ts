// The vision judge the Visual-QA gate scores each screenshot with (docs/ci-gate-refit-plan.md
// P5): send a rendered page to a Claude vision model with the tenant's judging criteria, get
// back a pass/fail verdict. This is the ONE place a heavy gate legitimately calls a model -- the
// criteria are tenant config (signed), not bundled IP, so it stays generalizable Autopilot
// mechanism rather than tenant-specific logic.
//
// VisionJudge is an INTERFACE first, so the gate is unit-testable with a fake judge and never
// needs a live API key in tests. The default implementation (createAnthropicVisionJudge) does
// the REAL call -- it is never stubbed to a passing verdict; a screenshot the model can't score
// surfaces as a thrown error the gate turns into a failure, never a silent pass.
//
// NOTE: the exact Anthropic vision message shape (a base64 `image` content block + a `text`
// block, `anthropic-version: 2023-06-01`) and the model id follow the standard Messages API and
// this repo's own model-tier convention (src/config/model-tiers.ts maps the deep/Opus tier to
// `claude-opus-5`). The `claude-api` skill was not installed in the build environment, so both
// are also PARAMETERIZED via config -- a tenant can override `model` per gate.

import type { Screenshot, Viewport } from './browser.ts';

export interface VisionVerdict {
  pass: boolean;
  reason: string;
}

export interface JudgeInput {
  url: string;
  viewport: Viewport;
  // The judging rubric for this page -- global gate criteria plus any per-target ones.
  criteria: string[];
}

// Scores one screenshot against its criteria. The default calls a Claude vision model; a test
// injects a fake. A thrown error means "could not judge" (API/parse failure) and the gate fails
// closed rather than passing an unscored page.
export interface VisionJudge {
  judge(screenshot: Screenshot, input: JudgeInput): Promise<VisionVerdict>;
}

// The Opus tier this repo already resolves for deep model work (src/config/model-tiers.ts).
// Overridable per gate via config.model.
export const DEFAULT_VISION_MODEL = 'claude-opus-5';
export const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
// OAuth/subscription tokens authenticate via `Authorization: Bearer` and require this beta
// opt-in header; they are NEVER sent on x-api-key. Matches how the claude-code-action steps
// (action.yml) authenticate a claude-code OAuth executor.
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

// Statuses that mean "provider is throttling/overloaded, try again" rather than a real defect
// in the request: 429 rate_limit_error and 529 overloaded_error. Anything else non-2xx (401 bad
// key, 400 bad request, 5xx server error) is NOT retried -- it won't fix itself with a wait.
const RETRYABLE_STATUSES = new Set([429, 529]);
// Up to this many RETRIES (so maxRetries+1 total attempts) before a rate-limit surfaces as an
// error. Bounded so a sustained outage can't park the heavy gate stage indefinitely.
const DEFAULT_MAX_RETRIES = 4;
// Exponential-backoff base and cap per attempt. A single wait is capped so an absurd Retry-After
// (or a high exponent) can't silently stall the gate; total wait is bounded by maxRetries anyway.
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 20_000;

// A rate-limit/overload that survived every retry. Distinct from a generic judge error so the
// gate can classify it as a TRANSIENT INFRA failure (inconclusive), not read a 429 as a visual
// defect. Carries the HTTP status (429/529) and the provider's error detail for the finding.
export class VisionRateLimitError extends Error {
  readonly status: number;

  constructor(status: number, detail: string) {
    super(`vision judge: model API rate-limited (${status})${detail ? ` ${detail}` : ''}`);
    this.name = 'VisionRateLimitError';
    this.status = status;
  }
}

// The tenant's model credential, threaded from the same coding-executor-config the reviewer/
// architect AI steps use (src/runner/adapters.ts executorCredential). Two shapes the executor
// can carry: a raw Anthropic API key, or an OAuth/subscription access token.
export type ExecutorCredential =
  | { mode: 'apiKey'; apiKey: string }
  | { mode: 'oauth'; oauthToken: string };

export interface AnthropicVisionJudgeOptions {
  // The executor credential to authenticate with -- the SAME one every other AI step uses,
  // threaded in by the heavy stage. Absent -> falls back to `apiKey`/ANTHROPIC_API_KEY below.
  credential?: ExecutorCredential;
  // Legacy/fallback raw API key. Defaults to process.env.ANTHROPIC_API_KEY. With neither a
  // credential nor a key, the judge throws on first use, which the gate reports as an inability
  // to verify (a failure), never a pass.
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  fetchImpl?: typeof fetch;
  apiUrl?: string;
  anthropicVersion?: string;
  // How many times a 429/529 is retried before surfacing as a VisionRateLimitError. Default 4.
  maxRetries?: number;
  // Injectable sleeper so tests exercise the backoff path without actually waiting. Defaults to
  // a real setTimeout-based delay.
  sleepImpl?: (ms: number) => Promise<void>;
}

// Resolve the credential to use: an explicitly-threaded executor credential wins; otherwise fall
// back to a raw API key (option or ANTHROPIC_API_KEY) as an apiKey-mode credential.
function resolveCredential(opts: AnthropicVisionJudgeOptions): ExecutorCredential | undefined {
  if (opts.credential) return opts.credential;
  const key = opts.apiKey ?? process.env.ANTHROPIC_API_KEY;
  return key ? { mode: 'apiKey', apiKey: key } : undefined;
}

// The auth headers for a credential: an OAuth token goes on Authorization: Bearer plus the beta
// opt-in header; an API key goes on x-api-key. (anthropic-version is added by the caller.)
function authHeaders(credential: ExecutorCredential): Record<string, string> {
  return credential.mode === 'oauth'
    ? { authorization: `Bearer ${credential.oauthToken}`, 'anthropic-beta': OAUTH_BETA_HEADER }
    : { 'x-api-key': credential.apiKey };
}

// The rubric prompt: the model must answer with a strict JSON verdict so the gate can parse a
// deterministic pass/fail out of a probabilistic model. The criteria are the tenant's, injected.
export function buildJudgePrompt(input: JudgeInput): string {
  const criteria = input.criteria.length > 0 ? input.criteria : DEFAULT_CRITERIA;
  const viewportLabel = input.viewport.name
    ? `${input.viewport.name} (${input.viewport.width}x${input.viewport.height})`
    : `${input.viewport.width}x${input.viewport.height}`;
  return [
    `You are a visual QA judge reviewing a full-page screenshot of ${input.url} rendered at ${viewportLabel}.`,
    'Judge the screenshot against these criteria:',
    ...criteria.map((c) => `- ${c}`),
    '',
    'Respond with ONLY a single JSON object and nothing else, in this exact shape:',
    '{"verdict": "pass" | "fail", "reason": "<one concise sentence>"}',
    'Fail if ANY criterion is violated. When you fail, name the specific problem in the reason.',
  ].join('\n');
}

export const DEFAULT_CRITERIA = [
  'The layout is intact and renders as a coherent page.',
  'No broken, overlapping, or overflowing elements.',
  'No obviously missing images, icons, or CSS (no unstyled/raw HTML, no broken-image placeholders).',
];

// Pull the verdict out of the model's reply. The prompt demands strict JSON, but a model may
// wrap it in prose or a code fence, so we extract the first JSON object. A reply we cannot parse
// into a verdict is a judging FAILURE (throw), not a silent pass.
export function parseVerdict(text: string): VisionVerdict {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { verdict?: unknown; reason?: unknown };
      const verdict = typeof parsed.verdict === 'string' ? parsed.verdict.toLowerCase() : undefined;
      if (verdict === 'pass' || verdict === 'fail') {
        return { pass: verdict === 'pass', reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
      }
    } catch {
      // fall through to the error below
    }
  }
  throw new Error(`vision judge returned an unparseable verdict: ${text.slice(0, 200)}`);
}

// How long to wait before the next retry. An honest Retry-After header (seconds per HTTP) wins,
// capped; otherwise exponential backoff with equal jitter -- half the exponential window is fixed
// (so a retry never fires effectively immediately) and half is random (so concurrent judges in
// the heavy stage don't all wake and re-burst in lockstep, re-tripping the same 429).
export function retryBackoffMs(attempt: number, retryAfter: string | null): number {
  const headerSec = Number(retryAfter);
  if (Number.isFinite(headerSec) && headerSec > 0) return Math.min(headerSec * 1_000, RETRY_CAP_MS);
  const window = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
  return Math.round(window / 2 + Math.random() * (window / 2));
}

interface AnthropicTextBlock {
  type: string;
  text?: string;
}
interface AnthropicMessagesResponse {
  content?: AnthropicTextBlock[];
}

export function createAnthropicVisionJudge(opts: AnthropicVisionJudgeOptions = {}): VisionJudge {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const model = opts.model ?? DEFAULT_VISION_MODEL;
  const maxTokens = opts.maxTokens ?? 1024;
  const apiUrl = opts.apiUrl ?? ANTHROPIC_MESSAGES_URL;
  const anthropicVersion = opts.anthropicVersion ?? ANTHROPIC_VERSION;
  const maxRetries = opts.maxRetries ?? DEFAULT_MAX_RETRIES;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return {
    async judge(screenshot: Screenshot, input: JudgeInput): Promise<VisionVerdict> {
      const credential = resolveCredential(opts);
      if (!credential) {
        throw new Error(
          'vision judge: no executor credential (expected an apiKey or OAuth executor credential, or ANTHROPIC_API_KEY)',
        );
      }

      const body = {
        model,
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: screenshot.mediaType, data: screenshot.base64 },
              },
              { type: 'text', text: buildJudgePrompt(input) },
            ],
          },
        ],
      };

      // Retry loop: a 429/529 is transient throttling, not a defect. Back off (honoring
      // Retry-After) and retry a bounded number of times; only an EXHAUSTED rate-limit surfaces,
      // and as a VisionRateLimitError the gate treats as inconclusive rather than a visual defect.
      for (let attempt = 0; ; attempt++) {
        const res = await fetchImpl(apiUrl, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...authHeaders(credential),
            'anthropic-version': anthropicVersion,
          },
          body: JSON.stringify(body),
        });

        if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
          // Drain/cancel the unconsumed body so undici releases the socket before the backoff.
          await res.body?.cancel().catch(() => {});
          await sleep(retryBackoffMs(attempt, res.headers.get('retry-after')));
          continue;
        }

        if (!res.ok) {
          // Best-effort detail: the status failure is always thrown below; a body that cannot be
          // read only means the error names the status without the response text.
          const detail = await res.text().catch((err: unknown) => {
            console.warn(
              `vision judge: could not read the error body for status ${res.status}: ` +
                `${err instanceof Error ? err.message : String(err)} -- the thrown error names the status without the body text`,
            );
            return '';
          });
          if (RETRYABLE_STATUSES.has(res.status)) {
            // Retries exhausted on a rate-limit/overload -- an infra failure, distinctly typed.
            throw new VisionRateLimitError(res.status, detail.slice(0, 200));
          }
          throw new Error(`vision judge: model API returned ${res.status} ${detail.slice(0, 200)}`);
        }

        const json = (await res.json()) as AnthropicMessagesResponse;
        const text = (json.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join('\n')
          .trim();
        if (!text) throw new Error('vision judge: model returned no text content');
        return parseVerdict(text);
      }
    },
  };
}
