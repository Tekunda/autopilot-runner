// vision-gate: the shared factory behind the vision-judge heavy gates -- visual-qa (the
// conservative breakage rubric) and design-review (the aggressive aesthetics rubric). Both render
// the diff's affected routes against the SERVED site in a headless browser, screenshot each at a
// responsive viewport sweep, and send the shots to a Claude vision model with a rubric PROFILE +
// the tenant's judging criteria. Only the profile differs between the two gates; the derive ->
// screenshot -> judge -> verdict machinery is identical, so it lives here once and each gate is a
// one-line `createVisionGate({ id, profile })` (see visual-qa.ts / design-review.ts).
//
// TARGET DERIVATION (§4): a changed content/page file maps to the route it serves (mirroring the
// SEO pack's content-file convention: `<contentDir>/foo/bar.md` -> `/foo/bar`, `index.md` -> the
// parent route). A changed SHARED asset (global layout/CSS/a widely-used component) can break
// EVERY page, so it maps to a small representative sample of routes instead of a single page. If
// the diff maps to no renderable route the gate SKIPS (nothing this PR touched can be rendered),
// never fails. `alwaysCheck` routes are an optional override, but the default is diff-driven --
// there is no required static target list.
//
// This runs ONLY in the dedicated heavy stage -- the only stage with a browser and a live server
// (src/runner/serve-and-gate.ts). It judges a SETTLED local build (§11): the served instance the
// heavy stage brought up, never a mid-rollout production deploy, so it flags real layout breakage
// rather than transient deploy-skew.
//
// Everything site-specific is config (ctx.config[<gate id>]): the served baseUrl (threaded in by
// the serve stage), the executor credential the vision judge authenticates with (threaded in the
// same way), the content dir / global-asset patterns / representative routes the file->route
// mapping uses, viewports, judging criteria, and model id. The gate hardcodes none of it. Both the
// browser and the vision judge are injectable, so the derive->screenshot->judge->verdict logic is
// unit-testable with fakes and never needs a real browser or API key in tests -- but the DEFAULT
// judge does the real model call (judge.ts), never a stubbed pass.
//
// NEVER A SILENT PASS (the false-green post-mortem): a page the judge could not score is never
// reported as a page it scored and liked. What it IS reported as depends on WHY it could not be
// scored, and the two answers are deliberately different -- `fail` when the judge ran and the page
// was wrong, or when anything other than a rate limit stopped it, and a fail-open `skip` with
// `skipReason:'infra'` when the model API itself was unavailable. Neither is `warn` and neither is
// `pass`. The aggregation at the bottom of `run` says why the rate-limit arm is a skip rather than
// the merge-blocking `unjudged` it used to be.

import {
  asGateNotes,
  createContentReader,
  selectPages,
  type ContentFormat,
  type ContentReader,
} from '../content/reader.ts';
import {
  appRouteFor,
  DEFAULT_GLOBAL_PATTERNS,
  DEFAULT_REPRESENTATIVE_ROUTES,
  isGlobalAsset,
  isWrapperRouteFile,
  matchesAnyGlob,
  normalizeRoute,
} from '../content/route-targets.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';
import { createPlaywrightBrowser, type ScreenshotBrowser } from './browser.ts';
import {
  createAnthropicVisionJudge,
  VisionRateLimitError,
  viewportLabelFor,
  type AnthropicVisionJudgeOptions,
  type ExecutorCredential,
  type JudgeShot,
  type VisionJudge,
  type VisionRubricProfile,
} from './judge.ts';
import type { Screenshot } from './browser.ts';

export interface VisionGateViewport {
  width: number;
  height: number;
  name?: string;
}

