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

import { maskCommentsAndStrings, type CommentSyntax } from './test-integrity-detect.ts';

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
// tenant-overridable. Each entry is compiled by `needlePattern` into a match that must BEGIN an
// identifier, so a needle is a PREFIX of a real token rather than a bare substring: `expect(`
// still catches `await expect(x)` and `.toBe` still catches `.toBeGreaterThan` across languages
// without a per-framework parser, while `xit(` no longer matches inside `exit`, `exits` or any
// other identifier that happens to contain it.
export interface AssertionDeltaConfig {
  // Removed lines carrying one of these are assertions; a removed assertion with no surviving
  // `+` counterpart is a weakening.
  assertionKeywords: string[];
  // The same, but applied ONLY to a file whose extension says shell (`SHELL_EXTENSIONS`). A shell
  // suite has no framework to borrow a vocabulary from -- it defines two or three helpers at the
  // top of the file and asserts through those -- so none of the cross-framework words above
  // reaches it. Kept separate rather than merged into `assertionKeywords` because these words are
  // ordinary English: `ok`, `eq` and `bad` begin real identifiers in every other language
  // (`equals`, `okResponse`, `badRequest`), and a language-agnostic list carrying them would
  // report an `assertion-removed` on any JS/TS/Python line that merely deleted one.
  shellAssertionKeywords: string[];
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
  // Measured, not guessed: across the 48 `*.test.sh` suites in the reference shell corpus,
  // `ok` and `bad` appear in 39 files each, `fail` in 36 and `eq` in 15, and the four together
  // reach all 48. Every other candidate was dropped for cause -- `assert_` is already a prefix of
  // `assert` above, `check` reaches 13 files that the four already cover, and `die` (a shell
  // idiom one might reasonably expect) does not occur once.
  //
  // That 48-of-48 is REACH, not precision, and the two read very differently: counted by LINE
  // rather than by file, one non-blank masked line in five carries one of these words (829 of
  // 4,567 measured), and plenty of them assert nothing -- the `ok()` / `bad()` helper DEFINITIONS
  // at the top of every suite, `pass=0; fail=0`, `run_case "..." fail` where `fail` is a fixture
  // ARGUMENT, and (these being prefixes like every other needle) `failure`, `failed`, `failing`.
  // Deleting any of them reports an `assertion-removed`. That is a deliberate trade for a `warn`
  // gate whose alternative was reading shell suites with no vocabulary at all, but a tenant
  // turning on `enforce` is turning it on over this hit rate, not over the file coverage above.
  shellAssertionKeywords: ['ok', 'bad', 'eq', 'fail'],
  skipMarkers: [
    '.skip',
    '.only',
    // Spelled WITH the paren, like `fit(` and `pending(` below and for the same reason: a bare
    // word is a word anywhere. `xit`/`xtest`/`xdescribe`/`fdescribe` are only disables at a call
    // site, and the anchor that proves it is the CALL (`needlePattern` reads a trailing `(` as
    // "this word, then a paren, a `.each`, or the end of the line").
    //
    // The disable surface Jest and Vitest actually expose, and where each lands:
    //   `.skip` covers `it.skip`/`describe.skip`/`test.skip`, their `.each` and `.concurrent`
    //   spellings, and Vitest's `.skipIf`; `.only` covers the focus forms; `.todo(` covers the
    //   todo forms of both; the `x`/`f` aliases are the four spelled below. Deliberately OUT of
    //   scope: `it.failing` (Jest) and `it.fails` (Vitest) -- those RUN the test and RUN its
    //   assertions, inverting only the verdict, so they are not a disable in the sense this list
    //   names, and both spell a word common enough off a call site to cost more than they catch.
    'xit(',
    'xtest(',
    'xdescribe(',
    'it.skip',
    'test.skip',
    'describe.skip',
    '.todo(',
    'fdescribe(',
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
    shellAssertionKeywords: normalizeStringArray(
      c.shellAssertionKeywords,
      DEFAULT_ASSERTION_DELTA_CONFIG.shellAssertionKeywords,
    ),
    skipMarkers: normalizeStringArray(c.skipMarkers, DEFAULT_ASSERTION_DELTA_CONFIG.skipMarkers),
    testDeclarationKeywords: normalizeStringArray(
      c.testDeclarationKeywords,
      DEFAULT_ASSERTION_DELTA_CONFIG.testDeclarationKeywords,
    ),
  };
}

