// `structure` gate: repo/code-structure sanity. Three checks, all deterministic:
//   1. changed files that land under paths that should never be hand-edited in a PR
//      (build output, VCS internals, secrets);
//   2. a diff that touches an implausibly large number of files for one change;
//   3. FALSE-GREEN TESTS in the changed test files -- a test disabled outright, or one
//      whose skip is conditioned on the absence of the content it exists to assert.
//
// (3) is why this gate is no longer decoration. (1) and (2) alone are a path-prefix match
// and a count: they pass on essentially every real PR, so the gate reported `pass` for a
// check nobody could fail. The false-green ban is the check the shell pipeline this replaced
// actually enforced (its code-structure check), and it is the one
// worth having: a gate that bans vacuous tests while being vacuous itself is the joke
// writing itself. The detection is a pure text scan (./test-integrity-detect.ts); this
// file only decides WHICH changed files to feed it and reads them off the PR checkout.
//
// Because (3) is the only real assertion here, this gate must be able to say it actually
// RAN it. Two outcomes are therefore never a `pass`:
//   - an EMPTY changed-file list. A diff that could not be computed and a diff that is
//     genuinely empty are different facts, and fail-safing the first into a green check is
//     gating on nothing.
//   - test files selected but NONE of them readable, with the diff not explaining it as a
//     deletion. That is a broken checkout, not a clean scan (`action-entry` falls back to
//     `workspaceRoot() === '.'` when GITHUB_WORKSPACE is unset, and a changed-file list
//     derived without `git diff -z` octal-escapes non-ASCII paths that then never resolve),
//     and reporting the same green check for it as for a docs-only PR is exactly the
//     examined-nothing ambiguity this change exists to remove.
// See issue #77.

