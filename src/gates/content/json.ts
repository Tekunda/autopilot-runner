// JSON content adapter for the Website content tree. Website's pages are not
// markdown-with-frontmatter but JSON documents under a content dir
// (`content/site/pages/**.json`, `content/site/articles/**.json`): per-locale
// SEO lives in `seo.<locale>.{title,description}`, per-locale copy in nested
// `copy.<locale>.{title,summary,description,body,...}` (inline HTML), and an
// article's body may be an HTML file referenced by `copy.<locale>.bodyFile`.
// This module parses that shape into the same `Page`/`Link`/`Image` values the
// SEO and content packs already consume, so the changed-file gates work on JSON
// pages exactly as they do on markdown. Nothing here is markdown-aware; the
// markdown path in ./reader.ts is untouched.
//
// Lives under src/gates/ for the same reason ./reader.ts does: it is commodity
// parsing with no licensed judgment, and the runner-bundled gates read through
// it. See ./reader.ts's header.

import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { Frontmatter, Image, Link, Page, PageClassification } from './types.ts';

export const DEFAULT_BASE_LOCALE = 'en';

// True if `relativePath` is a `.json` file inside `<rootDir>/<contentDir>`. A
// tenant scopes which JSON counts as a page via `contentDir` (e.g.
// `content/site/pages`), mirroring how the markdown reader scopes `.md`.
export function isJsonContentFile(rootDir: string, contentDir: string, relativePath: string): boolean {
  if (!relativePath.endsWith('.json')) return false;
  const abs = path.resolve(rootDir, relativePath);
  const contentAbs = path.resolve(rootDir, contentDir);
  return abs === contentAbs || abs.startsWith(contentAbs + path.sep);
}

// Recursively lists every `.json` file under `<rootDir>/<contentDir>`, relative
// to `rootDir`. A missing content dir yields no pages rather than throwing.
export async function listJsonContentFiles(rootDir: string, contentDir: string): Promise<string[]> {
  const base = path.resolve(rootDir, contentDir);
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        results.push(path.relative(rootDir, full));
      }
    }
  }

  await walk(base);
  return results;
}

function isLocaleMap(value: unknown, baseLocale: string): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, baseLocale)
  );
}

// The base-locale SEO block (`seo.<baseLocale>`), searched depth-first so a page
// that nests its SEO still resolves. Website keeps it at the document root.
function findSeo(node: unknown, baseLocale: string): Record<string, unknown> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findSeo(child, baseLocale);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof node !== 'object' || node === null) return undefined;
  const obj = node as Record<string, unknown>;
  if (isLocaleMap(obj.seo, baseLocale)) {
    const base = (obj.seo as Record<string, unknown>)[baseLocale];
    if (typeof base === 'object' && base !== null) return base as Record<string, unknown>;
  }
  for (const [key, child] of Object.entries(obj)) {
    if (key === 'seo' || key === 'copy') continue;
    const found = findSeo(child, baseLocale);
    if (found) return found;
  }
  return undefined;
}