export interface VisionGateConfig {
  // The served site root -- threaded in by the heavy stage (serve-and-gate.ts) at run time, since
  // the local server's URL cannot be known at grant-issue time. Absent -> the gate skips (nothing
  // to render), never fails, so a tenant with no serve stage wired is not blocked.
  baseUrl?: string;
  // The tenant's model credential for the vision judge -- threaded in by the heavy stage off the
  // coding-executor-config, the SAME credential every other AI step uses. Absent -> the judge
  // falls back to ANTHROPIC_API_KEY, else fails closed (never a silent pass).
  executorCredential?: ExecutorCredential;
  // Directory (relative to the checkout root) whose files are renderable content pages, mirroring
  // the SEO pack's convention. A changed content file under it maps to the route it serves. Default
  // `content`.
  contentDir?: string;
  // Content-tree format the file->route mapping uses: markdown pages ('md', default), JSON
  // pages ('json', route taken from each page's `slug`), or a mix ('auto'). Mirrors the SEO pack.
  contentFormat?: ContentFormat;
  // Locale a JSON page is read from when deriving its route (json/auto only). Default 'en'.
  baseLocale?: string;
  // Substrings that mark a changed file as a SHARED/global asset (a global layout, CSS, a
  // widely-used component) -- a change to one can break every page, so it maps to the
  // representative route sample rather than a single page. Matched as a substring of the changed
  // path. Defaults to common global-style/layout markers.
  globalPatterns?: string[];
  // The small representative route sample screenshotted when a shared asset changed. Kept minimal
  // (a guessed route that 404s would just fail closed); a tenant extends it with its key pages.
  // Default `['/']`.
  representativeRoutes?: string[];
  // The app-router source ROOT (relative to the checkout root) under which route directories live,
  // e.g. `apps/<app>/app/[locale]`. Set -> a changed route source file (a Next.js route file or a
  // colocated i18n dictionary) under it derives the route of its own directory
  // (`.../products/<product>/page.jsx` -> `/products/<product>`), so a changed UI component page
  // maps to a route even when its copy lives in the app i18n dictionary rather than a content
  // record. Unset -> path derivation is off and only content records / global-asset fanout map
  // files (backward compatible), mirroring layout-rules.
  appDir?: string;
  // Globs (checkout-root-relative, `*`/`?` wildcards) matching SHARED source files that back
  // specific routes but sit OUTSIDE a route dir (a shared section component). A change to one fans
  // out to `representativeRoutes`, same as a global asset -- so a bounded, config-declared set of
  // shared components triggers the configured routes without per-file route derivation. Mirrors
  // layout-rules.
  sharedSourceGlobs?: string[];
  // Routes ALWAYS screenshotted regardless of the diff -- an override, not a substitute: the
  // default behavior remains diff-driven when this is unset/empty.
  alwaysCheck?: string[];
  // The responsive viewport sweep to render each route at. Defaults to DEFAULT_SWEEP -- both phone
  // orientations, both tablet orientations, and desktop -- so a size that is wrong RELATIVE to the
  // sizes that look right (a header fine in portrait but broken in landscape, a link that wraps
  // only at tablet width) is caught. A tenant overrides it with its own list. Cost scales with the
  // viewport count, but the judge is BATCHED to ONE call per route (all of a route's shots go in a
  // single differential call), so the marginal cost of another viewport is one more image, not one
  // more model call.
  viewports?: VisionGateViewport[];
  // Gate-wide judging rubric. Falls back to the active profile's defaultCriteria when unset.
  criteria?: string[];
  // Vision model id override (defaults to judge.ts DEFAULT_VISION_MODEL).
  model?: string;
  maxTokens?: number;
  // How many times a 429/529 is retried before the judge surfaces an infra-skip. Default is the
  // judge's DEFAULT_MAX_RETRIES (4); tenant-tunable so a throttled account can widen the retry budget.
  maxRetries?: number;
  // Minimum ms between successive vision-model call STARTS across BOTH vision gates (the limiter is
  // process-wide). Default 0 (off); opt-in per tenant to pace heavy calls under the account's ITPM.
  minIntervalMs?: number;
}

export interface VisionGateDeps {
  // Injected browser/judge for tests; the defaults are real Playwright + the Anthropic vision
  // judge, constructed lazily inside run() so the gate can be registered with no browser or API
  // key present at construction time.
  browser?: ScreenshotBrowser;
  judge?: VisionJudge;
  // Overridable factory for the default browser (tests assert the default path without launching
  // Chromium). Only used when `browser` is not injected.
  createBrowser?: () => Promise<ScreenshotBrowser>;
  // Overridable factory for the default vision judge, mirroring createBrowser: tests assert the
  // config->judge passthrough (model/maxTokens/credential/maxRetries/minIntervalMs) without a real
  // API call. Only used when `judge` is not injected.
  createJudge?: (opts: AnthropicVisionJudgeOptions) => VisionJudge;
}

// The responsive default sweep, used when a tenant sets no `viewports`. Covers both phone
// orientations, both tablet orientations, and desktop, so the differential judge sees the same
// route across the breakpoints where responsive layout typically diverges. Dimensions are the
// engine's documented defaults (no tenant/route/brand meaning); a tenant overrides via `viewports`.
export const DEFAULT_SWEEP: VisionGateViewport[] = [
  { width: 393, height: 852, name: 'phone-portrait' },
  { width: 852, height: 393, name: 'phone-landscape' },
  { width: 768, height: 1024, name: 'tablet-portrait' },
  { width: 1024, height: 768, name: 'tablet-landscape' },
  { width: 1280, height: 800, name: 'desktop' },
];
const DEFAULT_CONTENT_DIR = 'content';