import { lstat, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { readGateConfig } from './config.ts';
import { isShellTestFile } from './shell-test-scan.ts';
import { detectTestIntegrityViolations, isScannableTestFile } from './test-integrity-detect.ts';
import type { TestIntegrityKind } from './test-integrity-types.ts';
import { deletedFilesSince, resolveBaseSha } from '../git.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

export interface StructureGateConfig {
  forbiddenPathPrefixes: string[];
  maxChangedFiles: number;
  // How a changed file is recognized as a TEST file, for the false-green ban. Cross-framework and
  // not TS-bound: a MARKER or a directory segment, gated by a known source extension so
  // `tests/fixtures/data.json` is not mistaken for a spec. Selection is separate from what the
  // detector can JUDGE (isScannableTestFile) -- a selected file in an unsupported language is
  // reported as such, never counted as scanned.
  //
  // A marker is NOT simply a path substring: see `matchesTestMarker` below for the four shapes and
  // where each one has to appear. Describing it as a substring here is what told a config author
  // that `src/test/` was legal, when for a while it selected nothing at all.
  testFileMarkers: string[];
  testFileDirs: string[];
  testFileExtensions: string[];
  // Tenant escape hatch for the false-green ban: false demotes its findings to a report-only
  // `warn` (the gate still publishes them) instead of failing. Defaults to enforcing, because
  // the check it replaces was a hard gate and a suite that skips itself on missing content is
  // a defect in THIS diff, which the fix loop can actually fix.
  enforceTestIntegrity: boolean;
  // Hard cap on a single test file read, in bytes. The changed-file list is host-supplied and
  // the paths are PR-authored, so an unbounded read is an availability hole, not a nicety.
  maxTestFileBytes: number;
}

// Apex is in the defaults because the judge was taught it first (test-integrity-detect.ts's
// Apex section); widening selection ahead of judgment is what `unjudgeable-language` exists to
// report, and the order is fixed for that reason.
//
// `'Test'` is capital-T deliberately. Apex has no `.test.` infix -- the universal convention is
// a PascalCase `Test` prefix or suffix (`OrderTest.cls`, `TestOrder.cls`, `Order_Test.cls`), and
// `isTestFile` matches markers as SUBSTRINGS, so one marker covers all three spellings. The
// case-sensitivity is the safety: it does not match the lowercase word "test" buried in an
// ordinary identifier, so `LatestOrder.cls` and `ContestEntry.cls` are not selected.
//
// That marker also now selects JS/TS files it did not before -- `src/TestHelper.ts` is the
// shape. That is harmless rather than a regression, because widening SELECTION can only cause a
// file to be READ and JUDGED: the judge reports a violation on a real defect and nothing
// otherwise, so a non-test helper is scanned and cleanly passes. What widening selection cannot
// do is bank a false pass -- a selected file the detector has no patterns for is reported as
// `unjudgeable-language`, never counted as scanned. That is the guarantee that makes this safe.
//
// `.cls-meta.xml` does not match `.cls` (the extension test is `endsWith`), so a metadata
// sidecar is never selected: it carries no code to judge, and selecting it would make every
// metadata-only edit look like a scanned test file. `classes/` is deliberately NOT in
// `testFileDirs` -- Apex tests live beside ordinary classes in the same package directory, so
// that entry would select every class in the repo and inflate the counts this gate reports.
export const DEFAULT_STRUCTURE_CONFIG: StructureGateConfig = {
  // `.venv/` joins the build-output prefixes for a stronger reason than `dist/`: a committed
  // `.venv/bin/python` or `.venv/bin/ruff` is an attempt to SUPPLY THE TOOLCHAIN a Python gate
  // runs. (The gates themselves no longer read a venv from the checkout -- gates/python/
  // toolchain.ts builds one outside it precisely so that shim cannot work -- but a PR that commits
  // one is still a finding worth surfacing.)
  //
  // `__pycache__/` is deliberately NOT here: these are `startsWith` prefixes, and `__pycache__` is
  // always nested (`pkg/__pycache__/x.pyc`), so the entry would match essentially nothing. A rule
  // that cannot fire is decoration, and this file's whole subject is checks that assert nothing.
  forbiddenPathPrefixes: ['dist/', 'build/', 'node_modules/', '.git/', '.env', '.venv/'],
  maxChangedFiles: 100,
  // Apex needs BOTH `Test.` and `Test`, and the pair is not redundant -- each names one of the two
  // spellings the convention allows, through the shape that actually matches it (see
  // matchesTestMarker): `Test.` is the SUFFIX branch and selects `OrderTest.cls` / `Order_Test.cls`,
  // while bare `Test` is the PREFIX branch and selects `TestOrder.cls`. `Test` alone -- which is
  // what arrived from the Salesforce profile, written when markers were plain substrings -- now
  // matches only the prefix spelling, so `OrderTest.cls` would have stopped being selected
  // silently, the way every other regression in this family went. Neither shape matches
  // `Contest.cls`: the prefix arm fails, and the suffix arm is case-sensitive.
  testFileMarkers: ['.test.', '.spec.', '_test.', 'test_', 'Test.', 'Test'],
  testFileDirs: ['tests/', '__tests__/', 'e2e/', 'spec/'],
  // `.py`, `.sh`/`.bash`, `.cls` and `.trigger` are here ONLY because test-integrity-detect.ts can
  // judge those languages (generic/python-test-scan.ts, generic/shell-test-scan.ts and the Apex
  // patterns). The order matters and is not interchangeable: widening selection first would have
  // produced a loud, permanently-skipping `unjudgeable-language` gate, while judging first and
  // selecting second is what actually turns test-integrity enforcement ON for those repos. Without
  // `.py` the false-green ban was silently inert on 100% of a Python tenant's tests -- a real
  // latent bug, not a gap (see the Python tenant runbook), and `.sh` was the same bug for every
  // pipeline repo whose suite is a directory of shell scripts.
  //
  // The two shell entries do NOT behave like the rest of this list: `isTestFile` narrows them to a
  // suite-shaped filename (`SHELL_SUITE_MARKERS`), and their findings are report-only while the
  // shell rules burn in. Both reasons are in shell-test-scan.ts's header.
  testFileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.sh', '.bash', '.cls', '.trigger'],
  enforceTestIntegrity: true,
  maxTestFileBytes: 2_000_000,
};

// Same untrusted provenance as risk.ts's config: these ride a tenant-editable packConfig into
// the signed gate spec. A wrong-shape value falls back to the default rather than throwing --
// a thrown gate is recorded as a failing check that never clears, wedging the fix loop.
function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0)
    ? (value as string[])
    : fallback;
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : fallback;
}

