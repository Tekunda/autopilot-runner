// Runs a set of gates against a GateContext and aggregates the report.

import type { Gate, GateContext, GateReport, GateResult } from './types.ts';

// Runs every gate and collects ALL results — unlike a fail-fast check
// cluster, one gate failing does not stop the rest from running, so callers
// see every finding in a single report. A gate that throws is recorded as a
// failure rather than aborting the whole run.
export async function runGates(gates: Gate[], ctx: GateContext): Promise<GateReport> {
  const results: GateResult[] = await Promise.all(
    gates.map(async (gate): Promise<GateResult> => {
      try {
        return await gate.run(ctx);
      } catch (err) {
        return {
          id: gate.id,
          status: 'fail',
          findings: [err instanceof Error ? err.message : String(err)],
        };
      }
    }),
  );

  return {
    ok: results.every((result) => result.status !== 'fail'),
    results,
  };
}
