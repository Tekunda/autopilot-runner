// The Python half of the false-green scanner (./test-integrity-detect.ts, which owns the types
// and the entry point and routes `.py` files here). Same three ideas, pytest/unittest spellings:
//
//   hard-disable       a test disabled outright -- `@pytest.mark.skip`, `@pytest.mark.xfail`,
//                      `@unittest.skip`, a bare `pytest.skip(` / `self.skipTest(` at the top of
//                      the body.
//   empty-content-skip a skip CONDITIONED on the absence of the content the test exists to
//                      assert -- `@pytest.mark.skipif(len(cases) == 0, ...)`,
//                      `pytest.skip("no fixtures")` guarded by `if not FIXTURES:`.
//   no-assertion       a `def test_...` whose body contains no assertion at all, or whose body is
//                      `pass` / `...` / a bare `return`. pytest reports such a test as PASSED, so
//                      it is a green check that cannot fail -- the purest form of the defect.
//
// WHY A WALK AND NOT A PATTERN LIST. The JS side gets away with per-file regexes because a JS
// disable is a call expression on one line. Python's are not: the decorator sits ABOVE the `def`,
// and "asserts nothing" is a property of a whole indented block. So this is a small line-oriented
// pass that groups the file into `def test_...` blocks by indentation and judges each block.
// Deliberately NOT a Python parser -- no runtime dependency, and a parser that can fail is worse
// here than a scanner that under-reports.
//
// UNDER-REPORT, NEVER OVER-REPORT. Every rule below is written so ambiguity costs a FINDING
// rather than inventing one, because this gate is blocking by default and its only escape hatch
// lives in a container-app secret (the same argument test-integrity-detect.ts makes for its
// trailing guards). Concretely: the assertion vocabulary is deliberately GENEROUS (a
// `verify_total(...)` helper call counts, because delegating assertions to a helper is ordinary);
// a decorator this file does not recognise is ignored rather than assumed to be a disable; a
// conditional keyword anywhere in a block stands the unconditional-skip rule down; and a block
// whose indentation cannot be read ends there rather than swallowing the rest of the file.
//
// KEPT CONSISTENT WITH assertion-delta-detect.ts, which carried the repo's only prior Python
// awareness (`@pytest.mark.skip` in `skipMarkers`, `def test_` in `testDeclarationKeywords`).
// Those two spellings mean the same things here, and that file's `skipMarkers` now also carries
// the `xfail` / `expectedFailure` / `SkipTest` spellings PYTHON_HARD_DISABLE_PATTERNS recognises.

import type { TestIntegrityViolation } from './test-integrity-types.ts';

// Comment-and-string blanking for Python, so prose about the rule is not read as a breach of it
// (the same reason the JS scanner blanks comments). Handles `#` line comments and all four string
// forms including triple-quoted blocks -- a docstring is where a test file is most likely to spell
// `@pytest.mark.skip` as documentation.
//
// Newlines are preserved throughout so reported line numbers still point at the real line.
export function blankPythonNonCode(source: string): string {
  const out: string[] = new Array<string>(source.length);
  const blank = (index: number): void => {
    out[index] = source[index] === '\n' ? '\n' : ' ';
  };
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '#') {
      i = blankLineComment(source, i, blank);
      continue;
    }
    const triple = source.startsWith('"""', i) ? '"""' : source.startsWith("'''", i) ? "'''" : undefined;
    if (triple !== undefined) {
      i = blankTripleQuoted(source, i, triple, blank);
      continue;
    }
    if (ch === '"' || ch === "'") {
      i = blankQuoted(source, i, ch, blank);
      continue;
    }
    out[i] = ch;
    i += 1;
  }
  return out.join('');
}

type Blank = (index: number) => void;

function blankLineComment(source: string, start: number, blank: Blank): number {
  let i = start;
  while (i < source.length && source[i] !== '\n') {
    blank(i);
    i += 1;
  }
  return i;
}

// An unterminated triple quote blanks to EOF: the alternative is to treat the opener as code, which
// would scan a docstring's prose as source.
function blankTripleQuoted(source: string, start: number, quote: string, blank: Blank): number {
  const end = source.indexOf(quote, start + 3);
  const stop = end === -1 ? source.length : end + 3;
  for (let i = start; i < stop; i += 1) blank(i);
  return stop;
}

