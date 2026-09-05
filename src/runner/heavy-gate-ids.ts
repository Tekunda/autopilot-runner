// Single source of truth for the URL-bound heavy gate ids -- gates that can ONLY run in the
// dedicated heavy stage (src/runner/serve-and-gate.ts) against a LIVE served site. Two places
// key off this list and MUST NOT drift:
//   - the heavy stage itself, which threads the served baseUrl into exactly these gates; and
//   - the CIRunner adapter's fast-vs-heavy dispatch, which must route a grant naming any of
//     them to `gate-mode: heavy` (else no server comes up and the gate skips every run).
// Every URL-bound gate needs heavy dispatch BY CONSTRUCTION, so the adapter derives its trigger
// set from THIS list rather than a hand-maintained parallel one. Kept in a tiny dependency-free
// module (no gate catalog / control-plane imports) so the adapter can import the ids without
// pulling in the whole heavy toolchain. The gate-routing-coverage test enforces the invariant.
export const URL_BOUND_HEAVY_GATE_IDS = ['seo-site-crawl', 'visual-qa', 'e2e', 'layout-rules'] as const;

// The SITE-SCOPED deterministic gates -- content/SEO gates that judge the CHECKOUT, not a served
// site, but whose RULES are per-brand (banned phrases, competitor lists, commercial-link patterns,
// locale layout). A dual-brand monorepo needs `banned-phrase` to apply one brand's long phrase
// list to that brand's files and the other brand's much shorter one to its own, which a single
// unsuffixed run with base config cannot express -- the gap that once grew a private `scopes`
// option inside banned-phrase and got it copied into competitor-mentions. Both are gone: with the
// per-site split closing the gap, nothing reads `scopes` any more.
//
// So these run ONCE PER SITE like the URL-bound ones, with that site's `gateConfig` overlaid and
// a ` (<site>)` check suffix -- but WITHOUT a server, and with `ctx.changedFiles` narrowed to the
// files that site owns (its `paths`, plus every file no site claims). Being diff-scoped is what
// makes that narrowing meaningful: each of these gates reads ctx.changedFiles and judges only
// what the diff touched.
//
// DISJOINT from URL_BOUND_HEAVY_GATE_IDS by construction -- a gate is judged against a server or
// against the tree, never both -- and serve-and-gate.ts's three-way split assumes that.
//
// DELIBERATELY NOT ADDED to the adapter's HEAVY_DISPATCH_GATE_IDS. Needing no server, these gates
// do not REQUIRE the heavy stage, and forcing one would buy a production build per site for a
// gate that only reads files. A grant naming none of the URL-bound ids therefore still runs the
// fast stage, where `sites` does not apply and these gates run once with base config -- exactly
// what they do today. The per-site split is an addition to the heavy path, never a new
// requirement for one.
export const SITE_SCOPED_GATE_IDS = [
  'banned-phrase',
  'competitor-mentions',
  'internal-links',
  'i18n-completeness',
  'cannibalization',
  'meta-lengths',
  // The deprecated alias for the meta-lengths logic (gates/gate-id-aliases.ts GATE_ID_ALIASES). Listed
  // because an unexpired grant issued before the split still carries it in a SIGNED spec that
  // nothing may rewrite, and the file scoping it needs is the canonical gate's. A tenant writes
  // per-site config under the canonical id, so an alias spec overlays nothing and runs on base
  // config -- no worse than the once-only lane it would otherwise sit in, and correctly scoped.
  // Drop this entry with the alias itself, not before.
  'cover-title',
  'cover-image',
  'external-links',
] as const;
