// The two pieces of the JSON content model that answer "where does a locale's content live",
// split out of ./json.ts because both of its consumers now sit on opposite sides of it: the page
// COMPOSER (json.ts, which resolves a document's `bodyFile` references to build a page) and the
// REVERSE lookup (packs/content/content.ts, which asks which page a changed fragment belongs to).
// Nothing here imports either of them, so neither import direction can become a cycle.
//
// Lives under src/gates/ for the same reason ./json.ts does: commodity parsing with no licensed
// judgment in it. See ./reader.ts's header.

import path from 'node:path';

// A `{ <locale>: ... }` map, recognized by the presence of the BASE locale. A block that omits
// the base locale is not treated as a locale map at all -- see json.ts's callers for the one
// place that deliberately asks a looser question.
export function isLocaleMap(value: unknown, baseLocale: string): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.hasOwnProperty.call(value, baseLocale)
  );
}

// The `bodyFile` each locale of a document declares, as repo-relative paths keyed by locale.
// The file is resolved beside the page JSON (the `.html` sits next to the article `.json`).
// Locales are returned in authored order.
export function bodyFilePaths(relativePath: string, parsed: unknown, baseLocale: string): Map<string, string> {
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
