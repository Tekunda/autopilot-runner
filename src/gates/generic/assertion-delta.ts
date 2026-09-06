// `assertion-delta` gate: test-integrity surface for the false-green post-mortem's F6 failure --
// a build stage that rewrites its OWN tests to certify its deletions (lowered a MIN_CHARS
// bound 200->60, flipped a `toHaveCount(9)` to `toHaveCount(0)`, deleted an assertion block).
// It fetches the unified diff of just the test files this change touched and runs the pure
// detector (./assertion-delta-detect.ts) over it.
//
// Deliberately WARN by default, not fail: a blanket block would wedge every legitimate test
// rewrite and push authors back into self-certifying their own deletions (the very thing F6
// condemns). The published warn makes the delta visible and routes the judgment call to the
// independent adversarial reviewer (control-plane review-round); a tenant that wants it
// blocking opts in with `enforce: true`. Any git/diff failure is a `skip`, never a throw --
// a thrown gate is recorded as a fail check that never clears and wedges the fix loop.

import {
  carriesAssertionVocabulary,
  DEFAULT_ASSERTION_DELTA_CONFIG,
  detectWeakenings,
  normalizeAssertionDeltaConfig,
  splitUnifiedDiffByFile,
  type AssertionDeltaConfig,
} from './assertion-delta-detect.ts';
import { readGateConfig } from './config.ts';
import { matchesTestMarker } from './structure.ts';
import { resolveBaseSha, unifiedDiffForFiles } from '../git.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

export interface AssertionDeltaGateConfig extends AssertionDeltaConfig {
  // How a changed file is recognized as a TEST file (cross-framework, not Playwright/TS-bound):
  // a MARKER or a directory segment, gated by a known source extension so a
  // `tests/fixtures/data.json` is not mistaken for a spec.
  //
  // A marker is NOT simply a path substring -- `structure.ts`'s `matchesTestMarker`, which this
  // gate shares, gives it four shapes depending on where it has to appear. The defaults below rely
  // on two of them: `Test.`/`Tests.`/`Spec.` are SUFFIX markers for the JVM/.NET convention (which
  // is why `testFileExtensions` carries `.java`, `.kt`, `.cs`, `.swift`, `.rb`, `.go`, `.php`),
  // while `test_` is a filename PREFIX.
  testFileMarkers: string[];
  testFileDirs: string[];
  testFileExtensions: string[];
  // Tenant opt-in: true turns a detected weakening into a blocking `fail`; default warn.
  enforce: boolean;
}

export const DEFAULT_ASSERTION_DELTA_GATE_CONFIG: AssertionDeltaGateConfig = {
  ...DEFAULT_ASSERTION_DELTA_CONFIG,
  testFileMarkers: ['.test.', '.spec.', '.e2e.', '_test.', 'test_', 'Test.', 'Tests.', 'Spec.'],
  testFileDirs: ['tests/', '__tests__/', 'e2e/', 'spec/'],
  testFileExtensions: [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.py',
    '.go',
    '.java',
    '.kt',
    '.rb',
    '.rs',
    '.cs',
    '.swift',
    '.php',
    // Shell. A test harness written in shell is still a test suite, and leaving these out is not
    // a narrower scope but a SILENT one: a change made entirely of `*.test.sh` files matched no
    // extension, so the gate whose subject is a weakened assertion reported
    // `skip(no-matching-files)` over a diff that was nothing but tests.
    //
    // Selecting them is only half the job, and the dangerous half on its own. A shell suite
    // asserts through helpers it defines itself, not through a framework, so NONE of the
    // cross-framework `assertionKeywords` reaches it -- measured over the 48 `*.test.sh` suites
    // in the reference shell corpus, 47 carry not one of them. Selecting `.sh` without a judge
    // for it would have turned an honest `skip(no-matching-files)` into a `pass` over a diff that
    // deleted assertions, which is a worse outcome than the miss it was fixing. The vocabulary
    // that reads them is `shellAssertionKeywords` (assertion-delta-detect.ts), scoped to these
    // two extensions; their `#` comments are masked by the same file's `commentSyntaxFor`.
    '.sh',
    '.bash',
  ],
  enforce: false,
};

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.length > 0)
    ? (value as string[])
    : fallback;
}

