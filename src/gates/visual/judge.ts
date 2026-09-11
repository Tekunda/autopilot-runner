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
import { defaultVisionLimiter, type VisionLimiter } from './vision-concurrency.ts';

// One viewport's verdict. `viewport` is the exact label (viewportLabelFor) the judge was asked to
// score, so the gate can map each verdict back to the shot it belongs to; `pass`/`reason` are the
// per-size result. The judge is DIFFERENTIAL: a size is judged against the sizes that look right,
// not against a static ideal, so a verdict names the viewport it concerns.
export interface VisionVerdict {
  viewport: string;
  pass: boolean;
  reason: string;
}

// One rendered size of the SAME route: the viewport it was rendered at plus its screenshot. A
// route's shots are sent together so the judge can compare sizes.
export interface JudgeShot {
  viewport: Viewport;
  screenshot: Screenshot;
}

export interface JudgeInput {
  url: string;
  // The SAME route rendered at several viewports, in the order the prompt lists them.
  shots: JudgeShot[];
  // The judging rubric for this page -- global gate criteria plus any per-target ones. Optional;
  // empty/absent falls back to the active profile's `defaultCriteria`.
  criteria?: string[];
  // Which rubric PROFILE frames the prompt -- the conservative breakage rubric (visual-qa) or the
  // aggressive aesthetics rubric (design-review). Absent -> CONSERVATIVE_PROFILE, so a caller that
  // does not set it gets byte-identical behavior to before profiles existed.
  profile?: VisionRubricProfile;
}

// A rubric PROFILE: the instruction lines that WRAP the criteria (how strict, what to flag, the
// output contract) plus the default criteria used when a caller passes none. Two profiles ship --
// CONSERVATIVE_PROFILE (visual-qa's breakage rubric, unchanged) and AGGRESSIVE_DESIGN_PROFILE
// (design-review's aesthetics rubric) -- so one judge/prompt/parse pipeline serves both gates and
// only the framing differs. `framing` may contain the CRITERIA_MARKER sentinel exactly once, which
// buildJudgePrompt expands into the criteria bullets so a profile controls WHERE its criteria sit.
export interface VisionRubricProfile {
  framing: string[];
  defaultCriteria: string[];
}

// Scores a route's shots against its criteria in ONE call, returning a per-viewport verdict array
// (one entry per requested viewport). The default calls a Claude vision model; a test injects a
// fake. A thrown error means "could not judge" (API/parse failure) and the gate fails closed
// rather than passing an unscored page.
export interface VisionJudge {
  judge(input: JudgeInput): Promise<VisionVerdict[]>;
}