// A single- or double-quoted literal, ending at its closing quote or at the newline -- one bad line
// must not swallow the file. A backslash escape consumes the next character, so `'\''` stays open.
function blankQuoted(source: string, start: number, quote: string, blank: Blank): number {
  blank(start);
  let i = start + 1;
  while (i < source.length && source[i] !== quote && source[i] !== '\n') {
    if (source[i] === '\\' && i + 1 < source.length) {
      blank(i);
      i += 1;
    }
    blank(i);
    i += 1;
  }
  if (i < source.length && source[i] === quote) {
    blank(i);
    i += 1;
  }
  return i;
}

// Unconditional disables. Each takes a REASON or nothing -- never a predicate -- so every use
// switches the test off for good.
//   `@pytest.mark.skip` / `@pytest.mark.xfail`   (bare or with a `reason=`)
//   `@unittest.skip("...")` / `@skip("...")`     (and the `expectedFailure` variant)
//   `@pytest.mark.skipif(True, ...)`             (a literal-True predicate is not a condition)
// `@pytest.mark.xfail(strict=True)` IS a real assertion ("this must keep failing") and is
// deliberately excluded, along with `@pytest.mark.skipif(<expression>, ...)`, which is judged by
// the empty-content rule instead.
const PYTHON_HARD_DISABLE_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /^\s*@(?:pytest\.mark\.)?skip\s*(?:\(|$)/m, label: '@pytest.mark.skip' },
  { pattern: /^\s*@(?:pytest\.)?mark\.skip\s*(?:\(|$)/m, label: '@mark.skip' },
  { pattern: /^\s*@pytest\.mark\.xfail\s*(?:\((?![^)]*strict\s*=\s*True)|$)/m, label: '@pytest.mark.xfail' },
  { pattern: /^\s*@pytest\.mark\.skipif\s*\(\s*True\b/m, label: '@pytest.mark.skipif(True)' },
  { pattern: /^\s*@unittest\.skip\s*\(/m, label: '@unittest.skip' },
  { pattern: /^\s*@unittest\.expectedFailure\b/m, label: '@unittest.expectedFailure' },
  { pattern: /^\s*@expectedFailure\b/m, label: '@expectedFailure' },
];

// A skip statement with no condition anywhere above it in the block -- `pytest.skip("wip")` or
// `self.skipTest("wip")` as the first executable statement. `pytest.skip` inside an `if` is a
// CONDITIONAL skip and is judged by the empty-content rule instead.
const PYTHON_UNCONDITIONAL_SKIP_CALL = /^\s*(?:pytest\.skip|self\.skipTest|raise\s+unittest\.SkipTest)\s*\(/;

// The `skipif` / `if <cond>: skip` predicates that mean "there is nothing to test", matched by the
// DIRECTION of the predicate exactly as the JS side does:
//   `len(x) == 0`, `not x`, `x == []`, `x is None`, `< 1`, `<= 0`, `not os.path.exists(...)`.
// Existence predicates (`len(x) > 0`, `x is not None`) are left alone, and so is a value equality
// (`sys.platform == "win32"`), which is a legitimate environment skip.
//
// The trailing guards carry the same weight as the JS side's: without `(?![\d.])`, `< 1` matches
// the prefix of `< 1280`.
const PYTHON_EMPTY_CONTENT_PATTERNS: readonly RegExp[] = [
  /(?<![!<>=])==\s*0(?![\w.])/,
  /(?<![!<>=])==\s*(?:\[\s*\]|\{\s*\}|\(\s*\)|""|'')/,
  /<\s*1(?![\d.])|<=\s*0(?![\d.])/,
  /\bnot\s+[A-Za-z_][\w.]*\s*(?:$|[),:])/,
  /\bnot\s+(?:os\.path\.exists|Path|os\.path\.isdir|os\.path\.isfile)\s*\(/,
  /\bis\s+None\b/,
];

// Anything that can make a Python test FAIL. `assert` is the pytest idiom; the `self.assert*`
// family is unittest's; `pytest.raises` / `pytest.fail` / `pytest.approx` and the `unittest.mock`
// `assert_called*` family all fail the test when unsatisfied. Deliberately generous -- see the
// under-report rule in the header.
const PYTHON_ASSERTION_PATTERNS: readonly RegExp[] = [
  /(?<![\w.])assert(?![\w])/,
  /\bself\.assert\w*\s*\(/,
  /\bself\.fail\s*\(/,
  /\bpytest\.(?:raises|fail|approx|warns)\b/,
  /\.assert_(?:called|not_called|has_calls|any_call)\w*\s*\(/,
  /\braise\s+AssertionError\b/,
  // A test that delegates its assertions to a helper is not assertion-less; naming the helper
  // `check_`/`verify_`/`assert_` is the conventional way to say so.
  /\b(?:assert|check|verify|expect)_\w+\s*\(/,
];

interface TestBlock {
  name: string;
  // 1-based line of the `def`.
  line: number;
  // The decorator lines immediately above the `def`, nearest last.
  decorators: string[];
  // The indented body lines.
  body: string[];
}

const DEF_LINE = /^(\s*)(?:async\s+)?def\s+(test_\w*|test)\s*\(/;

// Groups a Python source into its `def test_...` blocks. A block runs from its `def` to the first
// subsequent line whose indentation is at or below the `def`'s and which is not blank -- Python's
// own block rule, and the only structure this scanner needs.
export function pythonTestBlocks(source: string): TestBlock[] {
  const lines = source.split('\n');
  const blocks: TestBlock[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = DEF_LINE.exec(lines[i]!);
    if (!match) continue;
    const indent = match[1]!.length;

    const decorators: string[] = [];
    for (let d = i - 1; d >= 0; d -= 1) {
      const line = lines[d]!;
      if (line.trim() === '') continue;
      if (!/^\s*@/.test(line)) break;
      decorators.unshift(line);
    }

    const body: string[] = [];
    for (let b = i + 1; b < lines.length; b += 1) {
      const line = lines[b]!;
      if (line.trim() === '') {
        body.push(line);
        continue;
      }
      const lineIndent = line.length - line.trimStart().length;
      if (lineIndent <= indent) break;
      body.push(line);
    }

    blocks.push({ name: match[2]!, line: i + 1, decorators, body });
  }
  return blocks;
}

// A body that does nothing at all: only `pass`, `...`, a bare `return`, or a docstring (already
// blanked by the caller).
function isEmptyBody(body: readonly string[]): boolean {
  const statements = body.map((line) => line.trim()).filter((line) => line !== '');
  return statements.length === 0 || statements.every((line) => line === 'pass' || line === '...' || line === 'return');
}

// A body whose FIRST executable statement is a bare `return`: everything after it is dead, so the
// test asserts nothing however long it is. (`return` deeper in the body, after assertions, is an
// ordinary early exit and is not flagged.)
function returnsFirst(body: readonly string[]): boolean {
  const first = body.map((line) => line.trim()).find((line) => line !== '');
  return first === 'return' || /^return(\s|$)/.test(first ?? '');
}

function hasAssertion(body: readonly string[]): boolean {
  const text = body.join('\n');
  return PYTHON_ASSERTION_PATTERNS.some((pattern) => pattern.test(text));
}

function violation(
  file: string,
  kind: TestIntegrityViolation['kind'],
  line: number,
  detail: string,
): TestIntegrityViolation {
  return { file, kind, line, detail };
}

export function detectPythonTestIntegrityViolations(file: string, source: string): TestIntegrityViolation[] {
  const code = blankPythonNonCode(source);
  const blocks = pythonTestBlocks(code);

  // ONE finding per file per kind, matching the JS side: the fix is the same edit either way, and a
  // gate that prints forty lines for one bad file gets skimmed.
  const hardDisable = moduleLevelDisable(file, code) ?? firstOf(blocks, (block) => blockDisable(file, block));
  const emptySkip = firstOf(blocks, (block) => blockEmptyContentSkip(file, block));
  const noAssertion = firstOf(blocks, (block) => blockNoAssertion(file, block));

  return [hardDisable, emptySkip, noAssertion].filter((found): found is TestIntegrityViolation => found !== undefined);
}

function firstOf(
  blocks: readonly TestBlock[],
  judge: (block: TestBlock) => TestIntegrityViolation | undefined,
): TestIntegrityViolation | undefined {
  for (const block of blocks) {
    const found = judge(block);
    if (found) return found;
  }
  return undefined;
}

// `pytestmark = pytest.mark.skip(...)` at module or class level disables EVERY test in the file in
// one line -- the highest-leverage false green there is, and it is attached to no `def`.
function moduleLevelDisable(file: string, code: string): TestIntegrityViolation | undefined {
  const match = /^\s*pytestmark\s*=.*\bpytest\.mark\.(skip|xfail)\b/m.exec(code);
  if (!match) return undefined;
  return violation(
    file,
    'hard-disable',
    lineOf(code, match.index),
    `\`pytestmark = pytest.mark.${match[1]}\` disables EVERY test in this module; the file reports ` +
      `green having asserted nothing. Re-enable it or delete the tests.`,
  );
}

function blockDisable(file: string, block: TestBlock): TestIntegrityViolation | undefined {
  const decorators = block.decorators.join('\n');
  const hit = PYTHON_HARD_DISABLE_PATTERNS.find(({ pattern }) => pattern.test(decorators));
  if (hit) {
    return violation(
      file,
      'hard-disable',
      block.line,
      `\`${block.name}\` is disabled outright (\`${hit.label}\`); a test that never runs cannot fail. ` +
        `Re-enable it or delete it.`,
    );
  }
  if (block.body.some((line) => PYTHON_UNCONDITIONAL_SKIP_CALL.test(line)) && !hasCondition(block.body)) {
    return violation(
      file,
      'hard-disable',
      block.line,
      `\`${block.name}\` skips unconditionally in its body (\`pytest.skip(\`/\`self.skipTest(\` with no ` +
        `condition above it); the test reports as skipped on every run. Re-enable it or delete it.`,
    );
  }
  return undefined;
}

function blockEmptyContentSkip(file: string, block: TestBlock): TestIntegrityViolation | undefined {
  const decorators = block.decorators.join('\n');
  const skipif = /^\s*@pytest\.mark\.skipif\s*\(([\s\S]*)$/m.exec(decorators);
  const condition = skipif ? firstSkipifArgument(skipif[1]!) : undefined;
  const guarded = block.body.some(
    (line) =>
      /^\s*if\b/.test(line) &&
      PYTHON_EMPTY_CONTENT_PATTERNS.some((pattern) => pattern.test(line)) &&
      block.body.some((other) => PYTHON_UNCONDITIONAL_SKIP_CALL.test(other)),
  );
  const byDecorator = condition !== undefined && PYTHON_EMPTY_CONTENT_PATTERNS.some((p) => p.test(condition));
  if (!byDecorator && !guarded) return undefined;
  return violation(
    file,
    'empty-content-skip',
    block.line,
    `\`${block.name}\` skips on empty/absent content (\`${(condition ?? 'if <empty>: pytest.skip(...)')
      .trim()
      .replace(/\s+/g, ' ')}\`); a suite that skips itself when its content is missing reports green ` +
      `on the failure it exists to catch. Assert the content EXISTS instead.`,
  );
}

function blockNoAssertion(file: string, block: TestBlock): TestIntegrityViolation | undefined {
  // `returnsFirst` is checked ALONGSIDE `hasAssertion`, not instead of it: a body whose first
  // statement is `return` asserts nothing however many `assert`s follow it, because none of them
  // execute. That shape is the quietest of the three -- it reads like a real test in review.
  const returns = returnsFirst(block.body);
  if (hasAssertion(block.body) && !returns) return undefined;
  // A test with a hard disable is already reported; a second finding about the same `def` would
  // send the fix loop after the wrong edit.
  if (isDisabled(block)) return undefined;
  const empty = isEmptyBody(block.body);
  return violation(
    file,
    'no-assertion',
    block.line,
    `\`${block.name}\` ${
      empty ? 'has an empty body' : returns ? 'returns before doing anything' : 'contains no assertion'
    }; pytest reports it as PASSED, so it is a green test that cannot fail. Assert something or delete it.`,
  );
}

function isDisabled(block: TestBlock): boolean {
  const decorators = block.decorators.join('\n');
  return (
    PYTHON_HARD_DISABLE_PATTERNS.some(({ pattern }) => pattern.test(decorators)) ||
    /^\s*@pytest\.mark\.skipif\s*\(/m.test(decorators) ||
    block.body.some((line) => PYTHON_UNCONDITIONAL_SKIP_CALL.test(line))
  );
}

// A `pytest.skip(` inside an `if`/`elif`/`try` is conditional; one at statement level is not.
// Cheap and deliberately conservative: any conditional keyword in the block means the skip might
// be guarded, so the unconditional rule stands down (see the under-report rule in the header).
function hasCondition(body: readonly string[]): boolean {
  return body.some((line) => /^\s*(?:if|elif|else|try|except|for|while|with)\b/.test(line));
}

// The first argument of a `@pytest.mark.skipif(...)` decorator: everything up to the first comma
// at paren depth 0. `skipif`'s second argument is its `reason`, which routinely contains a comma
// and a zero, so a naive split on the first comma reads the prose as the predicate.
function firstSkipifArgument(rest: string): string {
  let depth = 1;
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i]!;
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return rest.slice(0, i);
    } else if (ch === ',' && depth === 1) return rest.slice(0, i);
  }
  return rest;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}
