// `test-policy` gate: tests-present policy. A changed, non-exempt source file must have a
// matching test file changed in the same diff -- "matching" means the same path with a test
// marker (".test."/".spec.") inserted before the extension. Pure over
// GateContext.changedFiles + config, plus one filesystem probe described below. See #77.
//
// THE FAILURE MODE THIS FILE NOW GUARDS AGAINST IS ITS OWN: the defaults below describe a
// single-package TypeScript layout (`src/`, `.ts`). A tenant whose repo has no `src/` -- a
// Next.js monorepo of `apps/`+`packages/`, a repo whose logic is `scripts/*.sh` -- matched
// ZERO files on every PR and the gate reported a green `pass` for a check that could not
// fail. A gate cannot tell the operator it is misconfigured if it reports the same thing
// when it works and when it is pointed at nothing.
//
// So a zero-match is now a first-class outcome, never a pass, and the two causes are graded
// differently because their remedies are different:
//
//   - The configured sourceDirs do not exist in the checkout at all -> `unjudged` +
//     `unjudgedReason: 'content'`. The gate is pointed at a layout this repo does not have
//     and can NEVER match a file, on this PR or any other. `unjudged` maps to a blocking
//     `fail` in run-gate-stage's toCheckStatus AND tags the check so the fix loop escalates
//     it to a human at once instead of burning fix rounds no edit can resolve (fix-loop's
//     isContentUnjudged) -- which is the correct route for a defect that lives in tenant
//     config, not in the diff.
//
//     This was a `skip` in the first cut of this change, on the reasoning that the
//     never-fired ledger would raise it, and that must not be re-attempted. A skip here is
//     STILL not an escalation: `toCheckStatus` maps it to `pending` rather than a failure, so
//     the finding renders nowhere (fix-loop and deploy-watch render findings only for `fail`)
//     and the gate becomes a silent no-op. Converting a false green into a silent no-op is not
//     a fix. The ledger's reach has since grown -- a skip tagged `invalid-config` now alarms
//     (`gate_config_invalidated`) and drops out of the regression set even for a gate with a
//     long verdict history (#3794), where before `lastRealVerdictAt` being sticky forever
//     silenced every signal -- but an operator alarm on a merged promotion is a different thing
//     from blocking the PR that broke it, which is what this defect needs.
//
//   - The dirs exist but this diff touched none of them (a docs-only PR) -> `skip` +
//     `no-matching-files`. Honest for one PR, and the non-benign reason keeps it out of the
//     promotion coverage record.

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { readGateConfig } from './config.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

export interface TestPolicyGateConfig {
  sourceDirs: string[];
  sourceExtensions: string[];
  testMarkers: string[];
  exemptSuffixes: string[];
}

export const DEFAULT_TEST_POLICY_CONFIG: TestPolicyGateConfig = {
  sourceDirs: ['src/'],
  sourceExtensions: ['.ts'],
  testMarkers: ['.test.', '.spec.'],
  exemptSuffixes: ['.d.ts', '/index.ts', '/types.ts'],
};

// Tenant-editable config rides the signed spec, so a wrong-shape value falls back to the
// default rather than throwing the gate (same discipline as risk.ts). An EMPTY array falls
// back too: an empty sourceDirs or sourceExtensions silently disarms the gate completely,
// which is the exact vacuous pass this file exists to make impossible.
function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.length > 0)
    ? (value as string[])
    : fallback;
}

export function effectiveTestPolicyConfig(specConfig?: Record<string, unknown>): TestPolicyGateConfig {
  const config = readGateConfig(
    specConfig === undefined ? {} : { 'test-policy': specConfig },
    'test-policy',
    DEFAULT_TEST_POLICY_CONFIG,
  );
  return {
    sourceDirs: normalizeStringArray(config.sourceDirs, DEFAULT_TEST_POLICY_CONFIG.sourceDirs),
    sourceExtensions: normalizeStringArray(config.sourceExtensions, DEFAULT_TEST_POLICY_CONFIG.sourceExtensions),
    testMarkers: normalizeStringArray(config.testMarkers, DEFAULT_TEST_POLICY_CONFIG.testMarkers),
    // exemptSuffixes is the one list an empty array legitimately means: "exempt nothing".
    exemptSuffixes: Array.isArray(config.exemptSuffixes) && config.exemptSuffixes.every((v) => typeof v === 'string')
      ? (config.exemptSuffixes as string[])
      : DEFAULT_TEST_POLICY_CONFIG.exemptSuffixes,
  };
}

function isTestFile(file: string, testMarkers: string[]): boolean {
  return testMarkers.some((marker) => file.includes(marker));
}

function isExempt(file: string, exemptSuffixes: string[]): boolean {
  return exemptSuffixes.some((suffix) => file.endsWith(suffix));
}

