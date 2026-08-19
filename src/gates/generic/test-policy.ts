// `test-policy` gate: tests-present policy. A changed, non-exempt source
// file must have a matching test file changed in the same diff — "matching"
// means the same path with a test marker (".test."/".spec.") inserted
// before the extension. Pure over GateContext.changedFiles + config. See
// issue #77.

import { readGateConfig } from './config.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

export interface TestPolicyGateConfig {
  sourceDirs: string[];
  sourceExtensions: string[];
  testMarkers: string[];
  exemptSuffixes: string[];
}

const DEFAULT_CONFIG: TestPolicyGateConfig = {
  sourceDirs: ['src/'],
  sourceExtensions: ['.ts'],
  testMarkers: ['.test.', '.spec.'],
  exemptSuffixes: ['.d.ts', '/index.ts', '/types.ts'],
};

function isTestFile(file: string, testMarkers: string[]): boolean {
  return testMarkers.some((marker) => file.includes(marker));
}

function isExempt(file: string, exemptSuffixes: string[]): boolean {
  return exemptSuffixes.some((suffix) => file.endsWith(suffix));
}

// For `src/foo/bar.ts` with marker '.test.' -> `src/foo/bar.test.ts`.
function companionsFor(file: string, extensions: string[], markers: string[]): string[] {
  const ext = extensions.find((candidate) => file.endsWith(candidate));
  if (!ext) return [];
  const base = file.slice(0, -ext.length);
  return markers.map((marker) => `${base}${marker.slice(0, -1)}${ext}`);
}

export function createTestPolicyGate(): Gate {
  return {
    id: 'test-policy',
    async run(ctx: GateContext): Promise<GateResult> {
      const config = readGateConfig(ctx.config, 'test-policy', DEFAULT_CONFIG);
      const changed = new Set(ctx.changedFiles);
      const findings: string[] = [];

      for (const file of ctx.changedFiles) {
        if (isTestFile(file, config.testMarkers)) continue;
        if (!config.sourceDirs.some((dir) => file.startsWith(dir))) continue;
        if (!config.sourceExtensions.some((ext) => file.endsWith(ext))) continue;
        if (isExempt(file, config.exemptSuffixes)) continue;

        const companions = companionsFor(file, config.sourceExtensions, config.testMarkers);
        if (companions.length > 0 && !companions.some((c) => changed.has(c))) {
          findings.push(
            `"${file}" changed without a matching test file (expected one of: ${companions.join(', ')})`,
          );
        }
      }

      return {
        id: 'test-policy',
        status: findings.length > 0 ? 'fail' : 'pass',
        ...(findings.length ? { findings } : {}),
      };
    },
  };
}
