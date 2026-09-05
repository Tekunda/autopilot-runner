// Gate ids that have been RENAMED, mapped legacy -> canonical, and the config lookup that
// honours them.
//
// A rename cannot be made retroactive on either side of the wire: a tenant's `gateConfig` is
// hand-written and keyed by whatever the gate was called when they wrote it, and an already-issued
// grant carries the old id inside a SIGNED gateSpec that nothing may rewrite. Dropping the old
// name would therefore silently DISARM a tenant's configuration -- their `blocking:false` or their
// tuned thresholds would simply stop applying, with no error anywhere -- which is a worse failure
// than the misleading name the rename fixes.
//
// WHY HERE, in src/gates/ rather than beside the pack registry that first needed it: there are now
// TWO config-resolution sites, and they are on opposite sides of a hard import boundary. The
// server-side PackRegistry resolves a tenant's top-level `gateConfig`, and the runner's heavy
// stage resolves the SAME shape again per site (`SiteConfig.gateConfig`, serve-and-gate.ts) --
// and src/runner/** may not import src/packs/** at all (runner/no-packs-import.test.ts). A second
// copy of the map is exactly the drift this map exists to prevent: the alias would keep working
// on one side and silently stop on the other. This module is commodity (a rename table, no pack
// logic and no prompt), which is the home that test names for shared code.
//
// An entry may be removed only once no unexpired grant and no tenant config can still name it --
// and only together with its executable half in the pack bundle's gate list.
export const GATE_ID_ALIASES: Readonly<Record<string, string>> = {
  // `cover-title` only ever checked frontmatter FIELD LENGTHS; the cover-image check it was named
  // for now exists separately as `cover-image`.
  'cover-title': 'meta-lengths',
};

/**
 * The gateConfig entry that applies to `id`, honouring renames. Canonical wins when a tenant has
 * both -- they configured the current name deliberately -- and a legacy key still applies when it
 * is all they have.
 *
 * Deliberately one-directional: a legacy key resolves onto the canonical id, never the reverse. A
 * grant still naming the OLD id gets no config a tenant wrote under the new one, because the two
 * ids may by then mean different gates (the split that produced this very alias moved half the old
 * gate's behaviour to `cover-image`). The caller reports that shortfall rather than guessing.
 */
export function gateConfigFor(
  id: string,
  gateConfig: Record<string, Record<string, unknown>> | undefined,
): Record<string, unknown> | undefined {
  if (!gateConfig) return undefined;
  // `!== undefined`, not truthiness. A tenant entry written as `null` is a PRESENT entry, and
  // reading it as absent makes callers that distinguish the two lie: serve-and-gate.ts's
  // unappliedConfigNote would report a key it can see in the config as one this run never
  // executed. Present-but-empty resolves to the empty overlay it describes.
  if (gateConfig[id] !== undefined) return gateConfig[id];
  for (const [legacy, current] of Object.entries(GATE_ID_ALIASES)) {
    if (current === id && gateConfig[legacy] !== undefined) return gateConfig[legacy];
  }
  return undefined;
}

/** The canonical id a (possibly legacy) gate id names. Unknown ids are already canonical. */
export function canonicalGateId(id: string): string {
  return GATE_ID_ALIASES[id] ?? id;
}
