// Pure detector for the `assertion-delta` gate: given the unified diff of the test files a
// build changed, find where the diff WEAKENED its own tests -- deleted/loosened assertions,
// removed or skipped tests, or lowered a numeric bound (a count/length/threshold dropped, most
// damningly to zero). This is the deterministic core behind the false-green post-mortem's F6, where
// the build stage rewrote its own Playwright specs to certify its deletions (ADDON_MIN_CHARS
// 200->60, added `toHaveCount(0)` for the sections it deleted, deleted the `steps.toHaveCount(9)`
// block).
//
// No I/O and no framework knowledge lives here: every keyword/marker is config, defaulted to a
// cross-framework set (JS/TS, Python, Go, Java, ...). The gate (./assertion-delta.ts) fetches
// the diff and feeds it in; this module only reasons over strings, so it is exhaustively unit
// testable and can never throw on a bad tenant config shape (normalizeAssertionDeltaConfig).

export type WeakeningKind =
  | 'assertion-removed'
  | 'test-removed'
  | 'test-skipped'
  | 'bound-lowered'
  | 'count-zeroed';

export interface Weakening {
  file: string;
  line?: number;
  kind: WeakeningKind;
  before?: string;
  after?: string;
  detail: string;
}

// The keyword/marker vocabulary the detector matches against, all cross-framework and all
// tenant-overridable. Deliberately substring matches (not anchored): `expect(` catches
// `await expect(x)` and `.toBe` catches `.toBeGreaterThan`, across languages, without a
// per-framework parser.
export interface AssertionDeltaConfig {
  // Removed lines carrying one of these are assertions; a removed assertion with no surviving
  // `+` counterpart is a weakening.
  assertionKeywords: string[];
  // Added lines carrying one of these skip/narrow a test (or the whole suite).
  skipMarkers: string[];
  // Removed lines carrying one of these declared a test; removing one with no `+` counterpart
  // is a weakening.
  testDeclarationKeywords: string[];
}

export const DEFAULT_ASSERTION_DELTA_CONFIG: AssertionDeltaConfig = {
  assertionKeywords: [
    'expect(',
    'assert',
    '.should',
    'toBe',
    'toEqual',
    'toHaveCount',
    'toHaveLength',
    'toContain',
    'toMatch',
    'toThrow',
    'assertEquals',
    'assertThat',
    'XCTAssert',
    'require.',
    't.Error',
    't.Fatal',
    'System.assert',
    'Assert.',
  ],
  skipMarkers: [
    '.skip',
    '.only',
    'xit',
    'xdescribe',
    'it.skip',
    'test.skip',
    'describe.skip',
    'fdescribe',
    'fit(',
    'pending(',
    '@Disabled',
    '@Ignore',
    '@pytest.mark.skip',
    // The rest of Python's disable vocabulary, kept in step with generic/python-test-scan.ts's
    // PYTHON_HARD_DISABLE_PATTERNS. `@pytest.mark.skip` alone was this file's (and the repo's)
    // only Python awareness; the three below are the spellings `.skip` does NOT already
    // substring-match, so a PR that swaps a skip for an xfail or an expectedFailure no longer
    // reads as an unchanged skip count.
    '@pytest.mark.xfail',
    '@unittest.expectedFailure',
    'unittest.SkipTest',
    't.Skip(',
    // Apex has no skip annotation/call; a test reading org data via SeeAllData=true instead of
    // its own fixture asserts about state nobody committed -- the nearest analogue to a skip.
    'SeeAllData=true',
  ],
  testDeclarationKeywords: [
    'it(',
    'test(',
    'describe(',
    'def test_',
    'func Test',
    '@Test',
    '@IsTest',
    '@isTest',
    'testMethod',
  ],
};

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.length > 0)
    ? (value as string[])
    : fallback;
}

// Same untrusted provenance as risk.ts's config: the keyword arrays ride a tenant-editable
// packConfig into the signed spec, so a non-array or empty value falls back to the default
// rather than throwing (a thrown gate is recorded as a fail check that never clears).
export function normalizeAssertionDeltaConfig(raw: unknown): AssertionDeltaConfig {
  const c = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof AssertionDeltaConfig, unknown>>;
  return {
    assertionKeywords: normalizeStringArray(c.assertionKeywords, DEFAULT_ASSERTION_DELTA_CONFIG.assertionKeywords),
    skipMarkers: normalizeStringArray(c.skipMarkers, DEFAULT_ASSERTION_DELTA_CONFIG.skipMarkers),
    testDeclarationKeywords: normalizeStringArray(
      c.testDeclarationKeywords,
      DEFAULT_ASSERTION_DELTA_CONFIG.testDeclarationKeywords,
    ),
  };
}

interface DiffLine {
  content: string;
  line: number;
}

