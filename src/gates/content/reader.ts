// Shared markdown+frontmatter parsing for content-scanning gates. Pages are
// markdown files with a YAML-ish frontmatter block (title/description/
// keyword), the format the Website pipeline's content pages use.
//
// This lives under src/gates/, NOT src/packs/, on purpose. It is commodity
// parsing (frontmatter, links, images, page selection) with no licensed
// judgment in it, and two gates the runner bundles unconditionally --
// visual-qa and layout-rules -- read pages through it. While it sat in
// src/packs/seo/ those two bundled gates forced a licensed-pack file into the
// public runner package. Tekunda/autopilot-runner is a PUBLIC repo, so anything
// runner-dist/ needs is world-readable: shared parsing belongs here, and the
// gates that judge what the parsing returns stay in src/packs/ and never ship.
// See src/packaging/build-runner-dist.ts.

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

import * as jsonImpl from './json.ts';

import type { Frontmatter, Image, IndexedRecord, Link, Page, PageClassification } from './types.ts';
export type {
  Frontmatter,
  Image,
  IndexedRecord,
  IndexedTitle,
  Link,
  Page,
  PageBody,
  PageClassification,
} from './types.ts';

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
// Keys may carry the `og:image` / `twitter:card` colon convention, so `:` (along with `-` and
// `.`) is part of the KEY charset. The class is GREEDY, so the split lands on the LAST colon the
// key charset can reach and the value is everything after it -- no whitespace required, since the
// separator is `[ \t]*`. The one behavioural difference from a first-colon split is
// `title:Foo:bar`, which reads as key `title:Foo`; that is not valid YAML anyway, and the
// `og:image:` / `twitter:card:` keys it buys are real. Nested YAML (a value on its own indented
// lines) is still ignored, exactly as before: this is a YAML-ish scalar reader, not a YAML parser.
const FRONTMATTER_LINE_RE = /^([A-Za-z0-9_][A-Za-z0-9_:.-]*):[ \t]*(.*)$/;
const IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const LINK_RE = /(?<!!)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

export function parseFrontmatter(raw: string): { frontmatter: Frontmatter; body: string } {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    return { frontmatter: {}, body: raw };
  }

  const [, block, body] = match;
  const frontmatter: Frontmatter = {};
  for (const line of block.split(/\r?\n/)) {
    const lineMatch = FRONTMATTER_LINE_RE.exec(line);
    if (!lineMatch) continue;
    const [, key, rawValue] = lineMatch;
    const value = stripQuotes(rawValue.trim());
    if (key === 'title' || key === 'description' || key === 'keyword') {
      frontmatter[key] = value;
    }
    // Recorded for EVERY key, the three typed ones included, so a reader that works off `fields`
    // never has to know which keys happen to have a typed home. An empty value is kept out: a
    // bare `cover:` declares nothing, and letting it through would read as "a cover is set".
    if (value.length > 0) (frontmatter.fields ??= {})[key] = value;
  }
  return { frontmatter, body };
}

export async function loadPage(rootDir: string, relativePath: string): Promise<Page> {
  const raw = await readFile(path.resolve(rootDir, relativePath), 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  return { relativePath, frontmatter, body };
}

// Recursively lists every `.md` file under `<rootDir>/<contentDir>`, relative
// to `rootDir`. A missing content dir yields no pages rather than throwing --
// a repo that doesn't use the content tree yet just has nothing to check.
export async function listContentFiles(rootDir: string, contentDir: string): Promise<string[]> {
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
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(path.relative(rootDir, full));
      }
    }
  }

  await walk(base);
  return results;
}

// True if `relativePath` is a markdown file inside `<rootDir>/<contentDir>`.
export function isContentFile(rootDir: string, contentDir: string, relativePath: string): boolean {
  if (!relativePath.endsWith('.md')) return false;
  const abs = path.resolve(rootDir, relativePath);
  const contentAbs = path.resolve(rootDir, contentDir);
  return abs === contentAbs || abs.startsWith(contentAbs + path.sep);
}

