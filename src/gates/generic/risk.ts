// `risk` gate: pipeline-risk heuristics. Flags diffs that touch
// CI/workflow-sensitive paths, or that are large enough to warrant closer
// review before the pipeline auto-merges them. Pure over
// GateContext.changedFiles + config. See issue #77.

import { readGateConfig } from './config.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

export interface RiskGateConfig {
  highRiskPathPrefixes: string[];
  maxChangedFiles: number;
  // Generated / binary artifacts (image + font assets, e2e visual snapshots) do NOT count
  // toward the large-diff heuristic: a snapshot regeneration or an asset drop legitimately
  // touches hundreds of files but is not the large, risky SOURCE change the threshold exists
  // to flag -- and no fix can shrink it, so counting it just wedges the fix loop. A file
  // matching this pattern is still checked against highRiskPathPrefixes; it's only excluded
  // from the count.
  largeChangeExemptPattern: string;
}

export const DEFAULT_CONFIG: RiskGateConfig = {
  highRiskPathPrefixes: ['.github/workflows/', '.github/actions/'],
  maxChangedFiles: 40,
  largeChangeExemptPattern:
    '(-snapshots/|(^|/)(package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock)$|\\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf|eot|mp4|webm|mov|pdf|snap|lock)$)',
};

// The effective config the runner will apply for this gate: defaults overlaid by the
// per-gate signed spec config (`spec.config` for id 'risk'), exactly what run-gate-stage
// does when it overlays spec.config over GateTarget.config before readGateConfig merges
// over the defaults. Server-side consumers (the architect's size guidance, the
// decomposition size check) resolve the threshold through this so they can never drift
// from what the gate actually enforces. ponytail: the runner ALSO lets an unsigned
// GateTarget.config under the signed spec.config, but today's only adapter sends no
// target config -- if one ever does, thread it through here too.
export function effectiveRiskConfig(specConfig?: Record<string, unknown>): RiskGateConfig {
  return readGateConfig(specConfig === undefined ? {} : { risk: specConfig }, 'risk', DEFAULT_CONFIG);
}

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

      // Count only review-relevant files toward the large-diff heuristic -- a mass
      // snapshot/asset change is not the risky source change this threshold guards against.
      const exempt = new RegExp(config.largeChangeExemptPattern, 'i');
      const countable = ctx.changedFiles.filter((file) => !exempt.test(file));
      if (countable.length > config.maxChangedFiles) {
        findings.push(
          `diff touches ${countable.length} review-relevant files (excluding generated/binary assets), ` +
            `exceeding the risk threshold of ${config.maxChangedFiles}`,
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
