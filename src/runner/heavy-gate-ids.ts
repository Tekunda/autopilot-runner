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
