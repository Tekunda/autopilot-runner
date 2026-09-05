// The data shapes a parsed content page takes, shared by BOTH readers.
//
// They live in their own module for one structural reason: reader.ts (markdown/auto) needs
// json.ts's implementation, and json.ts needs these types. With the types declared in
// reader.ts that is a cycle -- type-only, so it never broke at run time, but it was carried
// as a baselined layering violation rather than fixed. Nothing here imports anything, so the
// cycle cannot re-form: both readers now depend on this module and not on each other's shapes.
//
// reader.ts re-exports every one of these, so `import type { Page } from './reader.ts'` keeps
// working for the gates that already do it.

export interface Frontmatter {
  title?: string;
  description?: string;
  keyword?: string;
  // Every OTHER scalar frontmatter key, verbatim (quotes stripped), keyed by its declared name.
  // The three fields above stay typed because every gate reads them; the open bag exists so a
  // gate can read a key this parser was never taught -- the cover-image gate looks for `cover` /
  // `coverImage` / `image` / `ogImage` / `og:image`, and which of those a tenant's content tree
  // uses is a tenant convention, not something to enumerate in a type. Absent when the page has
  // no frontmatter block.
  fields?: Record<string, string>;
}

// One authored body fragment of a page, and the file an editor would open to change it.
// A content model that keeps its body OUTSIDE the page file (articles that put per-locale
// HTML in sibling `.html` files named by `copy.<locale>.bodyFile`) has one of these per locale,
// so a body-level finding can name the `.nl.html` that actually carries the defect instead of
// the `.json` that merely references it.
export interface PageBody {
  /** Repo-relative path of the file holding this fragment. */
  path: string;
  body: string;
}

export interface Page {
  relativePath: string;
  frontmatter: Frontmatter;
  body: string;
  // Every authored fragment the page owns, ACROSS locales -- present only for content models
  // that split the body out of the page file. Absent for markdown, where the page IS its body
  // and `body` already says everything. `body` stays the base-locale view every other gate
  // reads; this is the additional per-file view a gate needs when it must name the offending
  // file (see seo-monitor's H1 rule).
  bodies?: PageBody[];
}

export interface Link {
  text: string;
  url: string;
}

export interface Image {
  alt: string;
  src: string;
}

// The asymmetry is deliberate and is the house rule: `isPage` is false ONLY when
// we are certain the file is not a page -- its name is a repo-convention document,
// or it is not in the checkout at all. A classification we could not make resolves
// to `isPage: true` and carries a `reason`, so an unrecognized file gets
// over-checked (costing a finding a human can read) rather than silently dropped
// (costing the check itself). "Cannot tell" must never read as "not a page".
export interface PageClassification {
  isPage: boolean;
  /** Why the file is not a page, or why the classification was inconclusive. */
  reason?: string;
}

// One indexable surface a content record publishes: for ONE locale, on ONE route,
// the `<title>` the page emits there and the URL segment it occupies.
//
// A record can publish several: a multilingual document has one per locale, and an
// article routed by its `scopes` array has one per (locale, scope). The
// cannibalization gate compares these across the tree, so every field it needs to
// name a defect an AUTOFIXER can act on is carried here -- including which field
// produced each value. "Two pages emit the same title" is not actionable; "98's
// `copy.de.seoTitle` equals 116's `copy.de.title`" is.
export interface IndexedTitle {
  locale: string;
  // The route prefix the segment hangs off, normalized: lower-case, no leading or
  // trailing slash. '' is the site root. Two records collide on a URL only when
  // this AND `segment` match; they collide on a TITLE across DIFFERING routes,
  // which is why the two are separate fields and separate rules.
  route: string;
  // The title the page actually emits -- an SEO override where one is set, the
  // editorial title otherwise. Verbatim, NOT normalized: a gate reporting the
  // colliding string has to print what is actually in the file.
  title: string;
  // Where `title` came from, as an addressable path into the record
  // (`copy.de.seoTitle`, `seo.en.title`, `title`). This is the autofix target.
  titleField: string;
  // The URL segment this record occupies under `route`, verbatim.
  segment: string;
  // Where `segment` came from (`copy.ar.publicSlug`, `slug`, `filename`).
  segmentField: string;
}

// A content record reduced to what a cross-tree collision check needs, in ONE read
// of the file. Deliberately not `Page`: `Page` is base-locale-only (so it cannot
// see a collision that exists in `de` and not in `en`) and it carries the body,
// which a collision check never reads and which is the expensive part of loading
// several hundred records.
export interface IndexedRecord {
  relativePath: string;
  // The record's publication status, verbatim. The content-tree convention, and the
  // rule the gate applies, is that ABSENT means published; `draft`/`archived` mean the
  // record is not indexable and therefore cannot cannibalize anything.
  status?: string;
  // The declared target keyword, where the format has one (markdown frontmatter).
  keyword?: string;
  titles: IndexedTitle[];
}
