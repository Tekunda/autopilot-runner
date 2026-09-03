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

export interface Page {
  relativePath: string;
  frontmatter: Frontmatter;
  body: string;
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
