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

// A stable, ref-safe key derived from a ticket id -- the FULL id, dashless and
// lowercased. Must be the full id, never a prefix: trackers like Notion issue ids
// sequentially, so a batch of tickets created together shares a long leading run
// (e.g. `3c1ac5b0-4ad7-806f...` and `3c1ac5b0-4ad7-81f7...` share `3c1ac5b04ad7`).
// A short prefix would collapse a whole batch onto one `ticket/<stem>` branch and
// cross-wire their rollups; the full id keeps every ticket's branch unique and lets
// a branch be matched back to its exact ticket for idempotent reuse. Mirrors the
// `ticket/<slug>-<full-id>` scheme of the pipeline this replaced.
export function ticketIdKey(ticketId: string): string {
  return ticketId.toLowerCase().replace(/[^a-z0-9]/g, '') || 'ticket';
}

// A short, readable, effectively-unique label for a ticket id -- the LAST segment of
// the uuid (its high-entropy tail; sequential trackers vary the tail, not the leading
// run, so it stays unique across a batch -- see ticketIdKey), keeping any `.N` subtask
// suffix. Used only for CI run-names and their correlation, where the full 36-char id
// crowds the human title off the line; branch identity still uses the FULL ticketIdKey.
export function shortTicketId(ticketId: string): string {
  const dot = ticketId.indexOf('.');
  const base = dot === -1 ? ticketId : ticketId.slice(0, dot);
  const suffix = dot === -1 ? '' : ticketId.slice(dot);
  const tail = base.split('-').pop() || base;
  return `${tail}${suffix}`;
}

// `<slug-of-title>-<ticketIdKey>`, the readable-yet-collision-proof stem the control
// plane's ticket and integration branches share for one ticket. Falls back to the id
// key alone when the title has no slug-able characters.
export function ticketBranchStem(ticketId: string, title: string | undefined): string {
  const slug = slugify(title ?? '');
  const key = ticketIdKey(ticketId);
  return slug ? `${slug}-${key}` : key;
}
