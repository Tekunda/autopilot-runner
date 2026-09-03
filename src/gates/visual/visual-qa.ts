// visual-qa: the Visual-QA gate (docs/ci-gate-refit-plan.md P5, §4 -- BLOCKING for both sites).
// It runs on a PR, so the pages it screenshots are DIFF-DRIVEN: it derives the affected routes
// from ctx.changedFiles (never a static target list), renders each in a headless browser against
// the served site, screenshots it, and sends the screenshot to a Claude vision model with the
// tenant's judging criteria (layout intact, no broken/overflowing elements, no missing images/
// CSS). Any fail verdict fails the gate.
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
// Everything site-specific is config (ctx.config['visual-qa']): the served baseUrl (threaded in
// by the serve stage), the executor credential the vision judge authenticates with (threaded in
// the same way), the content dir / global-asset patterns / representative routes the file->route
// mapping uses, viewports, judging criteria, and model id. The gate hardcodes none of it. Both
// the browser and the vision judge are injectable, so the derive->screenshot->judge->verdict
// logic is unit-testable with fakes and never needs a real browser or API key in tests -- but the
// DEFAULT judge does the real model call (judge.ts), never a stubbed pass.
//
// UNJUDGED (post-mortem TEK-3691): when every page the judge could not score was blocked by a
// transient rate limit (no real defect found), the gate returns `unjudged`, NOT `warn`. A gate
// that ran but reached no verdict must not read as a pass even though it's non-blocking -- it fails
// closed and escalates to a human. `warn` would map to a pass; a green check on a gate that never
// judged is worse than no gate.

import { asGateNotes, createContentReader, selectPages, type ContentFormat } from '../content/reader.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';
import { createPlaywrightBrowser, type ScreenshotBrowser } from './browser.ts';
import {
  createAnthropicVisionJudge,
  VisionRateLimitError,
  type ExecutorCredential,
  type VisionJudge,
} from './judge.ts';

export const VISUAL_QA_GATE_ID = 'visual-qa';

export interface VisualQaViewport {
  width: number;
  height: number;
  name?: string;
}

export interface VisualQaConfig {
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
  // Content-tree format the file->route mapping uses: markdown pages ('md', default), Website JSON
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
  // Routes ALWAYS screenshotted regardless of the diff -- an override, not a substitute: the
  // default behavior remains diff-driven when this is unset/empty.
  alwaysCheck?: string[];
  // Defaults to a single 1280x800 desktop viewport when unset.
  viewports?: VisualQaViewport[];
  // Gate-wide judging rubric. Falls back to the judge's DEFAULT_CRITERIA when unset.
  criteria?: string[];
  // Vision model id override (defaults to judge.ts DEFAULT_VISION_MODEL).
  model?: string;
  maxTokens?: number;
}

export interface VisualQaDeps {
  // Injected browser/judge for tests; the defaults are real Playwright + the Anthropic vision
  // judge, constructed lazily inside run() so the gate can be registered with no browser or API
  // key present at construction time.
  browser?: ScreenshotBrowser;
  judge?: VisionJudge;
  // Overridable factory for the default browser (tests assert the default path without launching
  // Chromium). Only used when `browser` is not injected.
  createBrowser?: () => Promise<ScreenshotBrowser>;
}

const DEFAULT_VIEWPORTS: VisualQaViewport[] = [{ width: 1280, height: 800, name: 'desktop' }];
const DEFAULT_CONTENT_DIR = 'content';
const DEFAULT_GLOBAL_PATTERNS = ['.css', '.scss', '.sass', 'layout', 'theme', 'global'];
const DEFAULT_REPRESENTATIVE_ROUTES = ['/'];

// A route to render, plus WHY the diff selected it (logged so a run is self-describing about the
// pages it chose -- especially the representative sample a global change fans out to).
interface RenderTarget {
  path: string;
  reason: string;
}

function resolveConfig(ctx: GateContext): VisualQaConfig | undefined {
  const raw = ctx.config[VISUAL_QA_GATE_ID] as VisualQaConfig | undefined;
  return raw && typeof raw === 'object' ? raw : undefined;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeRoute(route: string): string {
  return route.startsWith('/') ? route : `/${route}`;
}

function isGlobalAsset(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => file.includes(pattern));
}

// Turn the diff into the SET of routes to screenshot, deduped by path (first reason wins). A
// changed content file -> its own route; any changed shared asset -> the representative sample;
// `alwaysCheck` routes -> always, independent of the diff.
async function deriveTargets(
  ctx: GateContext,
  config: VisualQaConfig,
  selectionNotes: string[],
): Promise<RenderTarget[]> {
  const contentDir = config.contentDir ?? DEFAULT_CONTENT_DIR;
  const reader = createContentReader(config.contentFormat ?? 'md', {
    rootDir: ctx.workspaceRoot,
    contentDir,
    ...(config.baseLocale ? { baseLocale: config.baseLocale } : {}),
  });
  const globalPatterns = config.globalPatterns ?? DEFAULT_GLOBAL_PATTERNS;
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
  for (const file of pages) {
    add(await reader.routeFor(file), `changed page ${file}`);
  }
  selectionNotes.push(...notes);

  const globalHits = ctx.changedFiles.filter((file) => isGlobalAsset(file, globalPatterns));
  if (globalHits.length > 0) {
    const reason = `shared asset changed (${globalHits.join(', ')})`;
    for (const route of representativeRoutes) add(route, reason);
  }

  return [...byPath.values()];
}

