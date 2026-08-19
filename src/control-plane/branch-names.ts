// Human-readable, ref-safe branch/PR naming shared by the control plane (ticket /
// integration branches, rollup/promote PR titles) and the runner (coding-stage
// branch, subtask PR title -- see src/runner/prepare-stage.ts). Deriving names from
// a slug of the ticket title instead of the opaque ticket UUID makes branches and
// PRs legible in the GitHub UI, while a short id suffix keeps them collision-proof.

// A short, filesystem/ref-safe slug of arbitrary text: lowercased, non-alphanumerics
// collapsed to single dashes, trimmed, and capped so a long title doesn't produce an
// unwieldy name. Empty/blank input -> ''.
export function slugify(text: string, maxLen = 48): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
}

// A stable, short, ref-safe id derived from a ticket id -- the first 8 alphanumerics,
// so `ticket/<slug>-<shortId>` stays unique even when two tickets share a title.
export function shortTicketId(ticketId: string): string {
  return ticketId.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'ticket';
}

// `<slug-of-title>-<shortId>`, the readable stem the control plane's ticket and
// integration branches share for one ticket. Falls back to the short id alone when
// the title has no slug-able characters.
export function ticketBranchStem(ticketId: string, title: string | undefined): string {
  const slug = slugify(title ?? '');
  const short = shortTicketId(ticketId);
  return slug ? `${slug}-${short}` : short;
}