// The canonical label for a viewport: `name (WxH)` when named, else `WxH`. Shared by the prompt,
// the per-image text blocks, and parseVerdict's validation so all three agree on what a verdict's
// `viewport` string must be.
export function viewportLabelFor(viewport: Viewport): string {
  return viewport.name
    ? `${viewport.name} (${viewport.width}x${viewport.height})`
    : `${viewport.width}x${viewport.height}`;
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
// error. Bounded so a sustained outage can't park the heavy gate stage indefinitely. Trimmed from
// 4 to 2 on purpose: the gate-level short-circuit (vision-gate.ts stops judging the remaining
// routes once ONE exhausts this budget) plus the proactive ITPM pacing (defaultVisionLimiter's
// minInterval) make a large per-call retry budget counterproductive -- it just multiplies the
// worst-case wall-time. With 2 the worst-case first-call wait is ~2 x RETRY_AFTER_CAP_MS (~3 min)
// before the route is declared inconclusive and the gate short-circuits, instead of ~6 min.
const DEFAULT_MAX_RETRIES = 2;
// Exponential-backoff base and cap per attempt. A single wait is capped so an absurd Retry-After
// (or a high exponent) can't silently stall the gate; total wait is bounded by maxRetries anyway.
const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 20_000;
// A server-directed Retry-After is honored up to a HIGHER ceiling than the exponential cap: when
// the account is contended Anthropic returns e.g. Retry-After: 60, and clamping that to 20s just
// retries into the still-throttled window and exhausts maxRetries before the throttle lifts. Cap
// the honored wait high enough to actually clear a typical throttle, still bounded so an absurd
// header can't park the gate.
const RETRY_AFTER_CAP_MS = 90_000;
// Per-fetch wall-clock ceiling. A single vision API call is aborted after this long so a socket that
// accepts the request but never sends a response cannot hang the call -- and thus the whole heavy
// stage -- indefinitely (there was NO per-fetch timeout before, so a dead socket parked the gate
// past the job timeout). A timed-out fetch is transient infra: it is retried like a 429 and, once
// the retry budget is spent, surfaced as a typed VisionRateLimitError so the gate demotes it to an
// infra skip rather than crashing the stage or reading it as a visual defect.
const FETCH_TIMEOUT_MS = 120_000;
// The status a spent fetch-timeout is surfaced under (RFC 7231 Request Timeout). It never comes from
// the server -- it is our own abort -- but tagging it onto VisionRateLimitError lets the gate's
// existing `instanceof` demotion treat it as the transient-infra signal it is.
const FETCH_TIMEOUT_STATUS = 408;

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
  // How many times a 429/529 (or a fetch timeout) is retried before surfacing as a
  // VisionRateLimitError. Default DEFAULT_MAX_RETRIES (2).
  maxRetries?: number;
  // Per-fetch wall-clock ceiling in ms; a call that does not respond within it is aborted and
  // retried as transient infra. Default FETCH_TIMEOUT_MS (120_000). Injectable so tests exercise the
  // abort path with a tiny value instead of a real 2-minute wait.
  fetchTimeoutMs?: number;
  // Injectable sleeper so tests exercise the backoff path without actually waiting. Defaults to
  // a real setTimeout-based delay.
  sleepImpl?: (ms: number) => Promise<void>;
  // Injectable clock so tests can exercise the HTTP-date form of Retry-After deterministically.
  // Defaults to Date.now.
  nowImpl?: () => number;
  // Serializes concurrent vision-model calls so the two vision gates don't self-inflict a 429.
  // Production OMITS this so every judge shares `defaultVisionLimiter` (the whole point -- one
  // process-wide gate across both gates); it exists only as a test-injection seam.
  limiter?: VisionLimiter;
  // Minimum ms between successive vision-model call STARTS on the shared limiter. OFF by default (0);
  // opt-in per tenant to space heavy calls under the account's input-tokens-per-minute limit, which
  // concurrency alone does not bound (successive serial calls can still burst past ITPM).
  minIntervalMs?: number;
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

// A sentinel line in a profile's `framing`: buildJudgePrompt replaces it with the criteria bullets
// (`- <criterion>`), so each profile decides WHERE its criteria appear among its instruction lines.
// Matched by WHOLE-LINE equality (`line === CRITERIA_MARKER`), and tenant criteria only ever render
// as `- <criterion>` bullets, so a tenant string can never occupy a framing-line slot -- the exact
// sentinel value is irrelevant to safety, so a plain-ASCII token is fine.
const CRITERIA_MARKER = '__CRITERIA_MARKER__';

// The DIFFERENTIAL rubric prompt: the model is shown the SAME route rendered at several sizes and
// must answer with a strict per-viewport JSON verdict, so the gate can parse a deterministic
// pass/fail per size out of a probabilistic model. The framing comes from the active PROFILE
// (default CONSERVATIVE_PROFILE) and the criteria are the tenant's, injected where the profile's
// CRITERIA_MARKER sits.
export function buildJudgePrompt(input: JudgeInput): string {
  const profile = input.profile ?? CONSERVATIVE_PROFILE;
  const criteria = input.criteria && input.criteria.length > 0 ? input.criteria : profile.defaultCriteria;
  const labels = input.shots.map((s) => viewportLabelFor(s.viewport));
  const framing = profile.framing.flatMap((line) =>
    line === CRITERIA_MARKER ? criteria.map((c) => `- ${c}`) : [line],
  );
  return [
    `You are a visual QA judge reviewing the SAME page (${input.url}) rendered at ${labels.length} viewport sizes.`,
    'The screenshots are provided in this order, each immediately preceded by its viewport label:',
    ...labels.map((label, i) => `${i + 1}. ${label}`),
    '',
    ...framing,
  ].join('\n');
}

export const DEFAULT_CRITERIA = [
  'The layout is intact and renders as a coherent page.',
  'No broken, overlapping, or overflowing elements.',
  'No obviously missing images, icons, or CSS (no unstyled/raw HTML, no broken-image placeholders).',
];

// The CONSERVATIVE (breakage) rubric visual-qa ships with: fail only on a CLEAR divergence, never a
// subjective nitpick. Its framing is byte-for-byte the lines the prompt hard-coded before profiles
// existed, so a JudgeInput without a profile builds an identical prompt (guarded in judge.test.ts).
export const CONSERVATIVE_PROFILE: VisionRubricProfile = {
  framing: [
    'Judge EACH viewport on TWO independent tests, and mark the size a FAIL if EITHER applies:',
    'TEST 1 (absolute) -- the layout at this size violates any of these criteria, regardless of how',
    'the other sizes look (so a defect present at EVERY size is still a fail at every size):',
    CRITERIA_MARKER,
    'TEST 2 (differential) -- compare the sizes against one another, treat the sizes that look',
    'correct as the reference for the intended design, and flag where this size diverges from them:',
    '- misaligned or overlapping elements',
    '- text wrapping onto extra lines it should not',
    '- content overflow or clipping',
    '- large unintended dead space',
    '',
    'Mark a viewport as a FAIL only on a CLEAR divergence, never a subjective nitpick -- a false',
    'fail blocks a merge.',
    '',
    'Respond with ONLY a single JSON object and nothing else, in this exact shape:',
    '{"verdicts": [{"viewport": "<label>", "pass": true, "reason": "<one concise sentence>"}]}',
    'Include exactly one entry for EVERY viewport listed above, using its exact label. When a',
    'viewport fails, name the specific problem in its reason.',
  ],
  defaultCriteria: DEFAULT_CRITERIA,
};

// The AGGRESSIVE (aesthetics) rubric design-review ships with, distilled from the calibrated design
// critique rubric: catch "technically-passing but ugly" -- cramped spacing, edge-jammed clusters,
// broken/flat hierarchy, inconsistent rhythm -- and INVERT the conservative caution. Meeting a
// literal constraint (no overflow, one line) is not a defense here; cramming to satisfy a rule is
// exactly the defect it exists to catch. Calibration preserved: it still fails only on defects a
// designer would agree are wrong, never on taste, and biases against false-fails -- but it does NOT
// carry the "never a subjective nitpick" line, so a clear aesthetic weakness is a fail, not a note.
export const AGGRESSIVE_DESIGN_PROFILE: VisionRubricProfile = {
  framing: [
    'Judge EACH viewport as a senior product designer would -- for AESTHETIC and layout quality, not',
    'merely whether it technically renders. Flag a clear aesthetic weakness even when the layout is',
    'technically functional, and mark the size a FAIL if any of these are present:',
    CRITERIA_MARKER,
    'Also compare the sizes against one another: treat the sizes that look right as the reference and',
    'flag where this size diverges (misaligned or overlapping elements, text wrapping onto extra',
    'lines, content overflow or clipping, large unintended dead space).',
    '',
    'Meeting a literal constraint is NOT a defense: "no overflow" or "fits on one line" does not',
    'excuse a squeezed, jammed, or edge-crammed result -- cramming to satisfy a rule is exactly the',
    'defect this review exists to catch.',
    'Do not fail on taste (color palette, font choice, minimal-vs-rich, or which of two clean layouts',
    'is nicer): two clean but different layouts both PASS, and a defect must be visible in the',
    'screenshot. But when a size is genuinely cramped, unbalanced, or hierarchy-less, FAIL it -- do',
    'not soften a real defect to avoid failing.',
    '',
    'Respond with ONLY a single JSON object and nothing else, in this exact shape:',
    '{"verdicts": [{"viewport": "<label>", "pass": true, "reason": "<one concise sentence>"}]}',
    'Include exactly one entry for EVERY viewport listed above, using its exact label. When a',
    'viewport fails, name the specific problem in its reason.',
  ],
  defaultCriteria: [
    'The layout has deliberate breathing room -- groups are separated by clearly more space than exists within a group; nothing is wall-to-wall or cramped.',
    'Visual weight is balanced, not shoved to one side or jammed against an edge leaving dead space opposite.',
    'There is a clear hierarchy with one obvious focal point, not a flat wall of equal-weight content.',
    'Spacing rhythm and alignment are consistent across elements, with no squeezed or off-rhythm clusters.',
  ],
};

// Pull the per-viewport verdict array out of the model's reply. The prompt demands strict JSON,
// but a model may wrap it in prose or a code fence, so we extract the first JSON object. The reply
// must carry a well-formed verdict for EVERY requested viewport label -- each with a boolean `pass`
// and a string `reason`; a reply missing a viewport, or malformed in any way, is a judging FAILURE
// (throw), NEVER a silent pass. The returned array is ordered to match `expectedLabels`.
export function parseVerdict(text: string, expectedLabels: string[]): VisionVerdict[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]) as { verdicts?: unknown };
      const verdicts = parsed.verdicts;
      if (Array.isArray(verdicts)) {
        const byLabel = new Map<string, VisionVerdict>();
        for (const entry of verdicts) {
          if (entry && typeof entry === 'object') {
            const { viewport, pass, reason } = entry as Record<string, unknown>;
            if (typeof viewport === 'string' && typeof pass === 'boolean' && typeof reason === 'string') {
              byLabel.set(viewport, { viewport, pass, reason });
            }
          }
        }
        if (expectedLabels.every((label) => byLabel.has(label))) {
          return expectedLabels.map((label) => byLabel.get(label)!);
        }
      }
    } catch {
      // fall through to the error below
    }
  }
  throw new Error(`vision judge returned an unparseable verdict: ${text.slice(0, 200)}`);
}