// An empty array is honoured here (unlike risk.ts's prefixes): `forbiddenPathPrefixes: []` is a
// deliberate, already-tested way for a tenant to disarm check (1), and this gate no longer rests
// on that check alone. A NON-ARRAY still falls back.
export function effectiveStructureConfig(specConfig?: Record<string, unknown>): StructureGateConfig {
  const config = readGateConfig(
    specConfig === undefined ? {} : { structure: specConfig },
    'structure',
    DEFAULT_STRUCTURE_CONFIG,
  );
  return {
    forbiddenPathPrefixes: normalizeStringArray(
      config.forbiddenPathPrefixes,
      DEFAULT_STRUCTURE_CONFIG.forbiddenPathPrefixes,
    ),
    maxChangedFiles: normalizePositiveInt(config.maxChangedFiles, DEFAULT_STRUCTURE_CONFIG.maxChangedFiles),
    testFileMarkers: normalizeStringArray(config.testFileMarkers, DEFAULT_STRUCTURE_CONFIG.testFileMarkers),
    testFileDirs: normalizeStringArray(config.testFileDirs, DEFAULT_STRUCTURE_CONFIG.testFileDirs),
    testFileExtensions: normalizeStringArray(
      config.testFileExtensions,
      DEFAULT_STRUCTURE_CONFIG.testFileExtensions,
    ),
    enforceTestIntegrity: config.enforceTestIntegrity !== false,
    maxTestFileBytes: normalizePositiveInt(config.maxTestFileBytes, DEFAULT_STRUCTURE_CONFIG.maxTestFileBytes),
  };
}

// Shell is selected by a SUITE-SHAPED FILENAME only -- never by `testFileDirs`, and never by the
// Apex `Test.`/`Test` markers. Every other language this gate judges has a "does this file define
// tests at all?" precondition inside the judge: `no-assertion` is a property of a test FUNCTION in
// the JS and Python halves, so `tests/conftest.py` and `tests/helpers.ts` are selected, scanned and
// cleanly pass. Shell has no function-level equivalent -- a suite is just a script -- so selection
// is the ONLY place the distinction can be made, and leaving it to `testFileDirs` graded ordinary
// infrastructure as test suites: `tests/setup.sh`, `tests/helpers.bash`, `ci/e2e/up.sh`,
// `spec/seed.sh`. Measured over 32 real non-suite shell scripts relocated under `tests/`, `e2e/`
// and `spec/`: 15 of them (47%) produced a finding while directory membership selected them, and
// 0 of the 96 relocations are selected at all once selection reads the FILENAME.
//
// `_spec.` is here for the same reason `_test.` is, and it is not a hypothetical separator
// permutation: `spec/*_spec.sh` is SHELLSPEC's canonical layout, and ShellSpec is a mainstream
// shell test framework -- the header names `.bats` as the deselection that costs a whole repo its
// coverage, and `_spec.` was sitting in exactly that position while `_test.` beside it was
// selected. A suite is a suite whichever of the four separator/word pairings its author chose.
//
// WHAT THIS LIST STILL GETS WRONG, stated because it is the sort of narrowing an operator would
// never suspect: `test_` is a PREFIX shape (matchesTestMarker), so it selects `test_totals.sh` --
// and equally `test_helper.bash` (the canonical bats helper name), `test_helpers.sh` and
// `test_common.sh`, which are infrastructure and measure `no-assertion`. They are NOT excluded.
// Naming them out would be enumerating instances of an open class, and on a report-only gate a
// printed false positive on a shape the burn-in is explicitly hunting for (shell-test-scan.ts's
// header) is evidence, not damage. The residual DESELECTIONS are stated in that header too.
//
// Deliberately NOT intersected with `config.testFileMarkers`, which is what it used to be. A
// tenant adding `-test.` there got a silent green `0 selected` on every shell suite, because the
// intersection dropped any marker this list does not carry -- a config knob that reads as honoured
// and is not. Shell selection is a fixed suite-shape whitelist; the tenant knob that still governs
// it is `testFileExtensions` (drop `.sh` and no shell file is selected at all).
const SHELL_SUITE_MARKERS: readonly string[] = ['.test.', '.spec.', '_test.', '-test.', '_spec.', 'test_'];

