// `structure` gate: repo/code-structure sanity. Flags changed files that
// land under paths that should never be hand-edited in a PR (build output,
// VCS internals, secrets) and diffs that touch an implausibly large number
// of files for a single change. Pure over GateContext.changedFiles + config,
// so it's fully deterministic and needs no external tooling. See issue #77.

import { readGateConfig } from './config.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

export interface StructureGateConfig {
  forbiddenPathPrefixes: string[];
  maxChangedFiles: number;
}

const DEFAULT_CONFIG: StructureGateConfig = {
  forbiddenPathPrefixes: ['dist/', 'build/', 'node_modules/', '.git/', '.env'],
  maxChangedFiles: 100,
};

export function createStructureGate(): Gate {
  return {
    id: 'structure',
    async run(ctx: GateContext): Promise<GateResult> {
      const config = readGateConfig(ctx.config, 'structure', DEFAULT_CONFIG);
      const findings: string[] = [];

      for (const file of ctx.changedFiles) {
        const hit = config.forbiddenPathPrefixes.find((prefix) => file.startsWith(prefix));
        if (hit) findings.push(`"${file}" is under forbidden path "${hit}"`);
      }

      if (ctx.changedFiles.length > config.maxChangedFiles) {
        findings.push(
          `diff touches ${ctx.changedFiles.length} files, exceeding the max of ${config.maxChangedFiles}`,
        );
      }

      return {
        id: 'structure',
        status: findings.length > 0 ? 'fail' : 'pass',
        ...(findings.length ? { findings } : {}),
      };
    },
  };
}