// How long to wait before the next retry. An honest Retry-After header (integer seconds, or an
// HTTP-date, per HTTP) wins and is honored up to RETRY_AFTER_CAP_MS -- NOT clamped to the shorter
// exponential cap, or a Retry-After: 60 would retry into the still-throttled window. Otherwise
// exponential backoff with equal jitter -- half the exponential window is fixed (so a retry never
// fires effectively immediately) and half is random (so concurrent judges in the heavy stage don't
// all wake and re-burst in lockstep, re-tripping the same 429).
export function retryBackoffMs(attempt: number, retryAfter: string | null, now: () => number = Date.now): number {
  const headerSec = Number(retryAfter);
  if (Number.isFinite(headerSec) && headerSec > 0) return Math.min(headerSec * 1_000, RETRY_AFTER_CAP_MS);
  if (retryAfter) {
    // HTTP-date form (RFC 7231): honor the delta to that instant if it parses to a future time.
    const dateMs = Date.parse(retryAfter);
    if (Number.isFinite(dateMs)) {
      const deltaMs = dateMs - now();
      if (deltaMs > 0) return Math.min(deltaMs, RETRY_AFTER_CAP_MS);
    }
  }
  const window = Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_CAP_MS);
  return Math.round(window / 2 + Math.random() * (window / 2));
}