export function isTestFile(file: string, config: StructureGateConfig): boolean {
  if (!config.testFileExtensions.some((ext) => file.endsWith(ext))) return false;
  if (isShellTestFile(file)) {
    return SHELL_SUITE_MARKERS.some((marker) => matchesTestMarker(file, marker));
  }
  return (
    config.testFileMarkers.some((marker) => matchesTestMarker(file, marker)) ||
    config.testFileDirs.some((dir) => file.includes(dir))
  );
}

// Where in a filename a marker has to appear. FOUR shapes, because the marker vocabulary across the
// gates that share this helper genuinely has four, and collapsing any two of them has already
// broken a default THREE times on this branch -- every time with the same signature: files stop
// being SELECTED, so no gate reports `unjudgeable-language` or anything else, and the suite stays
// green. That signature is why the shapes are enumerated here and pinned case-by-case in
// test-file-selection.test.ts's MARKER_CASES rather than per gate.
//
//   PATH-NAMING (`src/test/`, `tests/`, `tests/test_`)  -> plain substring, anywhere in the path,
//       and checked FIRST. `basename` never contains `/`, so every basename arm below is
//       unsatisfiable for such a marker: without this branch `src/test/` selects nothing at all,
//       while `/test/` works only by accident of its leading slash. It matters because
//       `test-policy` has NO `testFileDirs` -- `testMarkers` is its only path-scoping knob -- and
//       because assertion-delta ships `Test.`/`Tests.`/`Spec.` for JVM tenants whose tests live in
//       `src/test/java/`, which appears in no `testFileDirs` default.
//
//   SEPARATOR-LED (`.test.`, `.spec.`, `_test.`)  -> plain substring, anywhere in the path.
//       Unambiguous on its own, and the historical JS/TS behaviour, so it is left exactly alone.
//
//   ALPHANUMERIC-LED, `.`-TERMINATED (`Test.`, `Tests.`, `Spec.`)  -> a SUFFIX before the
//       extension, matched inside the basename. This is the JVM/.NET/Apex convention --
//       `CalculatorTest.java`, `UserServiceTests.cs`, `UserSpec.kt`, `FooTest.cls` -- and it is why
//       assertion-delta's `testFileExtensions` carries `.java`, `.kt`, `.cs`, `.swift`, `.rb`,
//       `.go`, `.php` at all. It is also the shape test-policy's `templatesFromMarkers` already
//       assumes when it turns a `.`-terminated marker into a companion TEMPLATE, so treating it as
//       a prefix here made this file and that one contradict each other: the companion
//       `FooTest.cls` that test-policy DEMANDS was then policed as a source file.
//
//   ALPHANUMERIC-LED, NOT `.`-terminated (`test_`)  -> a filename PREFIX. Python's convention, and
//       the reason this function exists: a plain `includes('test_')` selects
//       `<pkg>/fastest_path.py` (fas-`test_`-path) and `greatest_common.py` as test files.
//       "Alphanumeric" here means ASCII: `/^[A-Za-z0-9]/` does not match `тест_` or `é`, so a
//       non-ASCII marker takes the separator-led branch and gets substring semantics -- which
//       re-creates the `fastest_path.py` misclassification in that alphabet. No tenant names test
//       files this way, but the character class is the whole point of this line, so it is stated.
//
// TWO REGRESSIONS GOT HERE THE SAME WAY, and both were silent -- the files simply stopped being
// SELECTED, so no gate reported `unjudgeable-language` or anything else and a full suite stayed
// green:
//   - `\w` instead of `[A-Za-z0-9]` sent `_test.` down the alphanumeric branch, and `structure`
//     stopped scanning `*_test.ts`/`*_test.js` for a TypeScript tenant entirely. The three-shape
//     rule below happens to absorb that particular marker (`_test.` ends in `.`, so it takes the
//     suffix branch either way), so the guard is pinned by a separator-led marker with NO trailing
//     dot instead -- `['src/foo_spec.rb', '_spec', true]` in test-file-selection.test.ts.
//   - a prefix-only reading of the alphanumeric branch killed `Test.`/`Tests.`/`Spec.`, leaving them
//     matching only a file literally NAMED `Test.java`. `testFileDirs` does not rescue those:
//     Maven and Gradle use `src/test/`, not `tests/`.
//   - routing a `/`-containing marker to a basename arm made it unsatisfiable, so `src/test/`
//     selected nothing. Plain `includes` had handled it before the shape rules existed.
//
// Shared with test-policy.ts and assertion-delta.ts, which select on the same markers -- three
// gates disagreeing about what a test file is would be worse than any one rule alone.
export function matchesTestMarker(file: string, marker: string): boolean {
  // A marker naming a PATH is a path substring, and this line has to come FIRST. `basename` never
  // contains `/`, so both basename arms below are unsatisfiable for such a marker: `src/test/` and
  // `tests/test_` would select NOTHING, silently, while `/test/` matched only because its leading
  // slash sent it down the separator-led branch. Plain `includes` handled all of them before the
  // shape rules existed, so this is a restoration, not a new case.
  if (marker.includes('/')) return file.includes(marker);
  if (!/^[A-Za-z0-9]/.test(marker)) return file.includes(marker);
  const basename = file.slice(file.lastIndexOf('/') + 1);
  // Case-sensitive, deliberately: `Contest.java` does not contain `Test.`, while `LatestTest.java`
  // does and should.
  return marker.endsWith('.') ? basename.includes(marker) : basename.startsWith(marker);
}