// A directory prefix always ends at a path separator. Without this, `sourceDirs: ['source']`
// matches `sourcemaps/a.ts` -- the gate would then police files in a directory the tenant
// never named, and (worse) report a scope it does not have.
function asDirPrefix(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`;
}

function isInScope(file: string, config: TestPolicyGateConfig): boolean {
  return (
    config.sourceDirs.some((dir) => file.startsWith(asDirPrefix(dir))) &&
    config.sourceExtensions.some((ext) => file.endsWith(ext))
  );
}

// For `src/foo/bar.ts` with marker '.test.' -> `src/foo/bar.test.ts`.
//
// The companion may carry ANY configured source extension, not only the changed file's own:
// a test harness is routinely written in a different language from the thing it tests (a
// shell suite covering a python script, a `.ts` spec covering a `.js` module). With the
// single-extension default this is exactly the old same-extension behaviour; it only widens
// for a tenant that configures more than one extension, and widening can only ever ACCEPT a
// test that exists, never invent a requirement.
function companionsFor(file: string, extensions: string[], markers: string[]): string[] {
  const ext = extensions.find((candidate) => file.endsWith(candidate));
  if (!ext) return [];
  const base = file.slice(0, -ext.length);
  return markers.flatMap((marker) =>
    extensions.map((candidate) => `${base}${marker.slice(0, -1)}${candidate}`),
  );
}

// A source root is a REPO-RELATIVE directory. An absolute path or one that climbs out of the
// checkout is not a misdirected root, it is an invalid one -- and left unclamped it is worse
// than useless: `sourceDirs: ['/tmp/']` stats a directory that exists on every runner, so the
// probe below would report the healthy `no-matching-files` forever and permanently hide the
// misconfiguration it exists to surface.
async function isDirectoryInCheckout(root: string, dir: string): Promise<boolean> {
  const base = path.resolve(root);
  const target = path.resolve(base, dir);
  if (target !== base && !target.startsWith(base + path.sep)) return false;
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export function createTestPolicyGate(): Gate {
  return {
    id: 'test-policy',
    async run(ctx: GateContext): Promise<GateResult> {
      const config = effectiveTestPolicyConfig(ctx.config['test-policy'] as Record<string, unknown> | undefined);
      const changed = new Set(ctx.changedFiles);

      // Exemption is part of scope, not a step inside the loop: a diff of nothing but exempt
      // files (`src/index.ts`, `src/types.ts`) asserts exactly as much as a diff of no source
      // files at all, and reporting "examined 2 in-scope source file(s)" for it is the same
      // examined-nothing-and-said-pass ambiguity in miniature.
      const inScope = ctx.changedFiles.filter(
        (file) =>
          !isTestFile(file, config.testMarkers) &&
          isInScope(file, config) &&
          !isExempt(file, config.exemptSuffixes),
      );

      if (inScope.length === 0) {
        const present: string[] = [];
        for (const dir of config.sourceDirs) {
          if (await isDirectoryInCheckout(ctx.workspaceRoot, dir)) present.push(dir);
        }
        const checkoutReadable = await isDirectoryInCheckout(ctx.workspaceRoot, '.');

        // No configured source root exists in a checkout we CAN read: the gate is pointed at
        // a layout this repo does not have. Blocking and escalated, not skipped -- see header.
        if (present.length === 0 && checkoutReadable) {
          return {
            id: 'test-policy',
            status: 'unjudged',
            unjudgedReason: 'content',
            findings: [
              `test-policy examined 0 of ${ctx.changedFiles.length} changed file(s): none of its configured ` +
                `sourceDirs [${config.sourceDirs.join(', ')}] exist in ${ctx.repoId}, so this gate can never ` +
                `match a file on any PR and has no verdict to give. This is a tenant gate-config defect, not a ` +
                `defect in this diff: point test-policy at this repo's real source roots ` +
                `(packConfig.gateConfig["test-policy"].sourceDirs) and re-run.`,
            ],
          };
        }

        // The roots exist (or the checkout could not be read, so the probe proves nothing and
        // must not accuse the config). The most this run can honestly claim is that today's
        // diff missed them.
        return {
          id: 'test-policy',
          status: 'skip',
          skipReason: 'no-matching-files',
          findings: [
            `test-policy examined 0 of ${ctx.changedFiles.length} changed file(s): none are under ` +
              `[${config.sourceDirs.join(', ')}] with extension [${config.sourceExtensions.join(', ')}] ` +
              `(excluding exempt paths [${config.exemptSuffixes.join(', ') || 'none'}]). ` +
              `Nothing was asserted on this PR.`,
          ],
        };
      }

      const findings: string[] = [];
      for (const file of inScope) {
        const companions = companionsFor(file, config.sourceExtensions, config.testMarkers);
        if (companions.length > 0 && !companions.some((c) => changed.has(c))) {
          findings.push(
            `"${file}" changed without a matching test file (expected one of: ${companions.join(', ')})`,
          );
        }
      }

      if (findings.length > 0) return { id: 'test-policy', status: 'fail', findings };

      // A pass says how much it examined, so "examined 12 files and found no problems" can
      // never be mistaken for the "examined 0 files" outcomes above. Findings on a pass are
      // inert downstream (only failing checks' findings reach PR comments and fix briefs);
      // they land in the runner log and the gate report, which is where an auditor looks.
      return {
        id: 'test-policy',
        status: 'pass',
        findings: [
          `test-policy examined ${inScope.length} in-scope source file(s) of ${ctx.changedFiles.length} changed`,
        ],
      };
    },
  };
}
