// `risk` gate: pipeline-risk heuristics. Flags diffs that touch
// CI/workflow-sensitive paths, or that are large enough to warrant closer
// review before the pipeline auto-merges them. Pure over
// GateContext.changedFiles + config. See issue #77.

import { readGateConfig } from './config.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

export interface RiskGateConfig {
  highRiskPathPrefixes: string[];
  maxChangedFiles: number;
}

const DEFAULT_CONFIG: RiskGateConfig = {
  highRiskPathPrefixes: ['.github/workflows/', '.github/actions/'],
  maxChangedFiles: 40,
};

export function createRiskGate(): Gate {
  return {
    id: 'risk',
    async run(ctx: GateContext): Promise<GateResult> {
      const config = readGateConfig(ctx.config, 'risk', DEFAULT_CONFIG);
      const findings: string[] = [];

      for (const file of ctx.changedFiles) {
        const hit = config.highRiskPathPrefixes.find((prefix) => file.startsWith(prefix));
        if (hit) findings.push(`"${file}" touches high-risk path "${hit}"`);
      }

      if (ctx.changedFiles.length > config.maxChangedFiles) {
        findings.push(
          `diff touches ${ctx.changedFiles.length} files, exceeding the risk threshold of ${config.maxChangedFiles}`,
        );
      }

      return {
        id: 'risk',
        status: findings.length > 0 ? 'fail' : 'pass',
        ...(findings.length ? { findings } : {}),
      };
    },
  };
}