// Defaults overlaid by the per-gate signed spec config, with every field normalized so a bad
// tenant shape falls back rather than throwing this gate (same discipline as risk.ts).
export function effectiveAssertionDeltaConfig(specConfig?: Record<string, unknown>): AssertionDeltaGateConfig {
  const c = readGateConfig(
    specConfig === undefined ? {} : { 'assertion-delta': specConfig },
    'assertion-delta',
    DEFAULT_ASSERTION_DELTA_GATE_CONFIG,
  );
  const detector = normalizeAssertionDeltaConfig(c);
  return {
    ...detector,
    testFileMarkers: normalizeStringArray(c.testFileMarkers, DEFAULT_ASSERTION_DELTA_GATE_CONFIG.testFileMarkers),
    testFileDirs: normalizeStringArray(c.testFileDirs, DEFAULT_ASSERTION_DELTA_GATE_CONFIG.testFileDirs),
    testFileExtensions: normalizeStringArray(c.testFileExtensions, DEFAULT_ASSERTION_DELTA_GATE_CONFIG.testFileExtensions),
    enforce: c.enforce === true,
  };
}

// `matchesTestMarker` is imported from structure.ts rather than re-spelled here, and that is the
// whole point: THREE gates select test files off the same marker list (`structure`, `test-policy`,
// this one), and structure.ts's own note says two gates disagreeing about what a test file is would
// be worse than either rule alone. Until this change only two of the three agreed -- this one still
// substring-matched, so with `.py` in the extension list `<pkg>/fastest_path.py`
// (fas-`test_`-path) and `greatest_common.py` were classified as TEST files and their assertion
// counts policed as if they were suites.
export function isAssertionDeltaTestFile(file: string, config: AssertionDeltaGateConfig): boolean {
  if (!config.testFileExtensions.some((ext) => file.endsWith(ext))) return false;
  return (
    config.testFileMarkers.some((marker) => matchesTestMarker(file, marker)) ||
    config.testFileDirs.some((dir) => file.includes(dir))
  );
}

export function createAssertionDeltaGate(): Gate {
  return {
    id: 'assertion-delta',
    async run(ctx: GateContext): Promise<GateResult> {
      const config = effectiveAssertionDeltaConfig(ctx.config['assertion-delta'] as Record<string, unknown> | undefined);
      const testFiles = ctx.changedFiles.filter((file) => isAssertionDeltaTestFile(file, config));
      // No test file in the diff means this gate READ NOTHING, which is not the same as "no
      // assertion was weakened". It used to return `pass` here, so every PR that touched no test
      // banked a green assertion-delta check and the coverage record counted a gate that had
      // judged zero lines.
      if (testFiles.length === 0) {
        return {
          id: 'assertion-delta',
          status: 'skip',
          skipReason: 'no-matching-files',
          findings: ['no changed file matched this gate\'s test-file patterns, so no assertion delta was judged'],
        };
      }

      try {
        const base = await resolveBaseSha(ctx.baseRef, ctx.workspaceRoot);
        const rawDiff = await unifiedDiffForFiles(base, testFiles, ctx.workspaceRoot);
        const diffsByFile = splitUnifiedDiffByFile(rawDiff);
        const weakenings = detectWeakenings(diffsByFile, config);
        if (weakenings.length === 0) {
          // Nothing found is two different facts, and `pass` used to serve both. If not one
          // changed line carried a word this detector knows, the diff was not judged CLEAN -- it
          // was not judged at all, and a green check would bank coverage for a gate that read
          // nothing. Asked AFTER detectWeakenings, never instead of it: the numeric-bound step
          // uses no vocabulary, so a diff can carry a real finding and no keyword.
          if (!carriesAssertionVocabulary(diffsByFile, config)) {
            return {
              id: 'assertion-delta',
              status: 'skip',
              skipReason: 'unjudgeable-language',
              findings: [
                'the changed test files carried no assertion, skip or test-declaration keyword this gate knows, so no assertion delta was judged',
              ],
            };
          }
          return { id: 'assertion-delta', status: 'pass' };
        }

        const findings = weakenings.map(
          (w) => `${w.file}${w.line !== undefined ? `:${w.line}` : ''} [${w.kind}] ${w.detail}`,
        );
        return {
          id: 'assertion-delta',
          status: config.enforce ? 'fail' : 'warn',
          findings,
        };
      } catch (err) {
        return {
          id: 'assertion-delta',
          status: 'skip',
          // The gate HAD files to judge and could not read them -- a transient tooling fault, not
          // "nothing to do". Reasoned so the ledger classifies it suspicious instead of letting an
          // unlabelled skip default into silence.
          skipReason: 'infra',
          findings: [`assertion-delta could not read the diff: ${err instanceof Error ? err.message : String(err)}`],
        };
      }
    },
  };
}
