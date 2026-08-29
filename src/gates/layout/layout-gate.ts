// layout-rules: an OPTIONAL, deterministic declarative layout gate (TEK-3691 post-mortem
// "Deterministic layout rules, declared per tenant and repo"). It runs in the SAME served-site
// heavy harness as Visual-QA, but does ONLY getBoundingClientRect measurements against a tenant's
// declared rule set -- no model, no tokens, so it can never be rate-limited. Absent a rule set (or a
// served baseUrl) it is a zero-cost no-op skip. The rules it checks would have caught the F1 369px
// sibling-height void and the F5 640/1232 width-ratio the post-mortem is about.
//
// TARGET DERIVATION mirrors Visual-QA: a changed content/page file maps to the route it serves; a
// changed shared asset fans out to a representative route sample. Those diff-derived routes are then
// filtered by the config `routes` globs, and any GLOB-FREE (literal) `routes` entry is ALWAYS
// checked regardless of the diff (a tenant pins its key pages that way). No resulting route -> skip.
//
// Runs ONLY in the dedicated heavy stage -- the only stage with a browser and a live served site
// (src/runner/serve-and-gate.ts). It measures a SETTLED local build (§11), never a mid-rollout
// deploy. The browser is injectable so the derive->measure->evaluate->verdict logic is unit-testable
// with a fake and never needs a real Chromium in tests.
//
// FAIL-OPEN on infra: a browser/measure error is caught internally and the gate SKIPS with an
// explanatory finding -- it never throws (a thrown gate reads as fail and wedges the fix loop) and
// never blocks a merge on a Playwright/serve hiccup. Only a real geometry violation blocks.

import { readGateConfig } from '../generic/config.ts';
import { createContentReader, type ContentFormat } from '../../packs/seo/content.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';
import { createPlaywrightLayoutBrowser, type LayoutBrowser, type Viewport } from './browser.ts';
import { evaluateRules, measureSpecFor, normalizeRules, rulesForViewport, type LayoutRule } from './rules.ts';

export const LAYOUT_RULES_GATE_ID = 'layout-rules';

export interface LayoutViewport {
  width: number;
  height: number;
  name?: string;
}

export interface LayoutRulesConfig {
  // The served site root -- threaded in by the heavy stage (serve-and-gate.ts) at run time, since
  // the local server's URL cannot be known at grant-issue time. Absent -> the gate skips (nothing to
  // measure), never fails.
  baseUrl?: string;
  // The declared rule set, in the terse bare-key YAML form (e.g.
  // `- sibling_height_delta: { within: '.grid', max_px: 160 }`) or the tagged form. Absent/empty ->
  // the gate is a no-op skip.
  rules?: unknown;
  // Directory (relative to the checkout root) whose files are renderable content pages, mirroring
  // the SEO/Visual-QA convention. A changed content file under it maps to the route it serves.
  // Default `content`.
  contentDir?: string;
  // Content-tree format the file->route mapping uses ('md' default, 'json', or 'auto'). Mirrors
  // Visual-QA.
  contentFormat?: ContentFormat;
  // Locale a JSON page is read from when deriving its route (json/auto only). Default 'en'.
  baseLocale?: string;
  // Substrings that mark a changed file as a SHARED/global asset (a global layout, CSS, a
  // widely-used component) -- a change to one can break every page, so it maps to the representative
  // route sample. Defaults to common global-style/layout markers.
  globalPatterns?: string[];
  // The small representative route sample checked when a shared asset changed. Default `['/']`.
  representativeRoutes?: string[];
  // Route globs. Diff-derived routes are kept only if they match one of these; a GLOB-FREE (literal)
  // entry is ALWAYS checked regardless of the diff. `*`/`?` are wildcards. Absent/empty -> no filter
  // (every diff-derived route is a target).
  routes?: string[];
  // Defaults to a single 1280x800 desktop viewport when unset. A rule may pin itself to a subset of
  // these via its own `viewports` (list of widths); a rule without one runs at every viewport.
  viewports?: LayoutViewport[];
}

export interface LayoutRulesDeps {
  // Injected browser for tests; the default is real Playwright, constructed lazily inside run() so
  // the gate can be registered with no browser present at construction time.
  browser?: LayoutBrowser;
  // Overridable factory for the default browser (tests assert the default path without launching
  // Chromium). Only used when `browser` is not injected.
  createBrowser?: () => Promise<LayoutBrowser>;
}

const DEFAULT_VIEWPORTS: LayoutViewport[] = [{ width: 1280, height: 800, name: 'desktop' }];
const DEFAULT_CONTENT_DIR = 'content';
const DEFAULT_GLOBAL_PATTERNS = ['.css', '.scss', '.sass', 'layout', 'theme', 'global'];
const DEFAULT_REPRESENTATIVE_ROUTES = ['/'];

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeRoute(route: string): string {
  return route.startsWith('/') ? route : `/${route}`;
}

function isGlobalAsset(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => file.includes(pattern));
}

function isGlob(route: string): boolean {
  return route.includes('*') || route.includes('?');
}

// Compile a route glob to a full-match RegExp: `*` matches any run of characters, `?` a single one;
// everything else is literal.
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

// The routes THIS diff touched, mirroring Visual-QA: each changed content file -> its own route; any
// changed shared asset -> the representative route sample. Deduped, path-normalized.
async function diffRoutes(ctx: GateContext, config: LayoutRulesConfig): Promise<Set<string>> {
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

  const routes = new Set<string>();
  for (const file of ctx.changedFiles) {
    if (reader.isContentFile(file)) routes.add(normalizeRoute(await reader.routeFor(file)));
  }
  if (ctx.changedFiles.some((file) => isGlobalAsset(file, globalPatterns))) {
    for (const route of representativeRoutes) routes.add(normalizeRoute(route));
  }
  return routes;
}