// Collects, in document order, every base-locale copy string and structured
// `href` on the page: the visible text the editorial gates scan plus the links
// the internal/external-link gates count. Inline HTML in copy values is kept
// verbatim so anchors inside it survive to `extractLinks`.
function collectCopy(
  node: unknown,
  baseLocale: string,
  text: string[],
  hrefs: string[],
): void {
  if (Array.isArray(node)) {
    for (const child of node) collectCopy(child, baseLocale, text, hrefs);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const obj = node as Record<string, unknown>;

  if (typeof obj.href === 'string') hrefs.push(obj.href);

  if (isLocaleMap(obj.copy, baseLocale)) {
    const base = (obj.copy as Record<string, unknown>)[baseLocale];
    if (typeof base === 'object' && base !== null) {
      for (const value of Object.values(base as Record<string, unknown>)) {
        if (typeof value === 'string') text.push(value);
      }
    }
  }

  for (const [key, child] of Object.entries(obj)) {
    if (key === 'href') continue;
    collectCopy(child, baseLocale, text, hrefs);
  }
}

// The HTML body of an article, if `copy.<baseLocale>.bodyFile` names one. The
// file is resolved beside the page JSON (Website stores the `.html` next to the
// article `.json`). A missing file contributes nothing rather than throwing.
async function readBodyFile(
  rootDir: string,
  relativePath: string,
  parsed: unknown,
  baseLocale: string,
): Promise<string> {
  const copy = (parsed as Record<string, unknown> | null)?.copy;
  if (!isLocaleMap(copy, baseLocale)) return '';
  const base = (copy as Record<string, unknown>)[baseLocale];
  const bodyFile = (base as Record<string, unknown> | null)?.bodyFile;
  if (typeof bodyFile !== 'string' || bodyFile.length === 0) return '';
  const abs = path.resolve(rootDir, path.dirname(relativePath), bodyFile);
  try {
    return await readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}

// Read+parse a JSON page leniently: a missing file OR unparseable JSON yields
// undefined so the caller skips it -- mirroring the markdown reader, which never
// throws on bad content. A malformed page is the build/e2e gate's concern, not
// this SEO content gate's, and one bad file must not abort the changed-file loop.
export async function safeReadJson(abs: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined; // ponytail: malformed JSON -> skip, like the md reader tolerates bad content
  }
}

// The loader-derived half of "is this a page": the content loader publishes JSON
// *documents*, so a file under the content dir that does not parse into one is not
// a page it would ever route. Name-based exclusions (README and friends) are
// applied by the caller in ./content.ts, shared with the markdown reader.
//
// Two failure modes, routed opposite ways on purpose:
//   - GONE from the checkout. A PR's changed-file list includes DELETIONS, and a
//     file that is not there has no page, certainly. Checking it anyway is how a
//     gate reports "missing title" against a page the PR deleted, which no human
//     can act on. So: `isPage: false`.
//   - PRESENT but unparseable. We cannot tell what the loader would do with it, and
//     "cannot tell" must never read as "not a page" -- over-checking produces a
//     finding a human can act on, silently skipping produces nothing at all. So:
//     `isPage: true` WITH a reason.
// Any other read error (EACCES, EISDIR) still throws, as everywhere else in this
// module: an unreadable checkout is an infra fault, not a content verdict.
export async function classifyJsonDocument(
  rootDir: string,
  relativePath: string,
): Promise<PageClassification> {
  const abs = path.resolve(rootDir, relativePath);
  try {
    await access(abs);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { isPage: false, reason: 'not present in the checkout (deleted by this PR)' };
    }
    throw err;
  }
  const parsed = await safeReadJson(abs);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { isPage: true, reason: 'could not be read as a JSON page document' };
  }
  return { isPage: true };
}

export async function loadJsonPage(
  rootDir: string,
  relativePath: string,
  baseLocale: string = DEFAULT_BASE_LOCALE,
): Promise<Page> {
  const parsed = await safeReadJson(path.resolve(rootDir, relativePath));
  if (parsed === undefined) return { relativePath, frontmatter: {}, body: '' };

  const seo = findSeo(parsed, baseLocale);
  const frontmatter: Frontmatter = {};
  if (typeof seo?.title === 'string') frontmatter.title = seo.title;
  if (typeof seo?.description === 'string') frontmatter.description = seo.description;
  if (typeof seo?.keyword === 'string') frontmatter.keyword = seo.keyword;

  const text: string[] = [];
  const hrefs: string[] = [];
  collectCopy(parsed, baseLocale, text, hrefs);
  const bodyFileHtml = await readBodyFile(rootDir, relativePath, parsed, baseLocale);

  // Structured hrefs are appended as bare anchors so extractLinks() sees inline
  // and structured links through one path.
  const anchorTags = hrefs.map((url) => `<a href="${url}"></a>`);
  const body = [...text, bodyFileHtml, ...anchorTags].filter((s) => s.length > 0).join('\n');

  return { relativePath, frontmatter, body };
}