type ReadOutcome = { ok: true; source: string } | { ok: false };

// Reads a changed test file off the PR checkout, or reports that it could not. The caller
// must distinguish "not read" from "read and clean" -- returning undefined for both is how
// this gate used to report a green scan of zero files.
//
// The path is PR-authored, so three separate guards apply. Containment: a `../` entry must
// not turn a gate into an arbitrary-file reader. NO SYMLINKS: checking the resolved path
// STRING is not enough, because a symlink committed at `tests/e2e/x.spec.ts` has a perfectly
// contained path and still resolves anywhere -- including a FIFO or /dev/urandom, where
// readFile never returns and hangs the gate on attacker-influenced input. Size cap: same
// availability argument, for an ordinary huge file. lstat also gives the errno that tells a
// deleted spec (ENOENT) from a broken checkout, which the caller needs.
async function readTestFile(workspaceRoot: string, file: string, maxBytes: number): Promise<ReadOutcome> {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, file);
  if (target !== root && !target.startsWith(root + path.sep)) return { ok: false };
  try {
    const link = await lstat(target);
    // A symlink is resolved and re-checked, not refused outright: a spec symlinked WITHIN the
    // checkout is legitimate (shared fixtures, a monorepo alias) and refusing it would block
    // the PR as unreadable. What must never happen is following one OUT -- the path string is
    // contained while the target is anywhere, including a FIFO or /dev/urandom where readFile
    // never returns and the gate hangs on PR-authored input.
    const resolved = link.isSymbolicLink() ? await realpath(target) : target;
    // Containment is checked against the REAL root: a checkout can itself sit under a
    // symlinked path (macOS `/var` -> `/private/var` is the everyday case), and comparing a
    // realpath'd target against a non-realpath'd root refuses every legitimate link.
    const realRoot = link.isSymbolicLink() ? await realpath(root).catch(() => root) : root;
    if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) return { ok: false };
    const stats = link.isSymbolicLink() ? await stat(resolved) : link;
    if (!stats.isFile()) return { ok: false };
    if (stats.size > maxBytes) return { ok: false };
    return { ok: true, source: await readFile(resolved, 'utf8') };
  } catch {
    return { ok: false };
  }
}

