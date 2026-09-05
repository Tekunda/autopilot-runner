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

import type { Frontmatter, Image, Link, Page, PageBody, PageClassification } from './types.ts';

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

// The base-locale block under `key` at the DOCUMENT ROOT, if the document has one.
// Deliberately root-only, unlike findSeo below: a `copy.<locale>` nested inside
// `sections[]` is one SECTION's copy, not the document's own title/description, and
// hoisting a section heading into the page's meta title would be a fabrication.
function rootLocaleBlock(
  parsed: unknown,
  key: string,
  baseLocale: string,
): Record<string, unknown> | undefined {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const value = (parsed as Record<string, unknown>)[key];
  if (!isLocaleMap(value, baseLocale)) return undefined;
  const base = value[baseLocale];
  return typeof base === 'object' && base !== null ? (base as Record<string, unknown>) : undefined;
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

// The keys a document's meta title/description/keyword may be authored under, most
// authoritative first. A content tree holds more than one KIND of document, and only
// one of them keeps its meta in an `seo` block:
//
//   - a PAGE (a section composition) carries `seo.<locale>.{title,description}`;
//   - an ARTICLE carries no `seo` block at all -- its title is `copy.<locale>.title`
//     and its search snippet is `copy.<locale>.excerpt`, with `seoTitle`/`seoDescription`
//     as the optional per-locale override an editor sets when the meta text must differ
//     from the editorial title (verbatim the renderer's own `seoTitle || title` /
//     `seoDescription || excerpt` precedence);
//   - a HELP-CENTER article uses `copy.<locale>.summary` where an article uses `excerpt`.
//
// Reading only the `seo` block made every article "missing title, missing meta
// description" -- 100% false, on documents whose title is right there. The `seo` block
// still WINS wherever it exists, so a page's behaviour is unchanged.
const TITLE_KEYS = ['seoTitle', 'title'] as const;
const DESCRIPTION_KEYS = ['seoDescription', 'description', 'excerpt', 'summary'] as const;
const KEYWORD_KEYS = ['keyword'] as const;

function firstString(
  blocks: readonly (Record<string, unknown> | undefined)[],
  keys: readonly string[],
): string | undefined {
  for (const block of blocks) {
    if (block === undefined) continue;
    for (const key of keys) {
      const value = block[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
  }
  return undefined;
}

/**
 * The title/description/keyword a JSON document publishes, resolved across BOTH shapes the
 * content model uses. `seo.<baseLocale>` is consulted first and wins per field; the document's
 * root `copy.<baseLocale>` block supplies the rest. A document with neither yields `{}`, which
 * is what "this file declares no meta" honestly looks like.
 */
export function findJsonMeta(parsed: unknown, baseLocale: string): Frontmatter {
  const blocks = [findSeo(parsed, baseLocale), rootLocaleBlock(parsed, 'copy', baseLocale)];
  const frontmatter: Frontmatter = {};
  const title = firstString(blocks, TITLE_KEYS);
  const description = firstString(blocks, DESCRIPTION_KEYS);
  const keyword = firstString(blocks, KEYWORD_KEYS);
  if (title !== undefined) frontmatter.title = title;
  if (description !== undefined) frontmatter.description = description;
  if (keyword !== undefined) frontmatter.keyword = keyword;
  return frontmatter;
}

// The keys that hold a structured link TARGET in this content model. `href` alone was the
// whole list, which silently dropped every link this tree expresses some other way: a
// section item's button target is `cta` (`sections[].items[].cta`, rendered as
// `href={normalizeSerpentLink(item.CTA)}`), and 198 relative `cta` links across 36 pages --
// 10 of 11 compare pages, all 3 migrate pages, the Serpent home page -- were counted as zero
// outbound links. That, not "React renders these CTAs so the data has no links", is why
// section-composition pages looked link-less.
//
// The list is what a survey of the tree ACTUALLY found, not a guess at what a CMS might use:
// `link`, `url`, `to` and `buttonHref` do not occur here and are deliberately absent.
// Excluded on purpose: `src` (image sources -- extractJsonImages' job, and counting art as an
// outbound link would inflate every page), `body`/`subtitle`/`scriptCode` (prose and code that
// merely CONTAIN URL-ish text; the HTML in them is already scanned by extractJsonLinks), and
// `route` (screenshot-capture metadata in help-center/_screen-map.json, which is not a
// rendered link and not even a document).
const LINK_KEYS = ['href', 'cta', 'ctaUrl', 'caseHref', 'demoUrl', 'secondaryButton', 'secondaryButtonSlug'];

// Whether a value under a link key is a link TARGET rather than link TEXT. The distinction is
// load-bearing, not defensive: `cta` carries a URL at `items[].cta` and a LOCALIZED BUTTON
// LABEL at `items[].copy.<locale>.cta` -- 330 of its values in this tree are prose ("Explore
// Task-Based Workflow in Serpent"). Counting those as links would replace one wrong number
// with another.
//
// A leading `//` is REFUSED. Every such value in the tree is a code comment inside a `body` or
// `scriptCode` field (`// Bad: SOQL inside a loop`), never a protocol-relative URL -- and a
// bare `startsWith('/')` admits all of them.
function isLinkTarget(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith('//')) return false;
  // `#anchor` stays a link, as it always was: this predicate decides link-vs-text, and whether
  // a same-page anchor should COUNT toward a link threshold is the link gates' policy, not the
  // parser's. Changing it here would silently move those gates' numbers.
  return /^[/#]/.test(trimmed) || /^(?:https?:|mailto:|tel:)/i.test(trimmed);
}

// Collects, in document order, every base-locale copy string and structured
// link target on the page: the visible text the editorial gates scan plus the links
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

  for (const key of LINK_KEYS) {
    const value = obj[key];
    if (typeof value === 'string' && isLinkTarget(value)) hrefs.push(value.trim());
  }

  if (isLocaleMap(obj.copy, baseLocale)) {
    const base = (obj.copy as Record<string, unknown>)[baseLocale];
    if (typeof base === 'object' && base !== null) {
      for (const value of Object.values(base as Record<string, unknown>)) {
        if (typeof value === 'string') text.push(value);
      }
    }
  }

  // Every child is recursed into, link keys included, and that is deliberate: `cta` holds a URL
  // STRING in 724 places and a nested COPY OBJECT (`{title, sub, primary}`) in 86 others. Skipping
  // the key name -- as this loop used to do for `href` -- would drop that copy out of the body the
  // editorial gates scan. Recursing into a string is already a no-op (the guard above returns), so
  // there is nothing to skip and nothing to lose.
  for (const child of Object.values(obj)) {
    collectCopy(child, baseLocale, text, hrefs);
  }
}

// The `bodyFile` each locale of a document declares, as repo-relative paths keyed by locale.
// The file is resolved beside the page JSON (Website stores the `.html` next to the article
// `.json`). Locales are returned in authored order.
function bodyFilePaths(relativePath: string, parsed: unknown, baseLocale: string): Map<string, string> {
  const out = new Map<string, string>();
  const copy = (parsed as Record<string, unknown> | null)?.copy;
  if (!isLocaleMap(copy, baseLocale)) return out;
  for (const [locale, block] of Object.entries(copy)) {
    const bodyFile = (block as Record<string, unknown> | null)?.bodyFile;
    if (typeof bodyFile !== 'string' || bodyFile.length === 0) continue;
    out.set(locale, path.join(path.dirname(relativePath), bodyFile));
  }
  return out;
}

// A missing file contributes nothing rather than throwing: a dangling `bodyFile` is the
// build gate's concern, not this content gate's, and one bad reference must not abort a sweep.
async function readRelative(rootDir: string, relativePath: string): Promise<string> {
  try {
    return await readFile(path.resolve(rootDir, relativePath), 'utf8');
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
//
// A THIRD case, and the one that matters most in practice: a JSON file under the content
// dir that is not a DOCUMENT at all. A content tree holds config, navigation trees and
// ledgers alongside its pages -- Website keeps a DataForSEO keyword ledger at
// `content/site/globals/seo-targets.json` that nearly every daily-blog commit touches --
// and a ledger has no title, no meta description and no body to link out of. Auditing one
// as a page is not a strict check, it is a wrong one: it produced "missing title" and
// "0 internal links" on a file where those words mean nothing, on every content PR.
//
// The rule is STRUCTURAL, not path-based: a document declares its per-locale content under
// a root `seo` or `copy` key. Everything the loader publishes has one (pages via `seo`,
// articles/help-center/releases via `copy`); config, navigation and ledgers have neither.
// A root `seo`/`copy` that is not a locale map for THIS base locale keeps the fail-safe
// asymmetry: it is a document whose base locale we could not read, so `isPage: true` with
// a reason, never a silent drop.
export async function classifyJsonDocument(
  rootDir: string,
  relativePath: string,
  baseLocale: string = DEFAULT_BASE_LOCALE,
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
  const doc = parsed as Record<string, unknown>;
  const declares = ['seo', 'copy'].filter((key) => key in doc);
  if (declares.length === 0) {
    return {
      isPage: false,
      reason:
        'it declares no `seo` or `copy` block, so the content loader publishes no page for it ' +
        '(config, navigation or ledger data that lives in the content tree, not a document of it)',
    };
  }
  if (!declares.some((key) => isLocaleMap(doc[key], baseLocale))) {
    return {
      isPage: true,
      reason: `its \`${declares.join('`/`')}\` block defines no "${baseLocale}" locale, so the base-locale view of it is empty`,
    };
  }
  return { isPage: true };
}

// Why this page's outbound links are not in its own data, or undefined when they are.
//
// An INDEX page renders its card grid from a separately-fetched list of its DETAIL pages --
// `useCases.map(u => <Link href={`/use-cases/${u.slug}`}>)` in UseCasesIndexContent.jsx -- so
// the links exist on the rendered page and can never appear in the JSON. A content-layer gate
// counting links in the data will read zero for as long as the page exists, and no edit to that
// file can change it. That is an unfixable finding, which is worse than no finding.
//
// The signal is STRUCTURAL, deliberately not a list of filenames (a list rots the moment
// somebody adds a hub). Two conditions, and BOTH are required:
//
//   1. the index/detail filesystem convention -- `x.json` sits beside a directory `x/` holding
//      the detail pages it lists; and
//   2. the page authors NO items of its own: every section that declares a `component` is
//      empty. Sections carrying only an `id` are shared bands (`final-cta`) resolved from
//      elsewhere and are not this page's content.
//
// Both matter. `serpent/tools.json` satisfies (1) -- there is a `tools/` directory -- but its
// `tools-list` section carries three items it authored itself, so it is a real page that really
// should link, and it is NOT excluded. Detail pages like `glossary/2gp.json` fail (1): nothing
// sits under them.
//
// The route slug is deliberately NOT used to find the children: slugs are inconsistent in this
// tree (`serpent/compare/copado` is fully qualified, `automations` is bare), so a slug-prefix
// walk misses half the hubs. The directory layout is the reliable fact.
//
// COVERAGE HANDOFF, so the next reader knows this is not a hole: these pages' outbound links are
// visible in the RENDERED DOM, and that is where they are asserted -- seo-site-crawl, which sees
// the page a browser sees. This exclusion moves the check to the layer that can actually perform
// it; it does not delete it.
export async function linksNotAuthoredHereReason(
  rootDir: string,
  relativePath: string,
): Promise<string | undefined> {
  const parsed = await safeReadJson(path.resolve(rootDir, relativePath));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;

  const sections = (parsed as Record<string, unknown>).sections;
  const ownItems = Array.isArray(sections)
    ? sections.reduce((total: number, section: unknown) => {
        if (typeof section !== 'object' || section === null) return total;
        const { component, items } = section as Record<string, unknown>;
        if (typeof component !== 'string' || component.length === 0) return total;
        return total + (Array.isArray(items) ? items.length : 0);
      }, 0)
    : 0;
  if (ownItems > 0) return undefined;

  const detailDir = path.resolve(rootDir, relativePath.replace(/\.json$/, ''));
  try {
    const entries = await readdir(detailDir);
    if (entries.length === 0) return undefined;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return undefined;
    }
    throw err;
  }

  return (
    'it is an index page: it authors no items of its own and lists the detail pages in the ' +
    `sibling "${path.basename(detailDir)}/" directory, which the renderer fetches separately -- ` +
    'so its outbound links never appear in this file and are asserted against the rendered DOM ' +
    'by the site-crawl gate instead'
  );
}

export async function loadJsonPage(
  rootDir: string,
  relativePath: string,
  baseLocale: string = DEFAULT_BASE_LOCALE,
): Promise<Page> {
  const parsed = await safeReadJson(path.resolve(rootDir, relativePath));
  if (parsed === undefined) return { relativePath, frontmatter: {}, body: '' };

  const frontmatter = findJsonMeta(parsed, baseLocale);

  const text: string[] = [];
  const hrefs: string[] = [];
  collectCopy(parsed, baseLocale, text, hrefs);

  // Every locale's body file, not just the base locale's: a defect authored into the Dutch
  // fragment renders on the Dutch page. `body` below still joins the BASE-locale view alone,
  // so every gate that reads it is unaffected; `bodies` is the additional per-file view.
  const bodyFiles = bodyFilePaths(relativePath, parsed, baseLocale);
  // Deduped by PATH, not locale: two locales may point at one file (an untranslated body), and
  // reporting the same file twice would read as two defects in it.
  const bodies: PageBody[] = await Promise.all(
    [...new Set(bodyFiles.values())].map(async (file) => ({ path: file, body: await readRelative(rootDir, file) })),
  );
  // The document's own inline copy is a fragment too -- it is where a page that composes
  // sections instead of referencing a `bodyFile` authors its HTML.
  const inline = text.join('\n');
  if (inline.length > 0) bodies.unshift({ path: relativePath, body: inline });

  // Structured hrefs are appended as bare anchors so extractLinks() sees inline
  // and structured links through one path.
  const anchorTags = hrefs.map((url) => `<a href="${url}"></a>`);
  const baseBodyFile = bodyFiles.get(baseLocale);
  const bodyFileHtml = baseBodyFile === undefined ? '' : (bodies.find((b) => b.path === baseBodyFile)?.body ?? '');
  const body = [...text, bodyFileHtml, ...anchorTags].filter((s) => s.length > 0).join('\n');

  return { relativePath, frontmatter, body, bodies };
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