const HREF_RE = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const BARE_HREF_RE = /\bhref=["']([^"']+)["']/gi;
const IMG_RE = /<img\b[^>]*>/gi;
const ATTR_RE = (name: string): RegExp => new RegExp(`\\b${name}=["']([^"']*)["']`, 'i');
const H1_RE = /<h1\b[^>]*>([\s\S]*?)<\/h1>/gi;

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

// Links in a JSON page's body: every HTML anchor, plus the bare `href=` snippets
// synthesized from structured link objects. Anchor text is best-effort (empty
// for structured links, which the link gates count by URL).
export function extractJsonLinks(body: string): Link[] {
  const links: Link[] = [];
  const seen = new Set<string>();
  for (const match of body.matchAll(HREF_RE)) {
    seen.add(match.index !== undefined ? String(match.index) : match[1]);
    links.push({ text: stripTags(match[2]), url: match[1] });
  }
  // Catch hrefs on tags that did not close as <a>...</a> (self-synthesized empty
  // anchors already matched above; this covers any remaining bare href).
  const anchored = new Set(links.map((l) => l.url));
  for (const match of body.matchAll(BARE_HREF_RE)) {
    if (!anchored.has(match[1])) {
      links.push({ text: '', url: match[1] });
      anchored.add(match[1]);
    }
  }
  return links;
}

export function extractJsonImages(body: string): Image[] {
  const images: Image[] = [];
  for (const tag of body.match(IMG_RE) ?? []) {
    const src = ATTR_RE('src').exec(tag)?.[1] ?? '';
    const alt = ATTR_RE('alt').exec(tag)?.[1] ?? '';
    images.push({ alt, src });
  }
  return images;
}

export function extractJsonH1s(body: string): string[] {
  const headings: string[] = [];
  for (const match of body.matchAll(H1_RE)) {
    headings.push(stripTags(match[1]));
  }
  return headings;
}

// The route a JSON page serves: its `slug` (Website stores the full route slug,
// e.g. "serpent/compare/copado"), falling back to the content-relative path.
export async function jsonPageRoute(
  rootDir: string,
  contentDir: string,
  relativePath: string,
): Promise<string> {
  const parsed = await safeReadJson(path.resolve(rootDir, relativePath));
  const slug = (parsed as Record<string, unknown> | null | undefined)?.slug;
  if (typeof slug === 'string' && slug.length > 0) {
    return slug.startsWith('/') ? slug : `/${slug}`;
  }
  const rel = path.relative(path.resolve(rootDir, contentDir), path.resolve(rootDir, relativePath));
  const noExt = rel.replace(/\.json$/, '');
  const trimmed = noExt.replace(/(?:^|\/)index$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

// The locale-coverage view an i18n audit needs: every `copy`/`seo` locale map on
// the page (audit-style), each with the set of locales it defines. A map that
// defines the base locale but omits a required locale is a translation gap.
export interface LocaleMapCoverage {
  pointer: string;
  locales: Set<string>;
}

export function collectLocaleMaps(parsed: unknown, baseLocale: string): LocaleMapCoverage[] {
  const out: LocaleMapCoverage[] = [];
  function walk(node: unknown, pointer: string): void {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${pointer}[${i}]`));
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const obj = node as Record<string, unknown>;
    for (const key of ['copy', 'seo']) {
      const value = obj[key];
      if (isLocaleMap(value, baseLocale)) {
        out.push({ pointer: `${pointer}.${key}`, locales: new Set(Object.keys(value)) });
      }
    }
    for (const [key, child] of Object.entries(obj)) {
      if (key === 'copy' || key === 'seo') continue;
      walk(child, `${pointer}.${key}`);
    }
  }
  walk(parsed, '$');
  return out;
}
