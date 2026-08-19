// Registers Autopilot's always-on generic gates (owned by Autopilot, not
// licensed) into a GateRegistry. Packs plug in licensed gates the same way
// later (issue #78) — this only wires up the five generic ones. See #77.

import type { GateRegistry } from '../registry.ts';
import { createCveGate } from './cve.ts';
import { createRiskGate } from './risk.ts';
import { createRollupGuardGate } from './rollup-guard.ts';
import { createStructureGate } from './structure.ts';
import { createTestPolicyGate } from './test-policy.ts';

export function registerGenericGates(registry: GateRegistry): void {
  registry.register(createStructureGate());
  registry.register(createCveGate());
  registry.register(createRiskGate());
  registry.register(createTestPolicyGate());
  registry.register(createRollupGuardGate());
}

export * from './cve.ts';
export * from './risk.ts';
export * from './rollup-guard.ts';
export * from './structure.ts';
export * from './test-policy.ts';