// Names that live INSIDE a content tree but are documentation ABOUT it rather than
// pages OF it, so no route exists to render or check. The gated repo deliberately
// keeps `content/site/README.md` as its content-model documentation, so a PR that
// touches one of these is routine, not an edge case. Matched case-insensitively on
// the basename up to its first dot, because these are conventions (`Readme.md`,
// `README.en.md`) rather than exact filenames.
//
// The list is this short because the bar is CERTAINTY (see PageClassification): a
// name only belongs here if no site would ever route it. `changelog` and `license`
// are deliberately ABSENT -- `/changelog` and `/license` are ordinary marketing
// routes, and excluding them would silently drop real pages, which is exactly the
// failure this module exists to prevent. `code_of_conduct` is listed in its
// underscore form only; a routed page would be `code-of-conduct`.
const NON_PAGE_BASENAMES = new Set([
  'readme', // documents the content model; no site routes /readme
  'contributing', // instructions for editors of the tree, not content in it
  'code_of_conduct', // repo policy file, distinct from a routed code-of-conduct page
]);

// Whether a file should be treated as a page a content gate can check.
//
// The name-only half of the classification, shared by both readers: a file whose
// NAME marks it as documentation or repo metadata is not a page in any format.
export function nonPageNameReason(relativePath: string): string | undefined {
  const base = path.basename(relativePath);
  // Dotfiles inside a content tree are tooling config (`.eslintrc.json`,
  // `.prettierrc.json`), never routes. Only the JSON/auto reader can actually
  // reach this: a dotfile with no `.md` never passes the markdown scope check.
  if (base.startsWith('.')) return `${base} is a dotfile, not a page`;
  // First dot, not last, so a locale-suffixed `README.en.md` reads as `readme`.
  const stem = (base.split('.')[0] ?? '').toLowerCase();
  if (NON_PAGE_BASENAMES.has(stem)) {
    return `${base} documents the content tree, it is not a page in it`;
  }
  return undefined;
}

// Markdown has no publish flag to consult -- a page IS its file -- so the name is
// the whole rule here, and the answer is always conclusive. Deliberately does NO
// disk access: markdown route derivation is lexical everywhere else in the gates
// (see markdownRoute), and a classifier that silently disagreed with it about
// which files exist would be worse than the crash it prevented.
export function classifyMarkdownPage(relativePath: string): PageClassification {
  const reason = nonPageNameReason(relativePath);
  return reason ? { isPage: false, reason } : { isPage: true };
}

export function extractLinks(body: string): Link[] {
  const links: Link[] = [];
  for (const match of body.matchAll(LINK_RE)) {
    links.push({ text: match[1], url: match[2] });
  }
  return links;
}

export function extractImages(body: string): Image[] {
  const images: Image[] = [];
  for (const match of body.matchAll(IMAGE_RE)) {
    images.push({ alt: match[1], src: match[2] });
  }
  return images;
}