// Which of the unreadable test files the DIFF explains: a spec this change deleted is
// expected to be absent from the checkout and is not evidence of anything. Anything else is.
// Returns undefined when git cannot answer, which the caller must treat as "cannot explain"
// rather than "nothing to explain" -- a diff that cannot be computed and one that is empty
// are different facts here too.
async function deletedByThisDiff(ctx: GateContext): Promise<Set<string> | undefined> {
  try {
    const base = await resolveBaseSha(ctx.baseRef, ctx.workspaceRoot);
    return await deletedFilesSince(base, ctx.workspaceRoot);
  } catch {
    return undefined;
  }
}

// The one sentence that describes an incomplete scan, shared by the `fail` and `unjudged`
// paths so the two can never drift into describing the same state differently.
function unscannedFinding(
  ctx: GateContext,
  selected: string[],
  unexplained: string[],
  scanned: number,
  diffStatusReadable: boolean,
): string {
  return (
    `structure selected ${selected.length} test file(s) but could not read ${unexplained.length} of ` +
    `them under "${ctx.workspaceRoot}", and this diff does not record them as deleted` +
    `${diffStatusReadable ? '' : ' (the diff status could not be read either)'}: ` +
    `${unexplained.slice(0, 10).join(', ')}. The false-green-test scan did not run on ` +
    `${scanned === 0 ? 'any' : 'all'} of the files it selected.`
  );
}

// Is this violation report-only -- printed, but never counted as a blocker?
//
// The ONE place that decision is made, so a rule that has to burn in is demoted by adding a clause
// HERE rather than by growing a second bucket beside `integrityFindings` and a second branch on
// every return below.
//
// TWO demotions sit here, keyed on different things because they ARE different things.
//
// Shell is a whole LANGUAGE burning in, and it is deliberately NOT spelled as a kind test even
// though it looks like one. Shell raises `hard-disable`, `empty-content-skip` and `no-assertion`,
// and those three ARE the shared vocabulary (./test-integrity-types.ts): the JS and Python halves
// raise the same kinds and must keep blocking, so keying shell on them would disarm the check for
// every language at once. It burns in because two of its three rules were found redding correct
// code, and the corpus that measured them clean structurally could not contain either shape --
// 100% of its shell suites sat in `scripts/*.test.sh` and it had no `tests/**/*.sh` at all. A new
// judge that has never been validated against the shapes it gets wrong prints first. See
// shell-test-scan.ts's header for what has to be true before that clause is deleted.
//
// `vacuous-guard` is the opposite shape and needs the opposite key. ./vacuous-guard.ts is the only
// thing that raises it, it is report-only in EVERY language it can fire in, and no file test can
// select it: it fires on the same `.ts`/`.mjs`/`.js` files whose `hard-disable` and
// `empty-content-skip` findings must keep blocking. So the kind IS its identity, and the parameter
// list carries both. It burns in because it is a JUDGEMENT about reachability rather than a
// spelling lookup, and it is measured wrong roughly 1 finding in 8 on the corpus that built it,
// and 1 in 5 once the file selection widens to test directories `isTestFile` does not currently
// match. Blocking at that rate reds correct code, which is the failure a burn-in exists to catch
// before a tenant pays for it. PROMOTION IS NOT A DATE: the clause comes out when the printed
// findings on real diffs have held a clean hit list across a burn-in period -- no measured false
// positive over that window -- exactly the evidence the shell clause owes. vacuous-guard.ts's
// header lists the shapes it knowingly gets wrong; a promotion argument has to survive them.
function isReportOnlyViolation(file: string, kind: TestIntegrityKind): boolean {
  return isShellTestFile(file) || kind === 'vacuous-guard';
}

