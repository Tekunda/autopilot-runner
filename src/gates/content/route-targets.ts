// route-targets: the shared diff->routes derivation the served-site gates (layout-rules, visual-qa)
// use to turn a PR's changed files into the routes worth rendering. Kept generic and multi-tenant:
// every behavior is driven by optional config, and with `appDir`/`sharedSourceGlobs` unset the
// path-derivation and shared-glob fanout branches never fire (a clean backward-compatible no-op).
//
// A changed content/page file maps to the route it serves; a changed app-router source file
// (page/layout/i18n) under the tenant's `appDir` maps to the route of its own directory, so a page
// whose copy lives only in the app i18n dictionary (no content-tree record) still maps; a changed
// `layout`/`template` additionally fans out to the representative route sample, since it WRAPS a
// subtree of descendant routes whose regressions never show on its own directory route; a changed
// shared/global asset fans out to the representative route sample too.

import { createContentReader, selectPages, type ContentFormat } from './reader.ts';
import type { GateContext } from '../types.ts';

const DEFAULT_CONTENT_DIR = 'content';
// Exported so the served-site gates (visual-qa, layout-rules) share ONE definition of what counts
// as a global asset / representative route sample and cannot drift apart.
export const DEFAULT_GLOBAL_PATTERNS = ['.css', '.scss', '.sass', 'layout', 'theme', 'global'];
export const DEFAULT_REPRESENTATIVE_ROUTES = ['/'];

// The subset of a served-site gate's config the derivation reads. Both LayoutRulesConfig and
// VisualQaConfig satisfy it structurally, so each gate passes its own config straight through.
export interface RouteDerivationConfig {
  contentDir?: string;
  contentFormat?: ContentFormat;
  baseLocale?: string;
  globalPatterns?: string[];
  sharedSourceGlobs?: string[];
  representativeRoutes?: string[];
  appDir?: string;
}

export function normalizeRoute(route: string): string {
  return route.startsWith('/') ? route : `/${route}`;
}

export function isGlobalAsset(file: string, patterns: string[]): boolean {
  return patterns.some((pattern) => file.includes(pattern));
}

export function isGlob(route: string): boolean {
  return route.includes('*') || route.includes('?');
}

// Compile a route glob to a full-match RegExp: `*` matches any run of characters, `?` a single one;
// everything else is literal.
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

export function matchesAnyGlob(file: string, globs: string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

// Basenames that mark a file as an app-router PAGE source: the Next.js page/layout conventions and a
// colocated i18n dictionary (`i18n.js` or `<page>-i18n.js`). A change to one derives the
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

export function isRouteSourceFile(basename: string): boolean {
  return ROUTE_FILE_BASENAME_RE.test(basename) || I18N_FILE_BASENAME_RE.test(basename);
}

// True when the changed file is a `layout`/`template` route source under `appDir` -- a wrapper whose
// subtree of descendant routes must be re-checked, not just its own directory. The descendant set is
// not derivable from the diff alone, so the gate fans it out to the representative route sample (the
// same bounded mechanism a shared/global asset uses), keeping the over-trigger scoped.
export function isWrapperRouteFile(file: string, appDir: string): boolean {
  const prefix = appDir.replace(/\/+$/, '') + '/';
  if (!file.startsWith(prefix)) return false;
  const segments = file.slice(prefix.length).split('/');
  const basename = segments[segments.length - 1] ?? '';
  return WRAPPER_FILE_BASENAME_RE.test(basename);
}

// The route a changed app-source file serves, or null if it does not derive one. A file under
// `appDir` whose basename is a route source file maps to its directory path relative to `appDir`
// (`apps/<app>/app/[locale]/products/<product>/page.jsx` with appDir `apps/<app>/app/[locale]` ->
// `/products/<product>`). Next.js route groups `(marketing)` are stripped (they never appear in
// the URL); a file inside a private `_folder` derives nothing. A
// DYNAMIC segment (`[slug]`/`[...rest]`) derives nothing either: a dynamic page is not navigable
// without a concrete param, so `/products/[slug]` would load a 404 and measure garbage -- such a
// page must instead be targeted by a concrete `representativeRoutes` URL via the shared/global
// fanout. (The `appDir` prefix itself may contain a dynamic segment like `[locale]`; only the
// segments AFTER it are checked, since the prefix is stripped before matching.)
export function appRouteFor(file: string, appDir: string): string | null {
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

// The routes THIS diff touched: each changed content file -> its own route; a changed app-source
// route file (when `appDir` is set) -> the route of its own directory; any changed shared/global
// asset (or wrapper layout/template) -> the representative route sample. Deduped, path-normalized.
export async function diffRoutes(
  ctx: GateContext,
  config: RouteDerivationConfig,
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
      // Truthiness, matching the `if (config.appDir)` path-derivation guard above so an empty
      // `appDir` reads as "unset" everywhere.
      (config.appDir ? isWrapperRouteFile(file, config.appDir) : false),
  );
  if (fansOut) {
    for (const route of representativeRoutes) routes.add(normalizeRoute(route));
  }
  return routes;
}