// The final target set: every glob-free `routes` entry (always checked), plus the diff-derived
// routes kept by the `routes` filter (a route survives if it matches a configured glob or equals a
// configured literal; with no `routes` configured, every diff route survives).
async function deriveTargets(ctx: GateContext, config: LayoutRulesConfig): Promise<string[]> {
  const configRoutes = (config.routes ?? []).map(normalizeRoute);
  const literals = configRoutes.filter((route) => !isGlob(route));
  const globs = configRoutes.filter(isGlob).map(globToRegExp);

  const targets = new Set<string>(literals);
  for (const route of await diffRoutes(ctx, config)) {
    if (configRoutes.length === 0 || literals.includes(route) || globs.some((re) => re.test(route))) {
      targets.add(route);
    }
  }
  return [...targets];
}

function viewportLabel(route: string, viewport: LayoutViewport): string {
  const vp = viewport.name ? `${viewport.name} ${viewport.width}x${viewport.height}` : `${viewport.width}x${viewport.height}`;
  return `${route} @ ${vp}`;
}

export function createLayoutRulesGate(deps: LayoutRulesDeps = {}): Gate {
  return {
    id: LAYOUT_RULES_GATE_ID,
    async run(ctx: GateContext): Promise<GateResult> {
      const config = readGateConfig<LayoutRulesConfig>(ctx.config, LAYOUT_RULES_GATE_ID, {});
      if (!config.baseUrl) {
        // No served URL -> nothing to measure. Skip cleanly (the serve stage that supplies baseUrl
        // is a prerequisite).
        return { id: LAYOUT_RULES_GATE_ID, status: 'skip', findings: ['no served baseUrl (serve stage not wired)'] };
      }

      const rules: LayoutRule[] = normalizeRules(config.rules);
      if (rules.length === 0) {
        // No declared rule set -> the gate is a zero-cost no-op for this tenant/repo.
        return { id: LAYOUT_RULES_GATE_ID, status: 'skip', findings: ['no layout rules configured'] };
      }

      const baseUrl = config.baseUrl.replace(/\/$/, '') + '/';
      const viewports = config.viewports && config.viewports.length > 0 ? config.viewports : DEFAULT_VIEWPORTS;

      // Everything that can hit infra -- content-read target derivation and the lazy Chromium
      // launch -- lives inside this try so a thrown Playwright/serve/content error SKIPS the gate
      // (fail-open) instead of escaping run() and reading as a merge-blocking fail.
      const injectedBrowser = deps.browser;
      let browser: LayoutBrowser | undefined;
      const failures: string[] = [];
      const notes: string[] = [];
      try {
        const targets = await deriveTargets(ctx, config);
        if (targets.length === 0) {
          // Nothing this PR touched maps to a route the rules apply to. Skip, don't fail.
          return { id: LAYOUT_RULES_GATE_ID, status: 'skip', findings: ['no changed file maps to a checked route'] };
        }

        browser = injectedBrowser ?? (await (deps.createBrowser ?? createPlaywrightLayoutBrowser)());

        for (const route of targets) {
          const url = new URL(route, baseUrl).toString();
          for (const viewport of viewports) {
            // Each viewport measures and evaluates only the rules scoped to its width; a rule with a
            // `viewports` filter that excludes this width contributes nothing here (not a fail, not an
            // N/A note). No applicable rule -> nothing to measure at this viewport, skip it entirely.
            const scopedRules = rulesForViewport(rules, viewport.width);
            if (scopedRules.length === 0) continue;
            const label = viewportLabel(route, viewport);
            const spec = measureSpecFor(scopedRules);
            let measurements;
            try {
              measurements = await browser.measure(url, viewport as Viewport, spec);
            } catch (err) {
              // A browser/measure error is INFRA, not a layout defect. Skip the whole gate with an
              // explanatory finding rather than blocking a merge on a Playwright/serve hiccup.
              return {
                id: LAYOUT_RULES_GATE_ID,
                status: 'skip',
                findings: [`could not measure ${label}: ${errMsg(err)}`],
              };
            }
            for (const finding of evaluateRules(scopedRules, measurements)) {
              const line = `${label}: ${finding.message}`;
              if (finding.status === 'fail') failures.push(line);
              else notes.push(line);
            }
          }
        }
      } catch (err) {
        // Target derivation or the Chromium launch threw -- infra, not a layout defect. Skip the
        // gate with an explanation rather than blocking a merge (and burning the fix loop) on it.
        return {
          id: LAYOUT_RULES_GATE_ID,
          status: 'skip',
          findings: [`layout gate skipped after a browser/serve error: ${errMsg(err)}`],
        };
      } finally {
        // Only close a browser this gate actually created; an injected one is the caller's to
        // manage, and construction may have thrown before one existed.
        if (browser && !injectedBrowser) await browser.close().catch(() => {});
      }

      if (failures.length > 0) {
        return { id: LAYOUT_RULES_GATE_ID, status: 'fail', findings: [...failures, ...notes] };
      }
      return notes.length > 0
        ? { id: LAYOUT_RULES_GATE_ID, status: 'pass', findings: notes }
        : { id: LAYOUT_RULES_GATE_ID, status: 'pass' };
    },
  };
}

// The default-wired gate for the heavy stage's registry: real Playwright browser, built lazily on
// first run.
export const layoutRulesGate: Gate = createLayoutRulesGate();
