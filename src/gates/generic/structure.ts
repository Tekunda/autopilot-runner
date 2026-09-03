// `structure` gate: repo/code-structure sanity. Three checks, all deterministic:
//   1. changed files that land under paths that should never be hand-edited in a PR
//      (build output, VCS internals, secrets);
//   2. a diff that touches an implausibly large number of files for one change;
//   3. FALSE-GREEN TESTS in the changed test files -- a test disabled outright, or one
//      whose skip is conditioned on the absence of the content it exists to assert.
//
// (3) is why this gate is no longer decoration. (1) and (2) alone are a path-prefix match
// and a count: they pass on essentially every real PR, so the gate reported `pass` for a
// check nobody could fail. The false-green ban is the check the pipeline this replaced
// actually enforced (Tekunda/Website scripts/code-structure-check.sh), and it is the one
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
import { detectTestIntegrityViolations, isScannableTestFile } from './test-integrity-detect.ts';
import { deletedFilesSince, resolveBaseSha } from '../git.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

export interface StructureGateConfig {
  forbiddenPathPrefixes: string[];
  maxChangedFiles: number;
  // How a changed file is recognized as a TEST file, for the false-green ban. Cross-framework
  // and not TS-bound: a path substring marker OR a directory segment, gated by a known source
  // extension so `tests/fixtures/data.json` is not mistaken for a spec. Selection is separate
  // from what the detector can JUDGE (isScannableTestFile) -- a selected file in an
  // unsupported language is reported as such, never counted as scanned.
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

export const DEFAULT_STRUCTURE_CONFIG: StructureGateConfig = {
  forbiddenPathPrefixes: ['dist/', 'build/', 'node_modules/', '.git/', '.env'],
  maxChangedFiles: 100,
  testFileMarkers: ['.test.', '.spec.', '_test.', 'test_'],
  testFileDirs: ['tests/', '__tests__/', 'e2e/', 'spec/'],
  testFileExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'],
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

export function isTestFile(file: string, config: StructureGateConfig): boolean {
  if (!config.testFileExtensions.some((ext) => file.endsWith(ext))) return false;
  return (
    config.testFileMarkers.some((marker) => file.includes(marker)) ||
    config.testFileDirs.some((dir) => file.includes(dir))
  );
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
      let scanned = 0;

      for (const file of scannable) {
        const outcome = await readTestFile(ctx.workspaceRoot, file, config.maxTestFileBytes);
        if (!outcome.ok) {
          unreadable.push(file);
          continue;
        }
        scanned += 1;
        for (const violation of detectTestIntegrityViolations(file, outcome.source)) {
          integrityFindings.push(`${violation.file}:${violation.line} [${violation.kind}] ${violation.detail}`);
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

      // Blocking findings decide the status, and they OUTRANK the unjudged escalation below.
      // A forbidden path or an oversized diff is a verdict this gate did reach, on a defect the
      // author can fix; routing it to an infra escalation because some OTHER file was
      // unreadable throws away the fixable finding and hands the fix loop nothing. The
      // unreadable specs ride along in the same report so neither fact is lost.
      //
      // A tenant that demoted the integrity check keeps its findings on the `warn` path ONLY:
      // folding them into a `fail` would put report-only findings into the fix brief and count
      // them toward the revertable-policy cap, which is the opposite of what
      // `enforceTestIntegrity: false` asked for.
      const blocking = [...findings, ...(config.enforceTestIntegrity ? integrityFindings : [])];
      if (blocking.length > 0) {
        return {
          id: 'structure',
          status: 'fail',
          findings: unexplained.length > 0 ? [...blocking, unscannedFinding(ctx, selected, unexplained, scanned, diffStatusReadable)] : blocking,
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
          findings: [unscannedFinding(ctx, selected, unexplained, scanned, diffStatusReadable)],
        };
      }

      if (integrityFindings.length > 0) {
        return { id: 'structure', status: 'warn', findings: integrityFindings };
      }

      // Every test file this diff touched is in a language the detector has no patterns for,
      // so the gate's only real assertion did not run at all. A tenant who configures
      // `testFileExtensions: ['.sh']` would otherwise get a permanent green from a check that
      // cannot fire -- this file's own defect, reintroduced through config.
      //
      // `unjudgeable-language`, NOT `invalid-config`: this branch is decided by the DIFF
      // (`selected`/`scannable` are both derived from ctx.changedFiles), so a polyglot tenant
      // configured `['.ts', '.sh']` lands here on a .sh-only PR and judges the very next .ts PR
      // normally, with nothing edited. `invalid-config` promises the control plane a permanent,
      // config-determined fault (gates/types.ts), and claiming it here made the ledger tell an
      // operator that a working gate had "stopped enforcing" on every .sh-only promotion. Still
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
      // gates report `pass` for years while asserting nothing.
      return {
        id: 'structure',
        status: 'pass',
        findings: [
          `structure examined ${ctx.changedFiles.length} changed file(s); ${selected.length} test file(s) ` +
            `selected, ${scanned} scanned for false-green tests` +
            (removed > 0 ? `, ${removed} removed by this diff` : '') +
            (unsupported.length > 0
              ? `, ${unsupported.length} in a language this check cannot judge (${unsupported.slice(0, 5).join(', ')})`
              : ''),
        ],
      };
    },
  };
}
