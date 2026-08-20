// The runner's bundled gate catalog: only the always-on GENERIC gates --
// commodity checks with no licensed IP (npm-audit thresholds, forbidden-path/
// file-count predicates). Registering a gate here grants it no authority to
// run; only a gate id present in the grant's signed `gateSpecs` (as a
// `{kind:'generic'}` entry) actually executes (GateRegistry.run,
// src/gates/registry.ts) -- that set is decided entirely server-side by
// issueGateGrant (src/control-plane/grant.ts) from the tenant's entitlement.
//
// Licensed pack gates are NEVER registered here, and this module imports
// nothing from src/packs (issue #129). Prompt (licensed pack) gates are
// disabled under the current stopgap, so the runner runs no model at all --
// only these deterministic generic gates execute. The runner holds zero
// pack-specific code. See AGENTS.md and docs/architecture.md.

import { registerGenericGates } from '../gates/generic/index.ts';
import { GateRegistry } from '../gates/registry.ts';

export function createRunnerGateRegistry(): GateRegistry {
  const registry = new GateRegistry();
  registerGenericGates(registry);
  return registry;
}