export function createStructureGate(): Gate {
  return {
    id: 'structure',
    async run(ctx: GateContext): Promise<GateResult> {
      const config = effectiveStructureConfig(ctx.config.structure as Record<string, unknown> | undefined);

      // Zero changed files means this gate examined NOTHING. Reporting `pass` there is the
      // vacuous-green failure mode itself: `skip` + a non-benign reason keeps it out of the
      // promotion coverage record (control-plane/gate-verdict-ledger.ts isBenignSkip).
      if (ctx.changedFiles.length === 0) {
        return {
          id: 'structure',
          status: 'skip',
          skipReason: 'no-matching-files',
          findings: ['structure examined 0 files: the changed-file list is empty, so nothing was checked'],
        };
      }

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

      const selected = ctx.changedFiles.filter((file) => isTestFile(file, config));
      const scannable = selected.filter((file) => isScannableTestFile(file));
      const unsupported = selected.filter((file) => !isScannableTestFile(file));
      const unreadable: string[] = [];
      const integrityFindings: string[] = [];
      // Findings from a rule that is still burning in. REPORT-ONLY means PRINTED AND NON-BLOCKING:
      // they never decide the status, and they are carried on every return below so that a
      // co-occurring failure cannot swallow them. A demotion that also dropped the finding would
      // be the silent no-op this whole gate exists to ban -- and the burn-in reads the printed
      // findings, so dropping them is what makes the promotion criteria unmeetable.
      const reportOnlyFindings: string[] = [];
      let scanned = 0;

      for (const file of scannable) {
        const outcome = await readTestFile(ctx.workspaceRoot, file, config.maxTestFileBytes);
        if (!outcome.ok) {
          unreadable.push(file);
          continue;
        }
        scanned += 1;
        for (const violation of detectTestIntegrityViolations(file, outcome.source)) {
          const bucket = isReportOnlyViolation(file, violation.kind) ? reportOnlyFindings : integrityFindings;
          bucket.push(`${violation.file}:${violation.line} [${violation.kind}] ${violation.detail}`);
        }
      }

      // A test file this change DELETED is expected to be missing. Anything else unreadable
      // means the scan did not happen on a file the gate selected, and the gate must not
      // report the result of a scan it did not perform. `unjudged` (not `fail`) because no
      // edit to the diff fixes a broken checkout, and its `infra` reason routes one bounded
      // gate-only retry before escalating to a human -- see fix-loop's isInfraUnjudged.
      let removed = 0;
      let unexplained: string[] = [];
      let diffStatusReadable = true;
      if (unreadable.length > 0) {
        const deleted = await deletedByThisDiff(ctx);
        diffStatusReadable = deleted !== undefined;
        unexplained = deleted ? unreadable.filter((file) => !deleted.has(file)) : unreadable;
        removed = unreadable.length - unexplained.length;
      }

      // Report-only findings are PRINTED on every path and count toward NO status. They ride each
      // return below exactly the way `unscannedFinding` does: a demotion that also DROPPED the
      // finding would be the silent no-op this gate exists to ban, and it is the shape the drop
      // took that made it invisible -- a shell finding survived alone but vanished the moment any
      // blocking finding or any unreadable file appeared in the same diff.
      //
      // They still never move the status into `fail`. That is what `enforceTestIntegrity: false`
      // and the shell burn-in each asked for, and it is why they are appended rather than folded
      // into `blocking`: the fix loop reads a failing check's findings, and a report-only line
      // there is context, not an instruction.
      const demoted = config.enforceTestIntegrity
        ? reportOnlyFindings
        : [...integrityFindings, ...reportOnlyFindings];

      // Blocking findings decide the status, and they OUTRANK the unjudged escalation below.
      // A forbidden path or an oversized diff is a verdict this gate did reach, on a defect the
      // author can fix; routing it to an infra escalation because some OTHER file was
      // unreadable throws away the fixable finding and hands the fix loop nothing. The
      // unreadable specs ride along in the same report so neither fact is lost.
      const blocking = [...findings, ...(config.enforceTestIntegrity ? integrityFindings : [])];
      if (blocking.length > 0) {
        return {
          id: 'structure',
          status: 'fail',
          findings: [
            ...blocking,
            ...(unexplained.length > 0
              ? [unscannedFinding(ctx, selected, unexplained, scanned, diffStatusReadable)]
              : []),
            ...demoted,
          ],
        };
      }

      // Nothing determined failed, but the scan did not run on files it selected. `unjudged`
      // (not `fail`) because no edit to the diff fixes a broken checkout, and its `infra`
      // reason routes one bounded gate-only retry before escalating to a human -- see
      // fix-loop's isInfraUnjudged.
      if (unexplained.length > 0) {
        return {
          id: 'structure',
          status: 'unjudged',
          unjudgedReason: 'infra',
          findings: [unscannedFinding(ctx, selected, unexplained, scanned, diffStatusReadable), ...demoted],
        };
      }

      if (demoted.length > 0) {
        return { id: 'structure', status: 'warn', findings: demoted };
      }

      // Every test file this diff touched is in a language the detector has no patterns for,
      // so the gate's only real assertion did not run at all. A tenant who configures
      // `testFileExtensions: ['.rb']` would otherwise get a permanent green from a check that
      // cannot fire -- this file's own defect, reintroduced through config.
      //
      // `unjudgeable-language`, NOT `invalid-config`: this branch is decided by the DIFF
      // (`selected`/`scannable` are both derived from ctx.changedFiles), so a polyglot tenant
      // configured `['.ts', '.rb']` lands here on a .rb-only PR and judges the very next .ts PR
      // normally, with nothing edited. `invalid-config` promises the control plane a permanent,
      // config-determined fault (gates/types.ts), and claiming it here made the ledger tell an
      // operator that a working gate had "stopped enforcing" on every unjudgeable promotion. Still
      // non-benign, so #358's intent is intact: excluded from coverage, and a gate that NEVER
      // gets a judgeable file still raises gate_never_fired.
      if (selected.length > 0 && scannable.length === 0) {
        return {
          id: 'structure',
          status: 'skip',
          skipReason: 'unjudgeable-language',
          findings: [
            `structure selected ${selected.length} test file(s) (${unsupported.slice(0, 5).join(', ')}) but the ` +
              `false-green-test check has no patterns for that language, so it asserted nothing. Point ` +
              `structure.testFileExtensions at the languages it can judge, or expect no test-integrity ` +
              `coverage on this repo.`,
          ],
        };
      }

      // Say what was actually examined, in numbers that cannot be conflated. "12 files, 3 test
      // files selected, 3 scanned" and "12 files, 0 test files selected" and "2 selected, 0
      // scanned" are three different facts; rendering them as one green check is what let two
      // gates report `pass` for years while asserting nothing. The scanner covers a fixed list of
      // SHAPES, so the count says which shapes were looked for: "scanned for false-green tests"
      // read as a clean bill of health on the whole file, which is the same over-claim one level
      // up from the one this gate exists to remove.
      return {
        id: 'structure',
        status: 'pass',
        findings: [
          `structure examined ${ctx.changedFiles.length} changed file(s); ${selected.length} test file(s) ` +
            `selected, ${scanned} scanned for the false-green shapes this check covers` +
            (removed > 0 ? `, ${removed} removed by this diff` : '') +
            (unsupported.length > 0
              ? `, ${unsupported.length} in a language this check cannot judge (${unsupported.slice(0, 5).join(', ')})`
              : ''),
        ],
      };
    },
  };
}
