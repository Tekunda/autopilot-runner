// layout-rules: an OPTIONAL, deterministic declarative layout gate (TEK-3691 post-mortem
// "Deterministic layout rules, declared per tenant and repo"). It runs in the SAME served-site
// heavy harness as Visual-QA, but does ONLY getBoundingClientRect measurements against a tenant's
// declared rule set -- no model, no tokens, so it can never be rate-limited. Absent a rule set (or a
// served baseUrl) it is a zero-cost no-op skip. The rules it checks would have caught the F1 369px
// sibling-height void and the F5 640/1232 width-ratio the post-mortem is about.
//
// TARGET DERIVATION mirrors Visual-QA: a changed content/page file maps to the route it serves; a
// changed app-router source file (page/layout/i18n) under the tenant's `appDir` maps to the route of
// its own directory, so a page whose copy lives only in the app i18n dictionary (no content/site
// record) still maps; a changed `layout`/`template` additionally fans out to the representative route
// sample, since it WRAPS a subtree of descendant routes whose regressions never show on its own
// directory route; a changed shared/global asset fans out to a representative route sample. Those
// diff-derived routes are then filtered by the config `routes` globs, and any GLOB-FREE (literal)
// `routes` entry is ALWAYS checked regardless of the diff (a tenant pins its key pages that way). No
// resulting route -> skip.
//
// Runs ONLY in the dedicated heavy stage -- the only stage with a browser and a live served site
// (src/runner/serve-and-gate.ts). It measures a SETTLED local build (§11), never a mid-rollout
// deploy. The browser is injectable so the derive->measure->evaluate->verdict logic is unit-testable
// with a fake and never needs a real Chromium in tests.
//
// FAIL-OPEN on infra: a browser/measure error is caught internally and the gate SKIPS with an
// explanatory finding -- it never throws (a thrown gate reads as fail and wedges the fix loop) and
// never blocks a merge on a Playwright/serve hiccup. Only a real geometry violation blocks. But a
// transient measure error on ONE target must not erase the real violations already found on the
// others: like Visual-QA, each per-target measure error is isolated into a separate `inconclusive`
// list (keyed by route+viewport) and the loop CONTINUES, so genuine violations from every measurable
// target are preserved and reported. The gate only fail-open skips when NO real violation was found
// (see the aggregation below).

import { readGateConfig } from '../generic/config.ts';
import { asGateNotes, createContentReader, selectPages, type ContentFormat } from '../../packs/seo/content.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';
import { createPlaywrightLayoutBrowser, type LayoutBrowser, type Viewport } from './browser.ts';
import { evaluateRules, measureSpecFor, normalizeRulesDetailed, rulesForViewport } from './rules.ts';

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
  // The app-router source ROOT (relative to the checkout root) under which route directories live,
  // e.g. tekunda's `apps/tekunda-web/app/[locale]`. Set -> a changed route source file (a Next.js
  // route file or a colocated i18n dictionary) under it derives the route of its own directory
  // (`.../products/delivery-autopilot/page.jsx` -> `/products/delivery-autopilot`), so pages whose
  // copy lives in the app i18n dictionary rather than a content/site record still map to a route.
  // Unset -> path derivation is off and only content records / global-asset fanout map files
  // (backward compatible).
  appDir?: string;
  // Globs (checkout-root-relative, `*`/`?` wildcards) matching SHARED source files that back specific
  // routes but sit OUTSIDE a route dir (a shared section component). A change to one fans out to the
  // representative route sample, same as a global asset -- so a bounded, config-declared set of
  // shared components triggers the configured routes without per-file route derivation.
  sharedSourceGlobs?: string[];
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