interface DiffLine {
  // The line exactly as the diff carries it, minus the +/- marker. Everything REPORTED and every
  // skeleton comes from here, so a finding quotes the author's line and not the mask.
  content: string;
  // The same line with comments and string bodies blanked (./test-integrity-detect.ts's
  // `maskCommentsAndStrings`). This, and only this, is what the keyword needles are matched
  // against and what numeric bounds are compared from: a `-` line of prose describing a skip, a
  // needle quoted as DATA inside a string, and a comment whose "retry up to 30 times" became
  // "retry up to 5 times" are none of them a weakened assertion. Matching raw lines reported a
  // comment about a process EXITING as a disabled test, and a renumbered comment as a lowered
  // bound.
  masked: string;
  line: number;
}

// One side of a hunk as the FILE reads it: that side's context and changed lines, in order. The
// mask has to see them together -- a block comment or template literal opened on a context line
// runs through the changed lines beneath it, and a line-at-a-time mask cannot know that. A
// context line carries no `line`, so it is masked WITH the others and reported as neither a
// removal nor an addition.
interface HunkSideLine {
  text: string;
  line?: number;
}

// The changed lines of a single file's unified diff, split into removals and additions with
// their line numbers (old-file line for removals, new-file line for additions). Header lines
// (`diff --git`, `index`, `---`, `+++`, `@@`) drive the line counters but are not content.
function parseChangedLines(diff: string, syntax: CommentSyntax): { dels: DiffLine[]; adds: DiffLine[] } {
  const dels: DiffLine[] = [];
  const adds: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  let oldSide: HunkSideLine[] = [];
  let newSide: HunkSideLine[] = [];
  // Masking is per SIDE and per HUNK: per side because the two versions of the file are two
  // different texts, and per hunk because comment and string state does not carry across one --
  // git elided the lines between. Every character maps to one character and every newline
  // survives, so the mask splits into exactly as many lines as went in.
  const flushSide = (side: HunkSideLine[], out: DiffLine[]): void => {
    if (side.length === 0) return;
    const masked = maskCommentsAndStrings(side.map((l) => l.text).join('\n'), syntax).split('\n');
    side.forEach((l, i) => {
      if (l.line !== undefined) out.push({ content: l.text, masked: masked[i]!, line: l.line });
    });
  };
  const flushHunk = (): void => {
    flushSide(oldSide, dels);
    flushSide(newSide, adds);
    oldSide = [];
    newSide = [];
  };
  for (const raw of diff.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (header) {
      flushHunk();
      inHunk = true;
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      continue;
    }
    // File headers look like +/- lines but are not content; skip before the +/- checks. Only
    // BEFORE the first hunk, though: every one of these spellings is preamble, and testing for
    // them inside a hunk silently dropped a removed SQL/Lua `-- comment`, whose diff line reads
    // `--- comment`.
    if (
      !inHunk &&
      (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff --git') || raw.startsWith('index '))
    ) {
      continue;
    }
    if (raw.startsWith('+')) {
      newSide.push({ text: raw.slice(1), line: newLine });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      oldSide.push({ text: raw.slice(1), line: oldLine });
      oldLine += 1;
    } else if (raw.startsWith('\\')) {
      // "\ No newline at end of file" -- metadata, not a line.
    } else {
      // Context line (leading space) or a stray blank: advances both sides, and belongs to BOTH
      // sides' mask because it is real text of both versions of the file.
      const text = raw.startsWith(' ') ? raw.slice(1) : raw;
      oldSide.push({ text });
      newSide.push({ text });
      oldLine += 1;
      newLine += 1;
    }
  }
  flushHunk();
  return { dels, adds };
}

// Which comment spelling a file uses, so the mask blanks the right prose. A shell test's
// `# assert the fixture exists` and a Python test's `# skip the slow path` are comments, and
// matching a needle in either is the same false positive as matching one in a JS comment.
const HASH_COMMENT_EXTENSIONS: readonly string[] = ['.py', '.sh', '.bash', '.rb'];

// Known limit, which can only COST a finding and never invent one: a Python triple-quoted
// docstring is read as three ordinary quotes, so its body is scanned as code.
function commentSyntaxFor(file: string): CommentSyntax {
  return HASH_COMMENT_EXTENSIONS.some((ext) => file.endsWith(ext)) ? 'hash' : 'c-style';
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

// A needle names the START of a token, not any substring of a line. `includes` matched `xit`
// inside the word `exit` and inside `exitCode`, which is how a comment about a process exiting
// and an ordinary identifier were both reported as disabled tests.
//
// Two rules, applied to EVERY needle so a tenant-supplied one is anchored exactly as a default
// one is:
//   - a needle that STARTS with an identifier character must start a token: the character before
//     it may not be one (`exit`, `exits`, `exitCode`, `reassert(` are out; `await assert(` and a
//     line-leading `xit(` are in). A `.` is deliberately NOT in the lookbehind: `obj.assertThat(`
//     is a real assertion and has to keep matching.
//   - a needle that ENDS in `(` reads that paren as "used AS a call", which has three spellings
//     and needs all three. `xit (` is the same call with a space. A call whose argument list was
//     long enough to wrap leaves the name ALONE on its line, with the paren on the next -- this
//     detector reads one line at a time, so end-of-line has to count. And `xit.each([1, 2])('x',
//     fn)` is the same disable applied to a table, as are `it.each`, `test.each` and
//     `describe.each` for the declaration keywords. Hence `needle\s*(?:\(|\.<modifier>\b|$)`.
//
//     `<modifier>` is a CLOSED list, not `\.` -- an unrestricted dot reads any member access off
//     a variable that merely shares a needle's name as a call, and `pending.length`,
//     `pending.id`, `pending.set(...)` have no true-positive form (Jasmine's `pending` is only
//     ever a call). Measured on this repo's own sources, `\.` matches 37 such lines that `\(`
//     does not, and over the last 120 commits of `main` it turns 7 ordinary `pending.<member>`
//     lines into `test-skipped` findings -- one of them an `assert.equal(...)` reported as a
//     disabled test. The list admits the modifiers that still leave a RUNNING test declared,
//     which is the only reason a chained form has to match at all: `.each` and `.for` (table
//     expansion) and `.concurrent`, `.sequential` and `.shuffle` (scheduling), across Jest and
//     Vitest. Deliberately out: `.skip`, `.only`, `.todo`, `.skipIf` and `.runIf` decide WHETHER
//     a test runs and are already owned by `skipMarkers` above, so admitting them here would
//     report a removed-and-already-disabled test as a `test-removed` beside its own
//     `test-skipped`; `.failing`/`.fails` invert a verdict without disabling anything (same
//     reason they are out of `skipMarkers`); and `.extend` builds a derived test API rather than
//     declaring a test, while `expect.extend({...})` -- a custom-matcher registration, not an
//     assertion -- would start reading as one. The `\b` is load-bearing on the shortest member:
//     without it `.for` matches `it.formats[...]` and `.each` would match `.eachSeries`.
// There is deliberately NO trailing boundary on the other needles: matching a PREFIX is
// load-bearing across frameworks -- `toBe` has to catch `toBeGreaterThan`, `XCTAssert` has to
// catch `XCTAssertEqual`, `assert` has to catch both `assert x == 9` and `assertEquals(`. A bare
// word that is only a disable AT a call site is therefore anchored by SPELLING the paren into
// the needle (`xit(`, `fit(`, `pending(`), which is what the default list does.
//
// Known limit, shared with structure.ts's own matcher and stated here for the same reason: the
// `(?<![\w$])` lookbehind is ASCII, so a non-ASCII letter is not an identifier character to it
// and `exit('x', fn)` spelled with a leading accent still matches `xit(`. It can only cost a
// false positive on an identifier no linter would accept, never a missed disable.
//
// The compiled patterns are cached because `containsAny` recompiles the whole vocabulary per
// line. The key is a tenant-supplied string in a process that serves many tenants, so the cache
// is BOUNDED rather than left to grow with every keyword any tenant ever configures; the
// defaults are ~40 needles, so the cap is never reached by ordinary use and a clear costs only
// recompilation.
const NEEDLE_PATTERN_CACHE_MAX = 1024;
const NEEDLE_PATTERNS = new Map<string, RegExp>();

function needlePattern(needle: string): RegExp {
  const cached = NEEDLE_PATTERNS.get(needle);
  if (cached) return cached;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const body = escaped.endsWith('\\(')
    ? `${escaped.slice(0, -2)}\\s*(?:\\(|\\.(?:each|for|concurrent|sequential|shuffle)\\b|$)`
    : escaped;
  const pattern = new RegExp(`${/^[\w$]/.test(needle) ? '(?<![\\w$])' : ''}${body}`);
  if (NEEDLE_PATTERNS.size >= NEEDLE_PATTERN_CACHE_MAX) NEEDLE_PATTERNS.clear();
  NEEDLE_PATTERNS.set(needle, pattern);
  return pattern;
}

// `content` is always a MASKED line: matching the raw one is the defect above.
function containsAny(content: string, needles: string[]): string | undefined {
  return needles.find((n) => needlePattern(n).test(content));
}

// Shell files get `shellAssertionKeywords` on top of the cross-framework list; nothing else does.
const SHELL_EXTENSIONS: readonly string[] = ['.sh', '.bash'];

function assertionKeywordsFor(file: string, cfg: AssertionDeltaConfig): string[] {
  return SHELL_EXTENSIONS.some((ext) => file.endsWith(ext))
    ? [...cfg.assertionKeywords, ...cfg.shellAssertionKeywords]
    : cfg.assertionKeywords;
}

// Whether the diff contains ONE word this detector knows -- an assertion keyword, a skip marker
// or a test declaration -- on any changed line of any file.
//
// The gate calls this only when `detectWeakenings` found nothing, and it is the difference
// between the two facts a bare `pass` conflates. A diff whose test files are all in a language
// this vocabulary has no words for was not judged CLEAN; it was not judged at all, and reporting
// it green banks coverage for a gate that read nothing. That is exactly what selecting `.sh`
// files ahead of a shell vocabulary would have done: an honest `skip(no-matching-files)` would
// have become a `pass` over a diff that deleted assertions.
export function carriesAssertionVocabulary(diffsByFile: Map<string, string>, config: AssertionDeltaConfig): boolean {
  const cfg = normalizeAssertionDeltaConfig(config);
  for (const [file, diff] of diffsByFile) {
    const vocabulary = [...assertionKeywordsFor(file, cfg), ...cfg.skipMarkers, ...cfg.testDeclarationKeywords];
    const { dels, adds } = parseChangedLines(diff, commentSyntaxFor(file));
    if ([...dels, ...adds].some((l) => containsAny(l.masked, vocabulary) !== undefined)) return true;
  }
  return false;
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
    const { dels, adds } = parseChangedLines(diff, commentSyntaxFor(file));
    const assertionKeywords = assertionKeywordsFor(file, cfg);

    // 1. Added skip/only markers.
    for (const add of adds) {
      const marker = containsAny(add.masked, cfg.skipMarkers);
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

      // Masked, like every other read: a `-`/`+` pair whose only numeric change is inside a
      // comment ("retry up to 30 times" -> "retry up to 5 times", "see issue #431" -> "#77") or
      // inside a string ("showing 9 rows" -> "showing 3 rows") is not a lowered bound. This step
      // uses no needles, so it was the one path the anchoring left reading raw content.
      const before = numbersIn(del.masked);
      const after = numbersIn(adds[ai]!.masked);
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
      if (containsAny(del.masked, cfg.testDeclarationKeywords)) {
        weakenings.push({
          file,
          line: del.line,
          kind: 'test-removed',
          before: del.content.trim(),
          detail: `test removed: "${del.content.trim()}"`,
        });
        return;
      }
      if (containsAny(del.masked, assertionKeywords)) {
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
