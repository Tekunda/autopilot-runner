// design-review: the AGGRESSIVE aesthetics vision-judge gate (sibling of visual-qa). visual-qa is a
// BREAKAGE gate -- it fails only on a CLEAR divergence and is deliberately tuned NOT to nitpick --
// so a page that is technically intact but cramped, edge-jammed, or hierarchy-less passes it. This
// gate exists to catch exactly that "technically-passing but ugly" class: it runs the SAME render ->
// screenshot -> judge pipeline (createVisionGate) but frames the judge with AGGRESSIVE_DESIGN_PROFILE,
// which flags clear aesthetic weakness even when the layout is functional and treats "meeting a
// literal constraint" (no overflow, one line) as no defense against cramming.
//
// It is a separate gate with its OWN PR check and its OWN report-only->blocking burn-in lever, so a
// tenant can adopt it without touching visual-qa's behavior. Like the other heavy gates it runs ONLY
// in the dedicated heavy stage (a browser + a live served site) and is gated on its own entitlement
// (pack:design). blocking defaults true in the registry, so a tenant sets `blocking:false` in its
// gate config to burn it in report-only first.

import { createVisionGate } from './vision-gate.ts';
import { AGGRESSIVE_DESIGN_PROFILE } from './judge.ts';

export const DESIGN_REVIEW_GATE_ID = 'design-review';

// The default-wired gate for the heavy stage's registry: real Playwright browser + real vision
// judge, both built lazily on first run, framed by the aggressive aesthetics rubric.
export const designReviewGate = createVisionGate({
  id: DESIGN_REVIEW_GATE_ID,
  profile: AGGRESSIVE_DESIGN_PROFILE,
});
