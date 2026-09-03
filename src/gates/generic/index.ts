// Registers Autopilot's always-on generic gates (owned by Autopilot, not
// licensed) into a GateRegistry. Packs plug in licensed gates the same way
// later (issue #78). See #77.
//
// THE SALESFORCE GATES RIDE HERE TOO, and the reason is worth stating where someone will trip
// over it: gate selection happens control-plane side (packs/registry.ts enabledGateSpecs),
// which cannot see the customer's checkout, so nothing server-side can know a repo is
// Salesforce. Those gates are therefore always signed and decide at RUN time, from
// ctx.stackProfiles, whether they apply -- returning a benign `skip`/`no-config` on every
// non-Salesforce repo. gates/salesforce/index.ts carries the full argument, including the
// entitlement-gated Pack alternative that was evaluated and rejected (it would have required
// hand configuration, which is precisely the bar this had to clear).

import type { GateRegistry } from '../registry.ts';
import { salesforceGates } from '../salesforce/index.ts';
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
    ...salesforceGates(),
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
