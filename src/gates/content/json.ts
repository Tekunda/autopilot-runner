// JSON content adapter for a git-backed content tree whose pages are not
// markdown-with-frontmatter but JSON documents under a content dir
// (`<contentDir>/pages/**.json`, `<contentDir>/articles/**.json`): per-locale
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

import type {
  Frontmatter,
  Image,
  IndexedRecord,
  IndexedTitle,
  Link,
  Page,
  PageBody,
  PageClassification,
} from './types.ts';

export const DEFAULT_BASE_LOCALE = 'en';

// True if `relativePath` is a `.json` file inside `<rootDir>/<contentDir>`. A
// tenant scopes which JSON counts as a page via `contentDir` (e.g. a
// `content/pages` directory), mirroring how the markdown reader scopes `.md`.
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
// that nests its SEO still resolves. The surveyed tree keeps it at the document root.
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
// section item's button target is `cta` (`sections[].items[].cta`, passed through the app's own
// link normaliser), and on a large content tree that accounted for a few hundred relative links
// across dozens of pages -- whole page families, the home page included -- being counted as zero
// outbound links. That, not "React renders these CTAs so the data has no links", is why
// section-composition pages looked link-less.
//
// The list is what a survey of a real tree ACTUALLY found, not a guess at what a CMS might use:
// `link`, `url`, `to` and `buttonHref` do not occur here and are deliberately absent.
// Excluded on purpose: `src` (image sources -- extractJsonImages' job, and counting art as an
// outbound link would inflate every page), `body`/`subtitle`/`scriptCode` (prose and code that
// merely CONTAIN URL-ish text; the HTML in them is already scanned by extractJsonLinks), and
// `route` (screenshot-capture metadata in a capture manifest, which is not a rendered link
// and not even a document).
const LINK_KEYS = ['href', 'cta', 'ctaUrl', 'caseHref', 'demoUrl', 'secondaryButton', 'secondaryButtonSlug'];

// Whether a value under a link key is a link TARGET rather than link TEXT. The distinction is
// load-bearing, not defensive: `cta` carries a URL at `items[].cta` and a LOCALIZED BUTTON
// LABEL at `items[].copy.<locale>.cta` -- in the surveyed tree, hundreds of its values are
// prose ("Explore the task-based workflow"). Counting those as links would replace one wrong
// number with another.
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
  // STRING in most places and a nested COPY OBJECT (`{title, sub, primary}`) in the rest. Skipping
  // the key name -- as this loop used to do for `href` -- would drop that copy out of the body the
  // editorial gates scan. Recursing into a string is already a no-op (the guard above returns), so
  // there is nothing to skip and nothing to lose.
  for (const child of Object.values(obj)) {
    collectCopy(child, baseLocale, text, hrefs);
  }
}

// The `bodyFile` each locale of a document declares, as repo-relative paths keyed by locale.
// The file is resolved beside the page JSON (the `.html` sits next to the article `.json`).
// Locales are returned in authored order.
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
// ledgers alongside its pages -- a keyword-targeting ledger under a `globals/` directory
// that nearly every content commit touches, say -- and a ledger has no title, no meta
// description and no body to link out of. Auditing one
// as a page is not a strict check, it is a wrong one: it produced "missing title" and
// "0 internal links" on a file where those words mean nothing, on every content PR.
//
// The rule is STRUCTURAL, not path-based: a document declares its per-locale content under
// a root `seo` or `copy` key. Everything the loader publishes has one (pages via `seo`,
// articles/help-center/releases via `copy`); config, navigation and ledgers have neither.
// A root `seo`/`copy` that is not a locale map for THIS base locale keeps the fail-safe
// asymmetry: it is a document whose base locale we could not read, so `isPage: true` with
// a reason, never a silent drop.
/**
 * What KIND of thing a parsed JSON file under the content dir is. The one structural
 * ruling in this module, shared by every caller that needs it -- `classifyJsonDocument`
 * (which turns it into the fail-safe `PageClassification` a changed-file gate consumes)
 * and `indexJsonRecord` (which decides from it whether a record may enter a
 * cross-tree collision index). Two callers re-deriving "what counts as a document"
 * from the raw keys is exactly how they drift apart.
 *
 * The kinds are deliberately FINER-GRAINED than `PageClassification`'s
 * page/not-page/inconclusive triple, because the two consumers need different cuts of
 * the same fact:
 *
 *   - `unreadable`   present, but not a JSON object. Nothing about it can be read, so
 *                    no consumer may assert anything -- but a page may well exist, so
 *                    the changed-file gates still CHECK it (`isPage: true` + reason).
 *   - `not-a-document` no root `seo`/`copy`: config, navigation or a ledger. Certainly
 *                    not a page, for anyone.
 *   - `base-locale-absent` a real document whose `seo`/`copy` omits the BASE locale.
 *                    Its base-locale VIEW is empty -- which is all `PageClassification`
 *                    can say, hence inconclusive -- but the locales it DOES define were
 *                    read with full certainty. A per-locale consumer is entitled to
 *                    them; a base-locale consumer is not.
 *   - `document`     a document publishing a base-locale view.
 */