function matchesAnyGlob(file: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

// Basenames that mark a file as an app-router PAGE source: the Next.js page/layout conventions and a
// colocated i18n dictionary (`i18n.js` or `delivery-autopilot-i18n.js`). A change to one derives the
// route of its own directory. `route.ts` is deliberately excluded -- it is an API route handler
// returning data, never a navigable page. Everything else under the app root -- shared components,
// hooks, utilities, colocated CSS -- is NOT path-derived here: it either fans out via the
// shared/global mechanism or contributes no route (the over-trigger guard that keeps this bounded).
const ROUTE_FILE_BASENAME_RE = /^(?:page|layout|template|default|loading|error|not-found)\.[jt]sx?$/;
const I18N_FILE_BASENAME_RE = /(?:^|[-.])i18n\.[jt]sx?$/;

// A `layout`/`template` is a WRAPPER: it renders around every descendant route in its subtree, so a
// regression in one (a broken shared grid, a stray max-width) can only be seen on the pages it wraps,
// NOT on its own directory route -- which is often not even navigable. A leaf `page` is deliberately
// excluded: it renders only its own route, so it maps there and nowhere else (the over-trigger guard).
const WRAPPER_FILE_BASENAME_RE = /^(?:layout|template)\.[jt]sx?$/;

function isRouteSourceFile(basename: string): boolean {
  return ROUTE_FILE_BASENAME_RE.test(basename) || I18N_FILE_BASENAME_RE.test(basename);
}

// True when the changed file is a `layout`/`template` route source under `appDir` -- a wrapper whose
// subtree of descendant routes must be re-checked, not just its own directory. The descendant set is
// not derivable from the diff alone, so the gate fans it out to the representative route sample (the
// same bounded mechanism a shared/global asset uses), keeping the over-trigger scoped.
function isWrapperRouteFile(file: string, appDir: string): boolean {
  const prefix = appDir.replace(/\/+$/, '') + '/';
  if (!file.startsWith(prefix)) return false;
  const segments = file.slice(prefix.length).split('/');
  const basename = segments[segments.length - 1] ?? '';
  return WRAPPER_FILE_BASENAME_RE.test(basename);
}

// The route a changed app-source file serves, or null if it does not derive one. A file under
// `appDir` whose basename is a route source file maps to its directory path relative to `appDir`
// (`apps/.../app/[locale]/products/delivery-autopilot/page.jsx` with appDir
// `apps/.../app/[locale]` -> `/products/delivery-autopilot`). Next.js route groups `(marketing)` are
// stripped (they never appear in the URL); a file inside a private `_folder` derives nothing. A
// DYNAMIC segment (`[slug]`/`[...rest]`) derives nothing either: a dynamic page is not navigable
// without a concrete param, so `/products/[slug]` would load a 404 and measure garbage -- such a
// page must instead be targeted by a concrete `representativeRoutes` URL via the shared/global
// fanout. (The `appDir` prefix itself may contain a dynamic segment like `[locale]`; only the
// segments AFTER it are checked, since the prefix is stripped before matching.)
function appRouteFor(file: string, appDir: string): string | null {
  const prefix = appDir.replace(/\/+$/, '') + '/';
  if (!file.startsWith(prefix)) return null;
  const segments = file.slice(prefix.length).split('/');
  const basename = segments[segments.length - 1] ?? '';
  if (!isRouteSourceFile(basename)) return null;
  const dirSegments = segments.slice(0, -1);
  if (dirSegments.some((segment) => segment.startsWith('_'))) return null;
  if (dirSegments.some((segment) => segment.includes('[') || segment.includes(']'))) return null;
  const routeSegments = dirSegments.filter((segment) => !(segment.startsWith('(') && segment.endsWith(')')));
  return `/${routeSegments.join('/')}`;
}

// The routes THIS diff touched, mirroring Visual-QA: each changed content file -> its own route; a
// changed app-source route file (when `appDir` is set) -> the route of its own directory; any
// changed shared/global asset -> the representative route sample. Deduped, path-normalized.
async function diffRoutes(
  ctx: GateContext,
  config: LayoutRulesConfig,
  selectionNotes: string[],
): Promise<Set<string>> {
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

  const routes = new Set<string>();
  const { pages, notes } = await selectPages(reader, ctx.changedFiles);
  selectionNotes.push(...notes);
  const contentPages = new Set(pages);
  for (const file of ctx.changedFiles) {
    if (contentPages.has(file)) {
      routes.add(normalizeRoute(await reader.routeFor(file)));
      continue;
    }
    // A file inside the content tree that is NOT a page (a README) has no route of
    // its own, and must not fall through to the app-source branch below either --
    // that would invent a route for it out of its directory path.
    if (reader.isContentFile(file)) continue;
    if (config.appDir) {
      const route = appRouteFor(file, config.appDir);
      if (route) routes.add(route);
    }
  }
  const fansOut = ctx.changedFiles.some(
    (file) =>
      isGlobalAsset(file, globalPatterns) ||
      matchesAnyGlob(file, sharedSourceGlobs) ||
      (config.appDir !== undefined && isWrapperRouteFile(file, config.appDir)),
  );
  if (fansOut) {
    for (const route of representativeRoutes) routes.add(normalizeRoute(route));
  }
  return routes;
}

// The final target set: every glob-free `routes` entry (always checked), plus the diff-derived
// routes kept by the `routes` filter (a route survives if it matches a configured glob or equals a
// configured literal; with no `routes` configured, every diff route survives).
async function deriveTargets(
  ctx: GateContext,
  config: LayoutRulesConfig,
  selectionNotes: string[],
): Promise<string[]> {
  const configRoutes = (config.routes ?? []).map(normalizeRoute);
  const literals = configRoutes.filter((route) => !isGlob(route));
  const globs = configRoutes.filter(isGlob).map(globToRegExp);

  const targets = new Set<string>(literals);
  for (const route of await diffRoutes(ctx, config, selectionNotes)) {
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
        return { id: LAYOUT_RULES_GATE_ID, status: 'skip', skipReason: 'no-baseurl', findings: ['no served baseUrl (serve stage not wired)'] };
      }

      const { rules, dropped } = normalizeRulesDetailed(config.rules);
      if (rules.length === 0) {
        if (dropped.length > 0) {
          // Rules WERE declared but every entry failed to parse (a typo'd field/type). Silently
          // treating this as "nothing configured" is the never-run hole the TEK-3691 verdict ledger
          // exists to catch: it would bank a permanent no-op as a benign skip forever. Surface the
          // dropped entries and mark the skip `invalid-config` (a SUSPICIOUS reason) so the
          // never-fired tracker alarms instead of staying silent on a config typo.
          return {
            id: LAYOUT_RULES_GATE_ID,
            status: 'skip',
            skipReason: 'invalid-config',
            findings: [
              `${dropped.length} declared layout rule${dropped.length === 1 ? '' : 's'} dropped as malformed; none parsed`,
              ...dropped.map((d) => `rule[${d.index}]: ${d.reason}`),
            ],
          };
        }
        // No declared rule set -> the gate is a zero-cost no-op for this tenant/repo.
        return { id: LAYOUT_RULES_GATE_ID, status: 'skip', skipReason: 'no-config', findings: ['no layout rules configured'] };
      }

      const baseUrl = config.baseUrl.replace(/\/$/, '') + '/';
      const viewports = config.viewports && config.viewports.length > 0 ? config.viewports : DEFAULT_VIEWPORTS;

      // Everything that can hit infra -- content-read target derivation and the lazy Chromium
      // launch -- lives inside this try so a thrown Playwright/serve/content error SKIPS the gate
      // (fail-open) instead of escaping run() and reading as a merge-blocking fail.
      const injectedBrowser = deps.browser;
      let browser: LayoutBrowser | undefined;
      const failures: string[] = [];
      // A partial-malformed config (some valid rules, some dropped) still RUNS on its valid rules, but
      // the dropped entries must stay VISIBLE on the resulting verdict -- otherwise a typo'd rule
      // silently never enforces and the never-fired ledger can't catch it (the gate DID fire). Seed the
      // notes with them so they ride along on whatever pass/fail verdict an operator sees.
      const notes: string[] = dropped.map((d) => `dropped malformed rule[${d.index}]: ${d.reason}`);
      // Per-target measure errors (a browser/serve hiccup on ONE route x viewport). INFRA, not a
      // layout defect -- collected here and kept apart from real geometry `failures` so a single flaky
      // measurement never aborts the loop or erases violations already found on other targets.
      const inconclusive: string[] = [];
      const selectionNotes: string[] = [];
      try {
        // Files the content reader passed over (a README in the tree) go into the SAME `notes`
        // channel as dropped rules, so they ride onto whatever verdict an operator sees rather
        // than living only in the run log.
        const targets = await deriveTargets(ctx, config, selectionNotes);
        notes.push(...asGateNotes(selectionNotes));
        if (targets.length === 0) {
          // Nothing this PR touched maps to a route the rules apply to. Skip, don't fail.
          return {
            id: LAYOUT_RULES_GATE_ID,
            status: 'skip',
            skipReason: 'no-matching-route',
            findings: ['no changed file maps to a checked route', ...notes],
          };
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
              // A browser/measure error is INFRA, not a layout defect. Record it against THIS target
              // and move on rather than aborting the loop -- discarding the real violations already
              // collected from earlier targets would be worse than the hiccup. The gate stays
              // fail-open on infra only when nothing real was found (see the aggregation below).
              inconclusive.push(`could not measure ${label}: ${errMsg(err)}`);
              continue;
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
          skipReason: 'infra',
          findings: [`layout gate skipped after a browser/serve error: ${errMsg(err)}`],
        };
      } finally {
        // Only close a browser this gate actually created; an injected one is the caller's to
        // manage, and construction may have thrown before one existed.
        if (browser && !injectedBrowser) await browser.close().catch(() => {});
      }

      // Aggregation:
      // - Any real geometry violation -> `fail` (blocks the merge). Its findings carry the notes and
      //   the per-target `inconclusive` entries too, so nothing is hidden when the run also hit an
      //   infra hiccup on some other target -- a flaky measurement never erases a real violation.
      // - No real violation but a target could not be measured -> fail-open `skip` (skipReason
      //   'infra'), exactly as before: the gate never blocks a merge on a Playwright/serve hiccup.
      // - Everything measurable and clean -> `pass`.
      if (failures.length > 0) {
        return { id: LAYOUT_RULES_GATE_ID, status: 'fail', findings: [...failures, ...notes, ...inconclusive] };
      }
      if (inconclusive.length > 0) {
        return { id: LAYOUT_RULES_GATE_ID, status: 'skip', skipReason: 'infra', findings: [...inconclusive, ...notes] };
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
