// Registers Autopilot's always-on generic gates (owned by Autopilot, not
// licensed) into a GateRegistry. Packs plug in licensed gates the same way
// later (issue #78) — this only wires up the five generic ones. See #77.

import type { GateRegistry } from '../registry.ts';
import type { Gate } from '../types.ts';
import { createAssertionDeltaGate } from './assertion-delta.ts';
import { createCveGate } from './cve.ts';
import { createRiskGate } from './risk.ts';
import { createStructureGate } from './structure.ts';
import { createTestPolicyGate } from './test-policy.ts';

// The generic gate set itself, as data. The runner registers it into its own
// GateRegistry (registerGenericGates below); the control plane feeds the same
// list into its PackRegistry so `issueGateGrant` actually signs a
// `{kind:'generic'}` spec for each one. Both sides must be built from this one
// list -- a control plane whose PackRegistry has no generic gates issues an
// empty `gateSpecs`, and the runner then correctly executes nothing.
export function genericGates(): Gate[] {
  return [
    createStructureGate(),
    createCveGate(),
    createRiskGate(),
    createTestPolicyGate(),
    createAssertionDeltaGate(),
  ];
}

export function registerGenericGates(registry: GateRegistry): void {
  for (const gate of genericGates()) {
    registry.register(gate);
  }
}

export * from './assertion-delta.ts';
export * from './assertion-delta-detect.ts';
export * from './cve.ts';
export * from './risk.ts';
export * from './test-integrity-detect.ts';
export * from './structure.ts';
export * from './test-policy.ts';