export type JsonDocumentKind =
  | { kind: 'document' }
  | { kind: 'base-locale-absent'; reason: string }
  | { kind: 'not-a-document'; reason: string }
  | { kind: 'unreadable'; reason: string };

/**
 * The structural ruling, on an ALREADY-PARSED value. Pure and synchronous on purpose:
 * `indexJsonRecord` has the document in hand and must not pay a second read of the
 * same file to learn what it already holds.
 */
export function classifyParsedJsonDocument(parsed: unknown, baseLocale: string): JsonDocumentKind {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'unreadable', reason: 'could not be read as a JSON page document' };
  }
  const doc = parsed as Record<string, unknown>;
  const declares = ['seo', 'copy'].filter((key) => key in doc);
  if (declares.length === 0) {
    return {
      kind: 'not-a-document',
      reason:
        'it declares no `seo` or `copy` block, so the content loader publishes no page for it ' +
        '(config, navigation or ledger data that lives in the content tree, not a document of it)',
    };
  }
  if (!declares.some((key) => isLocaleMap(doc[key], baseLocale))) {
    return {
      kind: 'base-locale-absent',
      reason: `its \`${declares.join('`/`')}\` block defines no "${baseLocale}" locale, so the base-locale view of it is empty`,
    };
  }
  return { kind: 'document' };
}

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
  const ruling = classifyParsedJsonDocument(await safeReadJson(abs), baseLocale);
  switch (ruling.kind) {
    case 'document':
      return { isPage: true };
    case 'not-a-document':
      return { isPage: false, reason: ruling.reason };
    // Both remaining kinds are INCONCLUSIVE: checked anyway (the fail-safe side),
    // with the reason said out loud. See PageClassification.
    default:
      return { isPage: true, reason: ruling.reason };
  }
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
// Both matter. A `tools.json` beside a `tools/` directory satisfies (1) -- but if its
// `tools-list` section carries items it authored itself, it is a real page that really should
// link, and it is NOT excluded. A detail page like `glossary/<term>.json` fails (1): nothing
// sits under it.
//
// The route slug is deliberately NOT used to find the children: slugs are inconsistent in a real
// tree (some are fully qualified, `<section>/<group>/<page>`, others are a bare leaf), so a
// slug-prefix walk misses half the hubs. The directory layout is the reliable fact.
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

// The whole of the page shape that is derivable from the PARSED document alone. Split out of
// loadJsonPage so the same derivation serves a document that is not on disk -- a blob read out of
// git history, which is how a gate compares a changed page against its base revision. The one
// thing this cannot do for itself is the sibling `.html` fragments the document REFERENCES: those
// live beside it in whatever revision it came from, so the caller fetches them and hands them in --
// `baseBodyHtml` for the base-locale view `body` joins, `fetchedBodies` for the per-file view.
function pageFromParsedJson(
  parsed: unknown,
  relativePath: string,
  baseLocale: string,
  baseBodyHtml: string,
  fetchedBodies: PageBody[],
): Page {
  const frontmatter = findJsonMeta(parsed, baseLocale);

  const text: string[] = [];
  const hrefs: string[] = [];
  collectCopy(parsed, baseLocale, text, hrefs);

  const bodies: PageBody[] = [...fetchedBodies];
  // The document's own inline copy is a fragment too -- it is where a page that composes
  // sections instead of referencing a `bodyFile` authors its HTML.
  const inline = text.join('\n');
  if (inline.length > 0) bodies.unshift({ path: relativePath, body: inline });

  // Structured hrefs are appended as bare anchors so extractLinks() sees inline
  // and structured links through one path.
  const anchorTags = hrefs.map((url) => `<a href="${url}"></a>`);
  const body = [...text, baseBodyHtml, ...anchorTags].filter((s) => s.length > 0).join('\n');

  return { relativePath, frontmatter, body, bodies };
}