// The changed lines of a single file's unified diff, split into removals and additions with
// their line numbers (old-file line for removals, new-file line for additions). Header lines
// (`diff --git`, `index`, `---`, `+++`, `@@`) drive the line counters but are not content.
function parseChangedLines(diff: string): { dels: DiffLine[]; adds: DiffLine[] } {
  const dels: DiffLine[] = [];
  const adds: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    // File headers look like +/-  lines but are not content; skip before the +/- checks.
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff --git') || raw.startsWith('index ')) {
      continue;
    }
    if (raw.startsWith('+')) {
      adds.push({ content: raw.slice(1), line: newLine });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      dels.push({ content: raw.slice(1), line: oldLine });
      oldLine += 1;
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" -- metadata, not a line.
    } else {
      // Context line (leading space) or a stray blank: advances both sides.
      oldLine += 1;
      newLine += 1;
    }
  }
  return { dels, adds };
}

// A numeric-normalized, skip-marker-stripped, whitespace-collapsed skeleton of a line: two
// lines share a skeleton when they are the "same" statement differing only in their numeric
// literals (and in whether a skip marker was added). This is what pairs a `-`/`+` bound change
// (`toHaveCount(9)` <-> `toHaveCount(0)`) and what tells a genuinely REMOVED assertion (no `+`
// with a matching skeleton) apart from one that merely moved or had its number changed.
function skeleton(content: string, skipMarkers: string[]): string {
  let s = content;
  for (const marker of skipMarkers) s = s.split(marker).join('');
  return s.replace(/\s+/g, ' ').trim().replace(/\d+(?:\.\d+)?/g, '#');
}

function numbersIn(content: string): number[] {
  return (content.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

function containsAny(content: string, needles: string[]): string | undefined {
  return needles.find((n) => content.includes(n));
}

// Detect every way the diffs WEAKEN their own tests. Order of reasoning per file:
//   1. Added skip/only markers -> test-skipped (a test the suite no longer really runs).
//   2. Pair removed and added lines by skeleton; an aligned numeric literal that DECREASED is
//      a bound-lowered (or count-zeroed when it hit 0). Pairing also CONSUMES the removed line,
//      so a bound change is never also reported as a removal.
//   3. Of the removed lines still unpaired: a test declaration -> test-removed, else an
//      assertion -> assertion-removed.
export function detectWeakenings(diffsByFile: Map<string, string>, config: AssertionDeltaConfig): Weakening[] {
  const cfg = normalizeAssertionDeltaConfig(config);
  const weakenings: Weakening[] = [];

  for (const [file, diff] of diffsByFile) {
    const { dels, adds } = parseChangedLines(diff);

    // 1. Added skip/only markers.
    for (const add of adds) {
      const marker = containsAny(add.content, cfg.skipMarkers);
      if (marker) {
        weakenings.push({
          file,
          line: add.line,
          kind: 'test-skipped',
          after: add.content.trim(),
          detail: `test skipped/narrowed via "${marker}": "${add.content.trim()}"`,
        });
      }
    }

    // 2. Pair by skeleton and flag numeric decreases. Each add is consumed once.
    const addSkeletons = adds.map((add) => skeleton(add.content, cfg.skipMarkers));
    const addUsed = new Array<boolean>(adds.length).fill(false);
    const delPaired = new Array<boolean>(dels.length).fill(false);

    dels.forEach((del, di) => {
      const delSkel = skeleton(del.content, cfg.skipMarkers);
      const ai = addSkeletons.findIndex((s, i) => !addUsed[i] && s === delSkel);
      if (ai === -1) return;
      addUsed[ai] = true;
      delPaired[di] = true;

      const before = numbersIn(del.content);
      const after = numbersIn(adds[ai]!.content);
      let decreasedTo0 = false;
      let decreased = false;
      for (let i = 0; i < before.length && i < after.length; i += 1) {
        if (after[i]! < before[i]!) {
          decreased = true;
          if (after[i] === 0) decreasedTo0 = true;
        }
      }
      if (!decreased) return;
      weakenings.push({
        file,
        line: adds[ai]!.line,
        kind: decreasedTo0 ? 'count-zeroed' : 'bound-lowered',
        before: del.content.trim(),
        after: adds[ai]!.content.trim(),
        detail: `${decreasedTo0 ? 'assertion count zeroed' : 'assertion bound lowered'}: "${del.content.trim()}" -> "${adds[ai]!.content.trim()}"`,
      });
    });

    // 3. Removed lines with no surviving counterpart.
    dels.forEach((del, di) => {
      if (delPaired[di]) return;
      if (containsAny(del.content, cfg.testDeclarationKeywords)) {
        weakenings.push({
          file,
          line: del.line,
          kind: 'test-removed',
          before: del.content.trim(),
          detail: `test removed: "${del.content.trim()}"`,
        });
        return;
      }
      if (containsAny(del.content, cfg.assertionKeywords)) {
        weakenings.push({
          file,
          line: del.line,
          kind: 'assertion-removed',
          before: del.content.trim(),
          detail: `assertion removed: "${del.content.trim()}"`,
        });
      }
    });
  }

  return weakenings;
}

// Splits a multi-file `git diff` into per-file unified diffs keyed by the new-side (b/) path,
// the shape detectWeakenings consumes. A rename with no content change yields no `@@` hunk, so
// it contributes no changed lines and no weakening -- exactly the clean-rename pass case.
export function splitUnifiedDiffByFile(diff: string): Map<string, string> {
  const byFile = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (current) byFile.set(current, buf.join('\n'));
  };
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      flush();
      current = header[2]!;
      buf = [line];
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return byFile;
}
