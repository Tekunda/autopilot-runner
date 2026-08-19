// `rollup-guard` gate: verifies every child of a rollup is complete, and
// that they completed in their declared order — a later child finishing
// while an earlier one hasn't is a stacked-PR ordering violation, not just
// an incomplete rollup. The children (with their declared order) come in
// via config, since GateContext carries no TicketState. See issue #77.

import { readGateConfig } from './config.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';
import type { TicketStatus } from '../../contracts/types.ts';

export interface RollupChild {
  id: string;
  status: TicketStatus;
  prMerged: boolean;
}

export interface RollupGuardConfig {
  // Declared/required completion order for the rollup's children.
  children: RollupChild[];
}

const DEFAULT_CONFIG: RollupGuardConfig = { children: [] };

function isComplete(child: RollupChild): boolean {
  return child.status === 'done' && child.prMerged;
}

export function createRollupGuardGate(): Gate {
  return {
    id: 'rollup-guard',
    async run(ctx: GateContext): Promise<GateResult> {
      const config = readGateConfig(ctx.config, 'rollup-guard', DEFAULT_CONFIG);
      const children = config.children;
      const firstIncompleteIndex = children.findIndex((child) => !isComplete(child));

      if (firstIncompleteIndex === -1) {
        return { id: 'rollup-guard', status: 'pass' };
      }

      const findings: string[] = [];
      const firstIncomplete = children[firstIncompleteIndex];

      for (const child of children.slice(firstIncompleteIndex)) {
        if (!isComplete(child)) {
          findings.push(`child "${child.id}" is not complete (status=${child.status}, prMerged=${child.prMerged})`);
        }
      }

      for (const later of children.slice(firstIncompleteIndex + 1)) {
        if (isComplete(later)) {
          findings.push(
            `child "${later.id}" completed out of order — "${firstIncomplete.id}" (declared earlier) is not yet complete`,
          );
        }
      }

      return { id: 'rollup-guard', status: 'fail', findings };
    },
  };
}
