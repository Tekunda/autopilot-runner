// The runner's BUNDLED gate catalog -- and, as of the packaging fix, the whole of it.
//
// This module used to `import` the deterministic pack gates statically. That single fact made
// licensed gate logic a dependency of runner-dist/, which is mirrored verbatim into the PUBLIC
// repo Tekunda/autopilot-runner on every release, and so pointed the packaging step at source
// that must not be published. Those imports are gone and must not come back:
// src/runner/no-packs-import.test.ts and src/packaging/build-runner-dist.test.ts both fail CI on
// ANY src/packs import from the runner or its distribution.
//
// What still lives here:
//   - the always-on GENERIC gates -- commodity checks with no licensed IP (npm-audit
//     thresholds, forbidden-path/file-count predicates) -- registered unconditionally by
//     createRunnerGateRegistry.
//   - the HEAVY gates (visual-qa, e2e, layout-rules), which need a running server and a
//     headless browser and are therefore registered only by the dedicated heavy stage
//     (./serve-and-gate.ts), never on the fast path.
//
// What no longer lives here: the deterministic PACK gates. They arrive at run time, fetched
// from a private release and checksum-verified against the signed grant (./pack-bundle.ts),
// and are registered through registerGatesForSpecs by ./run-gate-stage.ts.
//
// Registering a gate here grants it no authority to run: a gate id only executes when it is
// present in the grant's signed `gateSpecs` (GateRegistry.run, src/gates/registry.ts), a set
// decided entirely server-side by issueGateGrant (src/control-plane/grant.ts) from the
// tenant's entitlement. See AGENTS.md and docs/architecture.md.

import { e2eGate } from '../gates/e2e/e2e-gate.ts';
import { registerGenericGates } from '../gates/generic/index.ts';
import { layoutRulesGate } from '../gates/layout/layout-gate.ts';
import { GateRegistry } from '../gates/registry.ts';
import type { Gate } from '../gates/types.ts';
import { visualQaGate } from '../gates/visual/visual-qa.ts';

export function createRunnerGateRegistry(): GateRegistry {
  const registry = new GateRegistry();
  registerGenericGates(registry);
  return registry;
}

// Registers each gate in `gates` whose id is named by `ids`, so a grant carrying a pack-gate
// spec (e.g. `seo-site-crawl`) has an executable Gate to run once the bundle has supplied it.
// Ids that name no gate in `gates` are ignored, and a gate already registered (a duplicate id
// in the spec list, or a second heavy-stage pass over the same registry) is not registered
// twice. Returns the ids it actually registered, so the caller can tell "the bundle supplied
// this" from "nothing did" and fail closed on the latter.
export function registerGatesForSpecs(registry: GateRegistry, gates: Iterable<Gate>, ids: Iterable<string>): string[] {
  const wanted = new Set(ids);
  const registered: string[] = [];
  for (const gate of gates) {
    if (!wanted.has(gate.id) || registry.get(gate.id)) continue;
    registry.register(gate);
    registered.push(gate.id);
  }
  return registered;
}

// The HEAVY gates, kept OFF the fast deterministic gate path: they need a running server and a
// headless browser, provisioned only by the dedicated heavy stage (src/runner/serve-and-gate.ts).
// registerHeavyGatesForSpecs runs there, never in the fast runGateStage path, so a Visual-QA spec
// can only ever execute inside the browser/server-capable stage.
const HEAVY_GATE_CATALOG: ReadonlyMap<string, Gate> = new Map(
  [visualQaGate, e2eGate, layoutRulesGate].map((gate) => [gate.id, gate] as const),
);

export function registerHeavyGatesForSpecs(registry: GateRegistry, ids: Iterable<string>): void {
  for (const id of ids) {
    const gate = HEAVY_GATE_CATALOG.get(id);
    if (gate && !registry.get(id)) registry.register(gate);
  }
}

// Every gate id the runner can execute FROM ITS OWN BUNDLE: the always-on generic gates plus
// the heavy catalog. The deterministic pack gates are deliberately absent -- they are not in
// the runner any more -- and the catalog-completeness invariant
// (gate-catalog-completeness.test.ts) therefore checks the union of this set and the pack
// BUNDLE's gate ids, so a pack gate added server-side with no home in either still fails CI
// rather than shipping as a silent green.
export function runnerExecutableGateIds(): Set<string> {
  const ids = new Set<string>(createRunnerGateRegistry().list().map((gate) => gate.id));
  for (const id of HEAVY_GATE_CATALOG.keys()) ids.add(id);
  return ids;
}
