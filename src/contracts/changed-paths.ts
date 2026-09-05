// Changed-path scoping: "does this PR's diff touch anything this gate/site is about?"
//
// One matcher, two consumers, both of which had no way to ask the question before:
//   - CommandGateSpec.paths -- a tenant command gate that lints/builds ONE app in a monorepo
//     (`yarn lint:<app>`) was run on every PR, including one that changed only the other app.
//   - SiteConfig.paths -- the heavy stage served and crawled EVERY configured site on every
//     gated PR, so a dual-brand repo paid two production builds for a one-brand diff.
//
// The axis is CHANGED PATHS, not sites: per-site selection is just one use of it (a tenant's
// `unit-tests` gate covering `scripts/` is scoped to paths and to no site at all).
//
// THE SAFETY RULE, and it is the whole design: a MISSED gate is worse than a wasted one. Every
// ambiguity resolves towards RUNNING -- no patterns declared, no changed-file list, a file that
// matches nobody's patterns. A skip only ever happens on the positive fact "patterns were
// declared and this diff matched none of them". `changedFiles` is derived from the checkout by
// the runner and cannot be edited by the branch under gate (the same property
// gates/salesforce/profile.ts relies on), so a PR cannot scope itself out of a gate.

import type { SiteConfig } from './types.ts';

// Glob subset, deliberately small: `**` (any number of path segments, including none), `*` and
// `?` (within one segment). Enough for the shapes a CI paths-filter is written in
// (`apps/<app>/**`, `content/**/<site>/**`, `yarn.lock`) and nothing more, so no
// dependency is added for it.
//
// A pattern with NO wildcard is treated as a path OR a directory prefix (`packages` matches
// `packages/ui/x.ts`), which is the inclusive reading -- see the safety rule above. Everything
// else is anchored: a pattern matches the WHOLE repo-relative path, never a substring.
function globToRegExp(pattern: string): RegExp {
  const segments = pattern.replace(/\/+$/, '').split('/');
  let source = '^';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      // Zero-or-more SEGMENTS, so `a/**/b` matches `a/b` as well as `a/x/y/b` -- the globstar
      // reading. The narrower `.*/` form silently stopped matching the zero-directory case,
      // which would be a skip nobody asked for.
      source += last ? '.*' : '(?:[^/]*/)*';
      return;
    }
    source += segment.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === '*' ? '[^/]*' : ch === '?' ? '[^/]' : `\\${ch}`));
    if (!last) source += '/';
  });
  // The wildcard-free directory-prefix reading. Only applied when the pattern names no wildcard
  // at all; `apps/*` stays a one-segment match.
  if (!/[*?]/.test(pattern)) source += '(?:/.*)?';
  return new RegExp(`${source}$`);
}

const cache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    cache.set(pattern, re);
  }
  return re;
}

/** Whether one repo-relative path matches any of `patterns`. */
export function matchesAnyPath(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => compiled(pattern).test(file));
}

/**
 * Whether a diff is IN SCOPE for a path-scoped gate.
 *
 * `undefined`/empty `patterns` -> unscoped, always in scope. An empty/absent changed-file list
 * is IGNORANCE, not "the diff is empty": with nothing to match against, the only safe answer is
 * in-scope (VCSHost.listChangedFiles documents the same discipline for its own `undefined`).
 */
export function diffTouches(changedFiles: readonly string[] | undefined, patterns: readonly string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return true;
  if (!changedFiles || changedFiles.length === 0) return true;
  return changedFiles.some((file) => matchesAnyPath(file, patterns));
}

/**
 * The sites the heavy stage must serve for this diff.
 *
 * Selection, in the order the rules fire:
 *   - no site declares `paths` -> every site (the feature is off for this tenant);
 *   - a site with no `paths` -> always selected (it never claimed to be scopeable);
 *   - a changed file matching NO site's `paths` is a SHARED change (`packages/**`, a lockfile,
 *     root config) -> every site, exactly as the tenant repo's own per-app deploy filters treat
 *     an unclaimed path;
 *   - otherwise the sites whose `paths` this diff matched.
 *
 * Never returns an empty list while `sites` is non-empty: an empty one would fall through to the
 * single-`serve` path in serve-and-gate.ts and quietly gate a DIFFERENT site than the tenant
 * configured.
 */
export function sitesForChangedFiles(
  sites: readonly SiteConfig[],
  changedFiles: readonly string[] | undefined,
): readonly SiteConfig[] {
  const scoped = sites.filter((site) => site.paths && site.paths.length > 0);
  if (scoped.length === 0) return sites;
  if (!changedFiles || changedFiles.length === 0) return sites;
  // A file no site claims is shared -- it can affect all of them, so it selects all of them.
  const unclaimed = changedFiles.some((file) => !scoped.some((site) => matchesAnyPath(file, site.paths!)));
  if (unclaimed) return sites;
  const selected = sites.filter((site) => diffTouches(changedFiles, site.paths));
  return selected.length > 0 ? selected : sites;
}
