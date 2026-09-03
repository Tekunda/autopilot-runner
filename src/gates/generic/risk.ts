// `risk` gate: pipeline-risk heuristics. Flags diffs that touch
// CI/workflow-sensitive paths, or that are large enough to warrant closer
// review before the pipeline auto-merges them. Pure over
// GateContext.changedFiles + config. See issue #77.

import { readGateConfig } from './config.ts';
import { classifyDiffRisk, type RiskGateConfig } from './risk-level.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

// Declared beside the classifier that consumes it (see risk-level.ts) and re-exported here, which
// is where every importer has always found it.
export type { RiskGateConfig };

export const DEFAULT_CONFIG: RiskGateConfig = {
  highRiskPathPrefixes: ['.github/workflows/', '.github/actions/'],
  maxChangedFiles: 40,
  largeChangeExemptPattern:
    '(-snapshots/|(^|/)(package-lock\\.json|pnpm-lock\\.yaml|yarn\\.lock)$|\\.(png|jpe?g|gif|webp|avif|ico|svg|woff2?|ttf|otf|eot|mp4|webm|mov|pdf|snap|lock)$)',
};

// `maxChangedFiles` rides a tenant-editable packConfig into the signed gate spec, so it is
// untrusted input. Two junk failure modes: 0/-1 fails every non-empty diff, while NaN or a
// non-numeric value coerces the threshold comparison to always-false and the gate silently
// passes EVERYTHING. Anything that isn't a positive integer falls back to the default
// rather than throwing -- a throwing gate would wedge the runner's fix loop on a tenant
// config typo.
function normalizeMaxChangedFiles(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_CONFIG.maxChangedFiles;
}

// Same untrusted provenance as maxChangedFiles: a non-array prefixes value throws in
// .find() and a non-compiling exempt pattern throws in new RegExp() -- and a thrown gate
// is recorded as a fail check that never clears, wedging the fix loop. Wrong-shape values
// fall back to the default instead. An empty array also falls back: it would silently
// disarm the high-risk-path check entirely. ponytail: the clamp is silent -- surface
// config-validation errors to tenants when there's a reporting channel for them.
function normalizeHighRiskPathPrefixes(value: unknown): string[] {
  return Array.isArray(value) && value.length > 0 && value.every((p) => typeof p === 'string' && p.length > 0)
    ? value
    : DEFAULT_CONFIG.highRiskPathPrefixes;
}

function normalizeLargeChangeExemptPattern(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_CONFIG.largeChangeExemptPattern;
  try {
    new RegExp(value);
    return value;
  } catch {
    return DEFAULT_CONFIG.largeChangeExemptPattern;
  }
}

// The effective config the runner will apply for this gate: defaults overlaid by the
// per-gate signed spec config (`spec.config` for id 'risk'), exactly what run-gate-stage
// does when it overlays spec.config over GateTarget.config before readGateConfig merges
// over the defaults. Server-side consumers (the architect's size guidance, the
// decomposition size check) resolve the threshold through this so they can never drift
// from what the gate actually enforces. ponytail: the runner ALSO lets an unsigned
// GateTarget.config under the signed spec.config, but today's only adapter sends no
// target config -- if one ever does, thread it through here too.
export function effectiveRiskConfig(specConfig?: Record<string, unknown>): RiskGateConfig {
  const config = readGateConfig(specConfig === undefined ? {} : { risk: specConfig }, 'risk', DEFAULT_CONFIG);
  return {
    ...config,
    maxChangedFiles: normalizeMaxChangedFiles(config.maxChangedFiles),
    highRiskPathPrefixes: normalizeHighRiskPathPrefixes(config.highRiskPathPrefixes),
    largeChangeExemptPattern: normalizeLargeChangeExemptPattern(config.largeChangeExemptPattern),
  };
}

export function createRiskGate(): Gate {
  return {
    id: 'risk',
    async run(ctx: GateContext): Promise<GateResult> {
      // The runner hands the tenant's spec config in as ctx.config.risk; resolve through
      // effectiveRiskConfig so the gate applies exactly what the server-side consumers see,
      // and so a bad tenant shape falls back to defaults instead of throwing this gate.
      const config = effectiveRiskConfig(ctx.config.risk as Record<string, unknown> | undefined);
      // ONE heuristic, two consumers: this gate's verdict and the review-lens selector both read
      // classifyDiffRisk, so they can never disagree about the same diff. `high` is exactly the
      // level the classifier assigns for the two conditions this gate has always failed on --
      // a high-risk path prefix or an over-threshold review-relevant file count -- and at that
      // level its reasons ARE this gate's findings, verbatim.
      const assessment = classifyDiffRisk(ctx.changedFiles, config);
      const findings = assessment.level === 'high' ? assessment.reasons : [];

      return {
        id: 'risk',
        status: findings.length > 0 ? 'fail' : 'pass',
        ...(findings.length ? { findings } : {}),
      };
    },
  };
}