// A route to render, plus WHY the diff selected it (logged so a run is self-describing about the
// pages it chose -- especially the representative sample a global change fans out to).
interface RenderTarget {
  path: string;
  reason: string;
}

function resolveConfig(ctx: GateContext, id: string): VisionGateConfig | undefined {
  const raw = ctx.config[id] as VisionGateConfig | undefined;
  return raw && typeof raw === 'object' ? raw : undefined;
}

// A changed app-router source file (page/layout/i18n) under `appDir` maps to the route of its own
// directory -- so a changed UI component page is screenshotted even when it has no content record.
// A file inside the content tree that is not a page is skipped: inventing a route from its directory
// would be wrong (mirrors layout-rules' diffRoutes). Empty when `appDir` is unset (backward compat).
function appSourceTargets(
  ctx: GateContext,
  config: VisionGateConfig,
  contentPages: Set<string>,
  reader: ContentReader,
): { route: string; file: string }[] {
  if (!config.appDir) return [];
  const out: { route: string; file: string }[] = [];
  for (const file of ctx.changedFiles) {
    if (contentPages.has(file) || reader.isContentFile(file)) continue;
    const route = appRouteFor(file, config.appDir);
    if (route) out.push({ route, file });
  }
  return out;
}

// Whether a changed file fans out to `representativeRoutes` rather than a single page: a shared/
// global asset, a config-declared shared source file, or a wrapper layout/template that wraps a
// subtree. Matches layout-rules' fanout trigger.
function triggersFanout(
  file: string,
  config: VisionGateConfig,
  globalPatterns: string[],
  sharedSourceGlobs: string[],
): boolean {
  return (
    isGlobalAsset(file, globalPatterns) ||
    matchesAnyGlob(file, sharedSourceGlobs) ||
    // Truthiness, matching the `if (!config.appDir) return []` derivation guard so an empty
    // `appDir` reads as "unset" everywhere.
    (config.appDir ? isWrapperRouteFile(file, config.appDir) : false)
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Turn the diff into the SET of routes to screenshot, deduped by path (first reason wins). A
// changed content file -> its own route; any changed shared asset -> the representative sample;
// `alwaysCheck` routes -> always, independent of the diff.
async function deriveTargets(
  ctx: GateContext,
  config: VisionGateConfig,
  selectionNotes: string[],
): Promise<RenderTarget[]> {
  const contentDir = config.contentDir ?? DEFAULT_CONTENT_DIR;
  const reader = createContentReader(config.contentFormat ?? 'md', {
    rootDir: ctx.workspaceRoot,
    contentDir,
    ...(config.baseLocale ? { baseLocale: config.baseLocale } : {}),
  });
  const globalPatterns = config.globalPatterns ?? DEFAULT_GLOBAL_PATTERNS;
  const sharedSourceGlobs = config.sharedSourceGlobs ?? [];
  const representativeRoutes =
    config.representativeRoutes && config.representativeRoutes.length > 0
      ? config.representativeRoutes
      : DEFAULT_REPRESENTATIVE_ROUTES;

  const byPath = new Map<string, RenderTarget>();
  const add = (route: string, reason: string): void => {
    const p = normalizeRoute(route);
    if (!byPath.has(p)) byPath.set(p, { path: p, reason });
  };

  for (const route of config.alwaysCheck ?? []) add(route, 'alwaysCheck override');

  const { pages, notes } = await selectPages(reader, ctx.changedFiles);
  const contentPages = new Set(pages);
  for (const file of pages) {
    add(await reader.routeFor(file), `changed page ${file}`);
  }
  selectionNotes.push(...notes);

  for (const { route, file } of appSourceTargets(ctx, config, contentPages, reader)) {
    add(route, `changed route source ${file}`);
  }

  const fanoutHits = ctx.changedFiles.filter((file) =>
    triggersFanout(file, config, globalPatterns, sharedSourceGlobs),
  );
  if (fanoutHits.length > 0) {
    const reason = `shared asset changed (${fanoutHits.join(', ')})`;
    for (const route of representativeRoutes) add(route, reason);
  }

  return [...byPath.values()];
}

// Build a vision-judge gate for `opts.id`, framed by `opts.profile`. `opts.deps` injects a fake
// browser/judge in tests; production leaves it empty and the real Playwright browser + Anthropic
// judge are built lazily on first run. The vision judge is asked to score against `opts.profile`,
// so two gates share this whole pipeline and diverge only in their rubric.
export function createVisionGate(opts: { id: string; profile: VisionRubricProfile; deps?: VisionGateDeps }): Gate {
  const { id, profile } = opts;
  const deps = opts.deps ?? {};
  return {
    id,
    async run(ctx: GateContext): Promise<GateResult> {
      const config = resolveConfig(ctx, id);
      if (!config?.baseUrl) {
        // No served URL -> nothing to render. Skip cleanly (the serve stage that supplies baseUrl
        // is a prerequisite).
        return { id, status: 'skip' };
      }

      const selectionNotes: string[] = [];
      const targets = await deriveTargets(ctx, config, selectionNotes);
      if (targets.length === 0) {
        // The diff maps to no renderable route -> nothing THIS PR touched can be screenshotted.
        // Skip with a reason rather than fail (a diff that changes no page/asset is not a defect).
        // `skipReason` is set so a perpetual skip stays diagnosable (see SkipReason), and the
        // per-file notes say WHICH files were passed over and why.
        return {
          id,
          status: 'skip',
          skipReason: 'no-matching-route',
          findings: ['no changed file maps to a renderable route', ...asGateNotes(selectionNotes)],
        };
      }
      for (const note of selectionNotes) process.stdout.write(`[${id}] ${note}\n`);

      for (const target of targets) {
        process.stdout.write(`[${id}] screenshotting ${target.path} -- ${target.reason}\n`);
      }

      const baseUrl = config.baseUrl.replace(/\/$/, '') + '/';
      const viewports = config.viewports && config.viewports.length > 0 ? config.viewports : DEFAULT_SWEEP;
      const criteria = config.criteria ?? [];

      const injectedBrowser = deps.browser;
      const browser =
        injectedBrowser ?? (await (deps.createBrowser ?? createPlaywrightBrowser)());
      const judge =
        deps.judge ??
        (deps.createJudge ?? createAnthropicVisionJudge)({
          ...(config.model ? { model: config.model } : {}),
          ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
          ...(config.executorCredential ? { credential: config.executorCredential } : {}),
          ...(config.maxRetries != null ? { maxRetries: config.maxRetries } : {}),
          ...(config.minIntervalMs != null ? { minIntervalMs: config.minIntervalMs } : {}),
        });

      // Real visual defects (or non-transient errors): these BLOCK the merge.
      const failures: string[] = [];
      // Pages the vision judge could not score because the model API stayed rate-limited/overloaded
      // even after the judge's own backoff+retries. This is a TRANSIENT INFRA failure, not a visual
      // defect, so it must not read as one -- it is tracked separately and, when nothing else
      // failed, makes the gate a fail-open `skip` with `skipReason:'infra'` (see the aggregation
      // below): the judging infrastructure was down, which is a statement about the provider and
      // not about this diff.
      const inconclusive: string[] = [];
      try {
        for (const target of targets) {
          const url = new URL(target.path, baseUrl).toString();

          // First render every viewport for this route. A screenshot that itself fails to capture is
          // a page we cannot verify -> fail closed (unchanged from before); it is dropped from the
          // batch so the surviving shots are still judged.
          const shots: JudgeShot[] = [];
          for (const viewport of viewports) {
            try {
              const screenshot: Screenshot = await browser.screenshot(url, viewport);
              shots.push({ viewport, screenshot });
            } catch (err) {
              failures.push(`${viewportLabel(target, viewport)}: could not verify (${errMsg(err)})`);
            }
          }
          if (shots.length === 0) continue;

          // Then ONE differential judge call carrying all of the route's shots. The per-viewport
          // verdicts drive the SAME failures/inconclusive collections as before, one finding per
          // viewport, keyed back to each shot by its label.
          try {
            const verdicts = await judge.judge({ url, shots, criteria, profile });
            for (const shot of shots) {
              const label = viewportLabel(target, shot.viewport);
              const verdict = verdicts.find((v) => v.viewport === viewportLabelFor(shot.viewport));
              if (!verdict) {
                // parseVerdict guarantees a verdict for every requested viewport, so this only trips
                // on an injected fake that under-reports -- still never a silent pass.
                failures.push(`${label}: could not verify (judge returned no verdict for this viewport)`);
              } else if (!verdict.pass) {
                failures.push(`${label}: ${verdict.reason || `${id} verdict: fail`}`);
              }
            }
          } catch (err) {
            if (err instanceof VisionRateLimitError) {
              // Rate-limited past the retry budget -> inconclusive, not a defect. The whole route's
              // batch could not be judged, so every viewport is labeled inconclusive.
              for (const shot of shots) {
                inconclusive.push(
                  `${viewportLabel(target, shot.viewport)}: could not verify -- model API rate-limited (${err.status}); transient infra issue, not a visual defect`,
                );
              }
            } else {
              // Could not judge for a non-transient reason -> fail closed. A page we cannot verify is
              // NOT a pass (the judge is never stubbed to pass); report why, per viewport.
              for (const shot of shots) {
                failures.push(`${viewportLabel(target, shot.viewport)}: could not verify (${errMsg(err)})`);
              }
            }
          }
        }
      } finally {
        // Only close a browser this gate created; an injected one is the caller's to manage.
        if (!injectedBrowser) {
          await browser.close().catch(() => {});
        }
      }

      // Aggregation:
      // - Any real defect (or non-transient error) -> `fail` (blocks the merge). Its findings carry
      //   the inconclusive ones too, so nothing is hidden when the run also hit rate limits.
      // - No real defect but some page was rate-limited into inconclusive -> `skip`
      //   (skipReason 'infra'): the judge could not be reached, so the gate evaluated nothing.
      //   NOT a pass and NOT a fail -- "could not verify" is neither "verified fine" nor "broken".
      //   Whether that skip blocks is NOT decided here: run-gate-stage promotes it to a blocking
      //   `unjudged`/`infra` when THIS gate is blocking (`blocking:true`), and leaves it a
      //   fail-open skip when the gate is report-only. See the inconclusive branch below.
      // - Everything scored and passed -> `pass`.
      if (failures.length > 0) {
        return { id, status: 'fail', findings: [...failures, ...inconclusive] };
      }
      if (inconclusive.length > 0) {
        // COULD-NOT-EVALUATE IS NOT A VERDICT, IN EITHER DIRECTION. Every `inconclusive` entry came
        // from a VisionRateLimitError, and that catch arm is the ONLY thing that pushes to this
        // array: judge.ts throws that type exclusively for a 429/529 that survived its own bounded
        // backoff. So this branch means exactly one thing -- the model API was unavailable and the
        // judge never ran against these pages. Nothing was examined, so there is nothing to say
        // about the diff.
        //
        // It is reported the way this codebase already reports a gate that did not run: `skip` with
        // `skipReason:'infra'`. This is the HONEST GATE-LEVEL TRUTH -- the gate judged nothing --
        // and it deliberately does NOT decide the merge outcome by itself, because that depends on
        // whether the TENANT made this gate blocking, a fact the gate does not see. run-gate-stage
        // owns that decision at its `adjudicated` seam: for a REPORT-ONLY gate the skip stays as
        // published here (toChecks -> `pending` + `skipped:true` + `skipReason`, carrying the
        // per-page "could not verify" findings), fail-open exactly as before; for a BLOCKING gate
        // the same infra-skip is promoted to `unjudged`/`infra`, which blocks the stage and flows
        // the bounded infra retry lane rather than green-lighting a diff no vision gate examined.
        // Either way it is loudly not-a-pass: gate-coverage banks nothing for a skipped check, and
        // gate-verdict-ledger classes an `infra` skip SUSPICIOUS, so a judge that is down on every
        // promotion still raises `gate_never_fired` instead of going quiet. This is the same skip
        // shape as layout-gate.ts's own browser-infra arm and serve-and-gate.ts's per-site skips.
        //
        // THE DEMOTION KEYS ON A TYPED, POSITIVE SIGNAL, never on a catch-all `else` or a bare
        // exception handler -- so a coding error cannot launder itself into "unjudged" and sail
        // through. A malformed model response, a missing credential, a 400/401/5xx, a page that
        // would not render and every other throw go to `failures` and still FAIL, and an exception
        // escaping this gate entirely is recorded as a `fail` by runGates.
        return { id, status: 'skip', skipReason: 'infra', findings: inconclusive };
      }
      return { id, status: 'pass' };
    },
  };
}

function viewportLabel(target: RenderTarget, viewport: VisionGateViewport): string {
  const vp = viewport.name ? `${viewport.name} ${viewport.width}x${viewport.height}` : `${viewport.width}x${viewport.height}`;
  return `${target.path} @ ${vp}`;
}