export function createVisualQaGate(deps: VisualQaDeps = {}): Gate {
  return {
    id: VISUAL_QA_GATE_ID,
    async run(ctx: GateContext): Promise<GateResult> {
      const config = resolveConfig(ctx);
      if (!config?.baseUrl) {
        // No served URL -> nothing to render. Skip cleanly (the serve stage that supplies baseUrl
        // is a prerequisite).
        return { id: VISUAL_QA_GATE_ID, status: 'skip' };
      }

      const selectionNotes: string[] = [];
      const targets = await deriveTargets(ctx, config, selectionNotes);
      if (targets.length === 0) {
        // The diff maps to no renderable route -> nothing THIS PR touched can be screenshotted.
        // Skip with a reason rather than fail (a diff that changes no page/asset is not a defect).
        // `skipReason` is set so a perpetual skip stays diagnosable (see SkipReason), and the
        // per-file notes say WHICH files were passed over and why.
        return {
          id: VISUAL_QA_GATE_ID,
          status: 'skip',
          skipReason: 'no-matching-route',
          findings: ['no changed file maps to a renderable route', ...asGateNotes(selectionNotes)],
        };
      }
      for (const note of selectionNotes) process.stdout.write(`[visual-qa] ${note}\n`);

      for (const target of targets) {
        process.stdout.write(`[visual-qa] screenshotting ${target.path} -- ${target.reason}\n`);
      }

      const baseUrl = config.baseUrl.replace(/\/$/, '') + '/';
      const viewports = config.viewports && config.viewports.length > 0 ? config.viewports : DEFAULT_VIEWPORTS;
      const criteria = config.criteria ?? [];

      const injectedBrowser = deps.browser;
      const browser =
        injectedBrowser ?? (await (deps.createBrowser ?? createPlaywrightBrowser)());
      const judge =
        deps.judge ??
        createAnthropicVisionJudge({
          ...(config.model ? { model: config.model } : {}),
          ...(config.maxTokens ? { maxTokens: config.maxTokens } : {}),
          ...(config.executorCredential ? { credential: config.executorCredential } : {}),
        });

      // Real visual defects (or non-transient errors): these BLOCK the merge.
      const failures: string[] = [];
      // Pages the vision judge could not score because the model API stayed rate-limited/overloaded
      // even after the judge's own backoff+retries. This is a TRANSIENT INFRA failure, not a visual
      // defect, so it must not read as one -- it's tracked separately and, when nothing else failed,
      // makes the gate `unjudged` (see aggregation below): it ran but reached no verdict, so it fails
      // closed to a human rather than passing the merge on a 429 burst.
      const inconclusive: string[] = [];
      try {
        for (const target of targets) {
          const url = new URL(target.path, baseUrl).toString();
          for (const viewport of viewports) {
            const label = viewportLabel(target, viewport);
            try {
              const screenshot = await browser.screenshot(url, viewport);
              const verdict = await judge.judge(screenshot, { url, viewport, criteria });
              if (!verdict.pass) {
                failures.push(`${label}: ${verdict.reason || 'visual-qa verdict: fail'}`);
              }
            } catch (err) {
              if (err instanceof VisionRateLimitError) {
                // Rate-limited past the retry budget -> inconclusive, not a defect. Labeled so a
                // reader (and the aggregation) can tell it apart from a real visual failure.
                inconclusive.push(
                  `${label}: could not verify -- model API rate-limited (${err.status}); transient infra issue, not a visual defect`,
                );
              } else {
                // Could not render or could not judge for a non-transient reason -> fail closed. A
                // page we cannot verify is NOT a pass (the judge is never stubbed to pass); report why.
                failures.push(`${label}: could not verify (${errMsg(err)})`);
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
      // - No real defect but some page was rate-limited into inconclusive -> `unjudged`: the gate
      //   RAN but reached no verdict. It is NOT a pass -- a green check on a gate that never judged
      //   is worse than no gate (post-mortem TEK-3691). It fails closed and escalates to a human,
      //   even though the gate is non-blocking; a transient 429 that outlasts the retries is the
      //   API's failure, but "could not verify" is not "verified fine".
      // - Everything scored and passed -> `pass`.
      if (failures.length > 0) {
        return { id: VISUAL_QA_GATE_ID, status: 'fail', findings: [...failures, ...inconclusive] };
      }
      if (inconclusive.length > 0) {
        // Every `inconclusive` entry came from a VisionRateLimitError (the ONLY branch that pushes
        // to it): the judge could not RUN because the model API stayed rate-limited past its
        // backoff. That is INFRA-class, not a no-verdict-about-the-page -- tag it so the fix loop
        // grants one gate-only retry (a 429 may clear) before escalating, instead of escalating a
        // human straight away. It stays `unjudged`, so it still fails closed and NEVER passes.
        return { id: VISUAL_QA_GATE_ID, status: 'unjudged', unjudgedReason: 'infra', findings: inconclusive };
      }
      return { id: VISUAL_QA_GATE_ID, status: 'pass' };
    },
  };
}

function viewportLabel(target: RenderTarget, viewport: VisualQaViewport): string {
  const vp = viewport.name ? `${viewport.name} ${viewport.width}x${viewport.height}` : `${viewport.width}x${viewport.height}`;
  return `${target.path} @ ${vp}`;
}

// The default-wired gate for the heavy stage's registry: real Playwright browser + real vision
// judge, both built lazily on first run.
export const visualQaGate: Gate = createVisualQaGate();