// Emit ONE stderr line describing a retryable (429/529) response so a systematic first-call throttle
// can be diagnosed from the logs alone: the account's input-tokens-per-minute limit vs remaining
// tells a low tier apart from aggregate cross-runner exhaustion, Retry-After is what the server asks
// for, and the per-call image count / on-wire base64 size shows this request's magnitude. Reads only
// standard, non-secret rate-limit response headers -- never the credential or any request header.
// Every read is guarded (missing header -> `?`) and the whole thing is wrapped so a logging fault can
// NEVER throw into the retry path. Emitted on EACH retryable response so a persistent 429 prints the
// trend of `remaining`. A no-op for a non-retryable response, so the caller invokes it unconditionally
// after every fetch and this decides -- keeping the retry loop's own branching (and complexity) as-is.
function logRateLimitDiagnostic(res: Response, model: string, input: JudgeInput): void {
  if (!RETRYABLE_STATUSES.has(res.status)) return;
  try {
    const h = (name: string): string => res.headers.get(name) ?? '?';
    const images = input.shots.length;
    let b64Bytes = 0;
    for (const shot of input.shots) b64Bytes += shot.screenshot.base64.length;
    const line = [
      `status=${res.status}`,
      `retry-after=${h('retry-after')}`,
      `input-tokens-limit=${h('anthropic-ratelimit-input-tokens-limit')}`,
      `input-tokens-remaining=${h('anthropic-ratelimit-input-tokens-remaining')}`,
      `input-tokens-reset=${h('anthropic-ratelimit-input-tokens-reset')}`,
      `requests-limit=${h('anthropic-ratelimit-requests-limit')}`,
      `requests-remaining=${h('anthropic-ratelimit-requests-remaining')}`,
      `requests-reset=${h('anthropic-ratelimit-requests-reset')}`,
      `tokens-limit=${h('anthropic-ratelimit-tokens-limit')}`,
      `tokens-remaining=${h('anthropic-ratelimit-tokens-remaining')}`,
      `tokens-reset=${h('anthropic-ratelimit-tokens-reset')}`,
      `request-id=${h('request-id')}`,
      `model=${model}`,
      `images=${images}`,
      `approx-input-b64-bytes=${b64Bytes}`,
    ].join('; ');
    console.error(`[vision-429-diag] ${line}`);
  } catch (diagErr) {
    // Diagnostics must never break the retry path; a fault building the line is noted, not thrown.
    console.warn(
      `[vision-429-diag] could not emit the rate-limit diagnostic: ` +
        `${diagErr instanceof Error ? diagErr.message : String(diagErr)}`,
    );
  }
}

