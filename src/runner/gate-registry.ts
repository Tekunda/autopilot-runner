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
import { designReviewGate, DESIGN_REVIEW_GATE_ID } from '../gates/visual/design-review.ts';
import { AGGRESSIVE_DESIGN_PROFILE, CONSERVATIVE_PROFILE, type VisionRubricProfile } from '../gates/visual/judge.ts';
import { createVisionGate, type VisionGateDeps } from '../gates/visual/vision-gate.ts';
import { visualQaGate, VISUAL_QA_GATE_ID } from '../gates/visual/visual-qa.ts';

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
  [visualQaGate, designReviewGate, e2eGate, layoutRulesGate].map((gate) => [gate.id, gate] as const),
);

// The rubric profile each vision-judge heavy gate is built from -- the source of truth
// registerHeavyGatesForSpecs uses to REBUILD one with injected test deps (browser/judge) while
// still resolving the id through HEAVY_GATE_CATALOG. Absent here, a gate is registered as-is.
const VISION_GATE_PROFILES: ReadonlyMap<string, VisionRubricProfile> = new Map([
  [VISUAL_QA_GATE_ID, CONSERVATIVE_PROFILE],
  [DESIGN_REVIEW_GATE_ID, AGGRESSIVE_DESIGN_PROFILE],
]);

// `visionDeps` is a TEST seam: production passes none and the catalog's default gates build a real
// Playwright browser + Anthropic judge lazily. A test passes a fake browser/judge so it can exercise
// the REAL registration path (an id must still be in HEAVY_GATE_CATALOG to register at all -- remove
// it and the signed spec resolves to no gate and the stage fails closed) without a live browser or
// API key. Only the vision-judge gates (VISION_GATE_PROFILES) are rebuildable this way.
export function registerHeavyGatesForSpecs(
  registry: GateRegistry,
  ids: Iterable<string>,
  visionDeps?: VisionGateDeps,
): void {
  for (const id of ids) {
    const catalogGate = HEAVY_GATE_CATALOG.get(id);
    if (!catalogGate || registry.get(id)) continue;
    const profile = VISION_GATE_PROFILES.get(id);
    const gate = visionDeps && profile ? createVisionGate({ id, profile, deps: visionDeps }) : catalogGate;
    registry.register(gate);
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
