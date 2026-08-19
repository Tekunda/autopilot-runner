// Gates register here by id; packs add their gates in via `register`, and
// config (and later entitlement) decide which registered ids actually run
// per repo/PR — see AGENTS.md milestone 6, entitlement is not wired up yet.

import { runGates } from './run-gates.ts';
import type { Gate, GateContext, GateReport, GateResult } from './types.ts';

export class GateRegistry {
  private readonly gates = new Map<string, Gate>();

  register(gate: Gate): void {
    if (this.gates.has(gate.id)) {
      throw new Error(`gate registry: duplicate gate id "${gate.id}"`);
    }
    this.gates.set(gate.id, gate);
  }

  get(id: string): Gate | undefined {
    return this.gates.get(id);
  }

  list(): Gate[] {
    return [...this.gates.values()];
  }

  // Runs only the registered gates whose id is in `enabledIds`; every other
  // registered gate is reported as skip without being invoked, so the report
  // always accounts for the full registry.
  async run(enabledIds: string[], ctx: GateContext): Promise<GateReport> {
    const enabled: Gate[] = [];
    const skipped: GateResult[] = [];

    for (const gate of this.list()) {
      if (enabledIds.includes(gate.id)) {
        enabled.push(gate);
      } else {
        skipped.push({ id: gate.id, status: 'skip' });
      }
    }

    const report = await runGates(enabled, ctx);
    return {
      ok: report.ok,
      results: [...report.results, ...skipped],
    };
  }
}