// Level-1 (`# `) markdown headings, in document order.
export function extractH1s(body: string): string[] {
  const headings: string[] = [];
  for (const match of body.matchAll(/^#(?!#)\s+(.+)$/gm)) {
    headings.push(match[1].trim());
  }
  return headings;
}

// The route a markdown content file serves: `<contentDir>/foo/bar.md` -> `/foo/bar`,
// and an `index.md` collapses to its parent route (`<contentDir>/index.md` -> `/`).
function markdownRoute(rootDir: string, contentDir: string, relativePath: string): string {
  const rel = path.relative(path.resolve(rootDir, contentDir), path.resolve(rootDir, relativePath));
  const noExt = rel.replace(/\.md$/, '');
  const trimmed = noExt.replace(/(?:^|\/)index$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

// The content-format abstraction. A gate resolves a reader once from tenant
// config and drives it, instead of hard-coding the markdown helpers -- so the
// same changed-file gates run against markdown or JSON content trees. The
// markdown implementation delegates to the functions above (behavior byte-for-
// byte unchanged); the JSON implementation lives in ./content-json.ts.
export type ContentFormat = 'md' | 'json' | 'auto';

export interface ContentReaderOptions {
  rootDir: string;
  contentDir: string;
  /** Locale whose title/description/body a JSON page is read from. Default 'en'. */
  baseLocale?: string;
}

export interface ContentReader {
  isContentFile(relativePath: string): boolean;
  /**
   * Whether a file the tree CONTAINS is a page the tree PUBLISHES. `isContentFile`
   * answers "is this in scope" (extension + directory); this answers "does a route
   * exist for it", which is what a changed-file gate actually needs before it reads
   * or renders the file. See PageClassification for the fail-safe asymmetry.
   */
  classifyPage(relativePath: string): Promise<PageClassification>;
  listContentFiles(): Promise<string[]>;
  loadPage(relativePath: string): Promise<Page>;
  extractLinks(body: string): Link[];
  extractImages(body: string): Image[];
  extractH1s(body: string): string[];
  /**
   * Whether the bodies this reader returns are FRAGMENTS the site's renderer wraps in a
   * template, rather than whole documents. It decides which way the H1 rule points, and the
   * two directions are opposites -- so a gate that assumes one is wrong on every page of the
   * other.
   *
   * A markdown page IS the document: no `# ` heading means the rendered page has no H1 at all,
   * and that is the defect. A JSON body fragment is rendered INSIDE a component that already
   * emits the `<h1>` from the page's title field, so a fragment correctly starts at `<p>`/`<h2>`
   * and an `<h1>` INSIDE it is the defect -- it renders a second H1 on the page.
   */
  bodyIsFragment(relativePath: string): boolean;
  /** The route the file serves, for diff-driven target derivation (visual-qa). */
  routeFor(relativePath: string): Promise<string>;
  /**
   * Every (locale, route) surface the record publishes -- its rendered title, the
   * field that produced it, and the URL segment it occupies -- plus its publication
   * status. What a cross-tree collision check needs, in one read per file.
   *
   * Distinct from `loadPage`, which is base-locale-only and carries the body: a
   * duplicate `<title>` that exists in `de` and not in `en` is invisible through
   * `loadPage`, and that is precisely the defect class this exists to expose.
   */
  indexRecord(relativePath: string): Promise<IndexedRecord>;
}

// A markdown page publishes ONE surface: markdown has no locale dimension and no
// SEO-title override, so the frontmatter `title` is the rendered title and the
// filename is the URL segment.
function markdownIndexedRecord(page: Page, route: string, baseLocale: string): IndexedRecord {
  const parts = route.split('/').filter(Boolean);
  const title = page.frontmatter.title ?? '';
  return {
    relativePath: page.relativePath,
    status: page.frontmatter.fields?.status,
    keyword: page.frontmatter.keyword,
    titles: [
      {
        locale: baseLocale,
        route: parts.slice(0, -1).join('/').toLowerCase(),
        title,
        titleField: 'title',
        segment: parts.length > 0 ? parts[parts.length - 1].toLowerCase() : '',
        segmentField: 'filename',
      },
    ],
  };
}

function createMarkdownReader(opts: ContentReaderOptions): ContentReader {
  const { rootDir, contentDir, baseLocale = jsonImpl.DEFAULT_BASE_LOCALE } = opts;
  return {
    isContentFile: (rel) => isContentFile(rootDir, contentDir, rel),
    classifyPage: async (rel) => classifyMarkdownPage(rel),
    listContentFiles: () => listContentFiles(rootDir, contentDir),
    loadPage: (rel) => loadPage(rootDir, rel),
    extractLinks,
    extractImages,
    extractH1s,
    bodyIsFragment: () => false,
    routeFor: async (rel) => markdownRoute(rootDir, contentDir, rel),
    indexRecord: async (rel) =>
      markdownIndexedRecord(
        await loadPage(rootDir, rel),
        markdownRoute(rootDir, contentDir, rel),
        baseLocale,
      ),
  };
}

function createJsonReader(opts: ContentReaderOptions): ContentReader {
  const { rootDir, contentDir, baseLocale = jsonImpl.DEFAULT_BASE_LOCALE } = opts;
  return {
    isContentFile: (rel) => jsonImpl.isJsonContentFile(rootDir, contentDir, rel),
    // Name first (no I/O for the obvious cases), then the loader-derived check,
    // which has to read the document to decide.
    classifyPage: async (rel) => {
      const reason = nonPageNameReason(rel);
      return reason ? { isPage: false, reason } : jsonImpl.classifyJsonDocument(rootDir, rel, baseLocale);
    },
    listContentFiles: () => jsonImpl.listJsonContentFiles(rootDir, contentDir),
    loadPage: (rel) => jsonImpl.loadJsonPage(rootDir, rel, baseLocale),
    extractLinks: jsonImpl.extractJsonLinks,
    extractImages: jsonImpl.extractJsonImages,
    extractH1s: jsonImpl.extractJsonH1s,
    bodyIsFragment: () => true,
    routeFor: (rel) => jsonImpl.jsonPageRoute(rootDir, contentDir, rel),
    indexRecord: (rel) => jsonImpl.indexJsonRecord(rootDir, contentDir, rel, baseLocale),
  };
}

// For a mixed tree: recognize both formats and dispatch per file by extension.
// Body-level extractors union markdown + HTML results (a given body is only one
// format, so the other yields nothing).
function createAutoReader(opts: ContentReaderOptions): ContentReader {
  const md = createMarkdownReader(opts);
  const json = createJsonReader(opts);
  const readerFor = (rel: string): ContentReader => (rel.endsWith('.json') ? json : md);
  return {
    isContentFile: (rel) => md.isContentFile(rel) || json.isContentFile(rel),
    classifyPage: (rel) => readerFor(rel).classifyPage(rel),
    listContentFiles: async () => [...(await md.listContentFiles()), ...(await json.listContentFiles())],
    loadPage: (rel) => readerFor(rel).loadPage(rel),
    extractLinks: (body) => [...md.extractLinks(body), ...json.extractLinks(body)],
    extractImages: (body) => [...md.extractImages(body), ...json.extractImages(body)],
    extractH1s: (body) => [...md.extractH1s(body), ...json.extractH1s(body)],
    bodyIsFragment: (rel) => readerFor(rel).bodyIsFragment(rel),
    routeFor: (rel) => readerFor(rel).routeFor(rel),
    indexRecord: (rel) => readerFor(rel).indexRecord(rel),
  };
}

// What a content gate should actually work on, given a list of candidate files (a
// PR's changed files, or the whole content tree): the ones that are in scope AND
// are pages, plus a line per file the selection treated as anything other than a
// plain page.
//
// Callers MUST put `notes` into the gate's OWN result (findings/log), not just
// stdout: a gate that drops a file without saying so on its verdict is
// indistinguishable from a gate that checked the file and passed it, which is the
// exact hole this exists to close.
export interface PageSelection {
  pages: string[];
  notes: string[];
  /**
   * The selected pages whose classification was INCONCLUSIVE (`isPage: true` WITH a reason).
   * They stay in `pages` -- the fail-safe direction is unchanged, and every structural rule
   * still applies to them -- but a caller must not assert anything about their METADATA.
   *
   * "We could not confidently read this document" and "this document's title is missing" are
   * different statements, and only the first one is true. Website's legal pages carry ar/fr/de
   * copy while the English body comes from Notion; grading their base-locale metadata reported
   * three missing titles and three missing descriptions that no one could act on, because the
   * title is not absent, it is simply not here.
   */
  inconclusive: Set<string>;
}

export async function selectPages(
  reader: ContentReader,
  candidates: readonly string[],
): Promise<PageSelection> {
  const inScope = candidates.filter((file) => reader.isContentFile(file));
  // Classified concurrently: the JSON reader touches disk per file, and the
  // whole-tree callers hand this hundreds of paths at a time.
  const classified = await Promise.all(inScope.map((file) => reader.classifyPage(file)));

  const pages: string[] = [];
  const notes: string[] = [];
  const inconclusive = new Set<string>();
  inScope.forEach((file, i) => {
    const { isPage, reason } = classified[i];
    if (!isPage) {
      notes.push(`skipped ${file}: ${reason}`);
      return;
    }
    // isPage with a reason == inconclusive: checked anyway (the safe side), but
    // said out loud so the run explains why it looked at an odd file.
    if (reason) {
      notes.push(`checking ${file} despite an inconclusive classification: ${reason}`);
      inconclusive.add(file);
    }
    pages.push(file);
  });
  return { pages, notes, inconclusive };
}

// The `notes` a gate carries on its result, tagged so they read as provenance
// rather than as defects found on the page.
export function asGateNotes(notes: readonly string[]): string[] {
  return notes.map((note) => `note: ${note}`);
}

export function createContentReader(format: ContentFormat, opts: ContentReaderOptions): ContentReader {
  switch (format) {
    case 'json':
      return createJsonReader(opts);
    case 'auto':
      return createAutoReader(opts);
    case 'md':
    default:
      return createMarkdownReader(opts);
  }
}