// True for the abort our own per-call timeout raises on a fetch that stopped responding. The timer
// aborts with a DOMException named 'TimeoutError'; a manual/other abort is 'AbortError'. Either means
// "the request did not complete in time" -- transient infra we retry, not a defect.
function isFetchTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
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
  const now = opts.nowImpl ?? Date.now;
  const limiter = opts.limiter ?? defaultVisionLimiter;
  const minIntervalMs = opts.minIntervalMs ?? 0;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;

  return {
    async judge(input: JudgeInput): Promise<VisionVerdict[]> {
      return limiter.run(async () => {
        const credential = resolveCredential(opts);
        if (!credential) {
          throw new Error(
            'vision judge: no executor credential (expected an apiKey or OAuth executor credential, or ANTHROPIC_API_KEY)',
          );
        }

        // One image block per shot, each IMMEDIATELY preceded by a text block naming its viewport,
        // in the same order the prompt lists them; the rubric prompt goes last.
        const content: Array<Record<string, unknown>> = [];
        for (const shot of input.shots) {
          content.push({ type: 'text', text: `Viewport: ${viewportLabelFor(shot.viewport)}` });
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: shot.screenshot.mediaType, data: shot.screenshot.base64 },
          });
        }
        content.push({ type: 'text', text: buildJudgePrompt(input) });

        const body = {
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content }],
        };

        // Retry loop: a 429/529 is transient throttling, not a defect. Back off (honoring
        // Retry-After) and retry a bounded number of times; only an EXHAUSTED rate-limit surfaces,
        // and as a VisionRateLimitError the gate treats as inconclusive rather than a visual defect.
        // The limiter permit is held ACROSS the backoff wait on purpose, so the other vision gate
        // cannot burst a call in during a Retry-After and re-trip the same 429.
        for (let attempt = 0; ; attempt++) {
          // A fresh per-attempt wall-clock ceiling: abort a call that stops responding so a dead
          // socket cannot hang the stage. The timer bounds THIS attempt, not the whole retry loop,
          // is unref'd so it never keeps the process alive, and is cleared the instant fetch settles.
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(new DOMException(`vision judge fetch exceeded ${fetchTimeoutMs}ms`, 'TimeoutError')),
            fetchTimeoutMs,
          );
          if (typeof timer.unref === 'function') timer.unref();
          let res: Response;
          try {
            res = await fetchImpl(apiUrl, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...authHeaders(credential),
                'anthropic-version': anthropicVersion,
              },
              body: JSON.stringify(body),
              signal: controller.signal,
            });
          } catch (err) {
            // Our own fetch-timeout abort is transient infra: back off and retry like a 429, and once
            // the retry budget is spent surface it as the typed VisionRateLimitError the gate demotes
            // to an infra skip -- never a hang and never a false visual defect. Any OTHER fetch
            // rejection is left to propagate (fail closed), unchanged.
            if (isFetchTimeout(err)) {
              if (attempt < maxRetries) {
                await sleep(retryBackoffMs(attempt, null, now));
                continue;
              }
              throw new VisionRateLimitError(
                FETCH_TIMEOUT_STATUS,
                `vision judge fetch timed out after ${fetchTimeoutMs}ms`,
              );
            }
            throw err;
          } finally {
            clearTimeout(timer);
          }

          // Measurement first: log the rate-limit response detail on every throttled response,
          // whether we retry it or surface it exhausted below (a no-op otherwise). Headers only,
          // never the body.
          logRateLimitDiagnostic(res, model, input);

          if (RETRYABLE_STATUSES.has(res.status) && attempt < maxRetries) {
            // Drain/cancel the unconsumed body so undici releases the socket before the backoff.
            await res.body?.cancel().catch(() => {});
            await sleep(retryBackoffMs(attempt, res.headers.get('retry-after'), now));
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
          return parseVerdict(text, input.shots.map((s) => viewportLabelFor(s.viewport)));
        }
      }, { minIntervalMs });
    },
  };
}