// A JSON page parsed from RAW TEXT rather than from disk -- the seam a base-revision comparison
// needs, since a blob out of `git show` has no path to read. Tolerates malformed JSON exactly as
// safeReadJson does (an empty page, never a throw): a gate that judges content must not turn a bad
// file into an infra fault.
//
// Deliberately does NOT resolve `copy.<locale>.bodyFile`. Reading it would mean reaching back to
// disk for a sibling file that is the WORKING-TREE revision, silently mixing head content into a
// base-revision page. Callers that need the body use loadJsonPage; the SEO fields this exists for
// live in the document itself. `bodies` therefore carries the document's own inline copy alone --
// that copy IS part of the revision handed in, the referenced fragments are not.
export function parseJsonPage(
  raw: string,
  relativePath: string,
  baseLocale: string = DEFAULT_BASE_LOCALE,
): Page {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { relativePath, frontmatter: {}, body: '' };
  }
  return pageFromParsedJson(parsed, relativePath, baseLocale, '', []);
}

export async function loadJsonPage(
  rootDir: string,
  relativePath: string,
  baseLocale: string = DEFAULT_BASE_LOCALE,
): Promise<Page> {
  const parsed = await safeReadJson(path.resolve(rootDir, relativePath));
  if (parsed === undefined) return { relativePath, frontmatter: {}, body: '' };

  // Every locale's body file, not just the base locale's: a defect authored into the Dutch
  // fragment renders on the Dutch page. `body` below still joins the BASE-locale view alone,
  // so every gate that reads it is unaffected; `bodies` is the additional per-file view.
  const bodyFiles = bodyFilePaths(relativePath, parsed, baseLocale);
  // Deduped by PATH, not locale: two locales may point at one file (an untranslated body), and
  // reporting the same file twice would read as two defects in it.
  const fetchedBodies: PageBody[] = await Promise.all(
    [...new Set(bodyFiles.values())].map(async (file) => ({ path: file, body: await readRelative(rootDir, file) })),
  );
  const baseBodyFile = bodyFiles.get(baseLocale);
  const baseBodyHtml =
    baseBodyFile === undefined ? '' : (fetchedBodies.find((b) => b.path === baseBodyFile)?.body ?? '');

  return pageFromParsedJson(parsed, relativePath, baseLocale, baseBodyHtml, fetchedBodies);
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

// The route a JSON page serves: its `slug` (the full route slug, e.g.
// "<section>/<group>/<page>"), falling back to the content-relative path.
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

// ---------------------------------------------------------------------------
// Indexed records: the per-locale, per-route view a collision check needs.
//
// Two document shapes live in one content tree and they carry their
// title in DIFFERENT places, so both are read here:
//
//   article  root `copy.<locale>.{title,seoTitle,publicSlug,bodyFile}`, routed by
//            the `scopes` array (one route per scope -- an article carrying two
//            scopes really is two indexable URLs).
//   page     root `seo.<locale>.{title,description}` plus a root `slug` that is
//            the FULL route ("<section>/<group>/<page>"), so the segment is its last
//            path element and the route is everything before it.
//
// The effective title is `seoTitle || title` for an article and `seo.<loc>.title`
// for a page: that is what the site actually renders into `<title>`. The URL
// segment is `publicSlug || title` for an article -- the rule the content
// loader itself applies -- and the slug's last element for a page.
// ---------------------------------------------------------------------------

// `<node>` read as a locale map: entries whose value is a plain object. Deliberately
// NOT isLocaleMap(), which requires the BASE locale to be present -- a record that
// omits `en` still publishes every other locale it defines, and skipping it would be
// a silent false negative on exactly the multilingual records this check exists for.
function localeEntries(node: unknown): [string, Record<string, unknown>][] {
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return [];
  return Object.entries(node as Record<string, unknown>).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      typeof entry[1] === 'object' && entry[1] !== null && !Array.isArray(entry[1]),
  );
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

// Route keys are compared, never rendered as URLs, so they are canonicalized to one
// shape: lower-case, no leading or trailing slash. A tree writes the same route as
// `<section>/blog` (a scope) and `/<section>/blog` (a slug); those are one route.
function normalizeRoute(route: string): string {
  return route.trim().replace(/^\/+|\/+$/g, '').toLowerCase();
}

// Where a record sits in the tree, as a route -- the fallback for a document that
// declares neither `scopes` nor `slug`.
function pathRoute(rootDir: string, contentDir: string, relativePath: string): string {
  const rel = path.relative(path.resolve(rootDir, contentDir), path.resolve(rootDir, relativePath));
  return normalizeRoute(path.dirname(rel).replace(/^\.$/, ''));
}

function articleTitles(copy: unknown, routes: string[]): IndexedTitle[] {
  const out: IndexedTitle[] = [];
  for (const [locale, block] of localeEntries(copy)) {
    const editorial = nonEmptyString(block.title);
    const override = nonEmptyString(block.seoTitle);
    const publicSlug = nonEmptyString(block.publicSlug);
    // `seoTitle || title` is the rendered <title>; `publicSlug || title` is the URL
    // segment. They fall back to DIFFERENT things on purpose, and a record with
    // neither publishes nothing this check can compare.
    const title = override ?? editorial;
    const segment = publicSlug ?? editorial;
    if (!title && !segment) continue;
    for (const route of routes) {
      out.push({
        locale,
        route,
        title: title ?? '',
        titleField: `copy.${locale}.${override ? 'seoTitle' : 'title'}`,
        segment: segment ?? '',
        segmentField: `copy.${locale}.${publicSlug ? 'publicSlug' : 'title'}`,
      });
    }
  }
  return out;
}

function pageTitles(
  seo: unknown,
  where: { route: string; segment: string; segmentField: string },
): IndexedTitle[] {
  const out: IndexedTitle[] = [];
  for (const [locale, block] of localeEntries(seo)) {
    const title = nonEmptyString(block.title);
    if (!title) continue;
    out.push({ locale, title, titleField: `seo.${locale}.title`, ...where });
  }
  return out;
}

// Where a `seo`-shaped record publishes: its `slug` is the FULL route, so the last
// element is the segment and the rest is the route. A record with no slug is routed
// by its PATH, and its segment is the filename stem -- never the empty string, which
// would make every slugless page in one directory read as one colliding URL.
function pageLocation(
  slug: string,
  relativePath: string,
  fallbackRoute: string,
): { route: string; segment: string; segmentField: string } {
  const parts = normalizeRoute(slug).split('/').filter(Boolean);
  if (parts.length > 0) {
    return { route: parts.slice(0, -1).join('/'), segment: parts[parts.length - 1], segmentField: 'slug' };
  }
  return {
    route: fallbackRoute,
    segment: path.basename(relativePath, '.json').toLowerCase(),
    segmentField: 'filename',
  };
}

// The per-locale, per-route index of one JSON record. A missing or unparseable file
// yields an EMPTY record rather than throwing, exactly as loadJsonPage does: one bad
// document must not abort a whole-tree scan.
//
// WHAT MAY ENTER THE INDEX is decided by `classifyParsedJsonDocument`, the same ruling
// the changed-file gates classify through -- not by re-reading the raw keys here. An
// index entry is one half of a COLLISION PAIR, and a pair built from a record whose
// document-hood we never established is a finding no one can act on:
//
//   - `unreadable`     nothing was read, so nothing is indexed. (This is also the
//                      deleted-file case: `safeReadJson` yields undefined for ENOENT.)
//   - `not-a-document` config, navigation or a ledger. Empty, and NOT merely by
//                      accident of it having no root `copy`/`seo`: `keyword` below is
//                      resolved by a DEPTH-FIRST `findSeo`, so a ledger carrying a
//                      nested `seo.<locale>.keyword` would otherwise contribute a
//                      keyword and collide with a real page.
//   - `base-locale-absent` INDEXED, and deliberately so. This is the one place the two
//                      merged behaviours meet: the ruling is inconclusive only about
//                      the BASE-LOCALE view, and this index is per-locale. An
//                      Arabic-only article's `ar` title was read with full certainty;
//                      dropping it would silently unpublish-from-checking every
//                      non-English record, which is the exact false negative
//                      `localeEntries` exists to prevent.
export async function indexJsonRecord(
  rootDir: string,
  contentDir: string,
  relativePath: string,
  baseLocale: string = DEFAULT_BASE_LOCALE,
): Promise<IndexedRecord> {
  const parsed = await safeReadJson(path.resolve(rootDir, relativePath));
  const ruling = classifyParsedJsonDocument(parsed, baseLocale);
  if (ruling.kind === 'unreadable' || ruling.kind === 'not-a-document') {
    return { relativePath, titles: [] };
  }
  const doc = parsed as Record<string, unknown>;
  const fallbackRoute = pathRoute(rootDir, contentDir, relativePath);

  const scopes = Array.isArray(doc.scopes)
    ? doc.scopes.filter((s): s is string => typeof s === 'string').map(normalizeRoute)
    : [];
  const routes = scopes.length > 0 ? scopes : [fallbackRoute];
  const slug = typeof doc.slug === 'string' ? doc.slug : '';

  // Both shapes are read, never one-or-the-other: a document is free to carry a root
  // `copy` AND a root `seo`, and picking one would drop half its surfaces.
  const titles = [
    ...articleTitles(doc.copy, routes),
    ...pageTitles(doc.seo, pageLocation(slug, relativePath, fallbackRoute)),
  ];

  return {
    relativePath,
    status: nonEmptyString(doc.status),
    keyword: nonEmptyString(findSeo(parsed, baseLocale)?.keyword),
    titles,
  };
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
