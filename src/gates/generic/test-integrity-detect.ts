// Pure detector for FALSE-GREEN TESTS: a test that is disabled outright, or one whose
// skip is conditioned on the ABSENCE of the very content it exists to assert. Both make a
// required suite report green while asserting nothing -- the same defect class as a gate
// that matches zero files (see structure.ts / test-policy.ts). A guard shipped with its own
// "this bad input is rejected" case turned off is a linter that cannot fail on the thing it
// exists to catch.
//
// SCOPE, stated so the gate cannot quietly claim more than it does: the patterns below are
// JavaScript/TypeScript test-runner spellings (Playwright, Jest, Vitest, node:test, mocha).
// `isScannableTestFile` is the ONLY authority on what this detector can judge, and
// structure.ts reports files it selected but could not judge separately from files it
// scanned -- because "scanned a .py file and found nothing" would be exactly the
// examined-nothing-and-reported-green defect this whole change removes, one level down.
// Adding a language means adding its patterns AND its extension here, together.
//
// The rules are ported from Tekunda/Website's scripts/code-structure-check.sh, which enforced
// them on the pipeline this replaced. No filesystem, no git: structure.ts feeds it file
// contents so this stays unit-testable and deterministic.

export type TestIntegrityKind = 'hard-disable' | 'empty-content-skip';

export interface TestIntegrityViolation {
  file: string;
  kind: TestIntegrityKind;
  // 1-based line of the offending call, for a finding a human (or the fix loop) can jump to.
  line: number;
  detail: string;
}

// The languages whose disable spellings the patterns below actually cover. A test file
// outside this set is NOT scanned and must never be counted as one that was.
const SCANNABLE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

export function isScannableTestFile(file: string): boolean {
  return SCANNABLE_EXTENSIONS.some((ext) => file.endsWith(ext));
}

// A test that is disabled OUTRIGHT, with no condition to ever re-enable it:
//   - xit( / xtest( / xdescribe(     - the explicit "disabled" spellings.
//   - it.skip( / describe.skip(      - these take a TITLE, not a condition, so every use is an
//                                      unconditional disable (`test.describe.skip(` matches
//                                      too: the lookbehind rejects word chars, not the dot).
//   - it.only( / test.only( / describe.only( - strictly worse than a skip: it disables every
//                                      OTHER test in the run. A committed `.only` is the
//                                      quietest false green there is -- the suite still
//                                      reports green having executed one test.
//   - test.fixme(                    - Playwright's "known broken, do not run".
//   - { skip: true } / { skip: '...' } - node:test's PRIMARY spelling (`test('x', { skip:
//                                      true }, fn)`), and the one this repo's own suite would
//                                      use. A non-literal `{ skip: cond }` is a CONDITIONAL
//                                      skip and is deliberately not matched.
//   - test.skip() / test.skip(true)  - a statement-level disable with no condition.
//   - test.skip("title", fn)         - Playwright's title/callback overload: declares a whole
//                                      test whose body never runs, same as it.skip( above.
// Conditional skips are deliberately NOT here: `test.skip(browserName === "webkit")` is a
// value equality, not a disable, and stays allowed.
const HARD_DISABLE_PATTERNS: readonly RegExp[] = [
  /(?<![\w.$])x(?:it|test|describe)\s*\(/,
  /(?<![\w$])(?:it|describe)\.skip\s*\(/,
  /(?<![\w$])(?:it|test|describe)\.only\s*\(/,
  /(?<![\w$])(?:it|test|describe)\.fixme\s*\(/,
  /\{\s*skip\s*:\s*(?:true\b|['"`])/,
  /(?<![\w$])test\.skip\s*\(\s*(?:\)|true\s*[,)])/,
  /(?<![\w$])test\.skip\s*\(\s*(['"`])(?:\\.|(?!\1)[\s\S])*\1\s*,\s*(?:async\s*)?(?:\(|function\b)/,
];

// A skip gated on the ABSENCE of content, matched by the DIRECTION of the predicate rather
// than the tokens in it:
//   - equality to zero: `== 0` / `=== 0`, but NOT `!== 0` (which skips when content EXISTS
//     and is therefore fine);
//   - `< 1` / `<= 0`  - an empty count or length;
//   - a bare negated reference `!x` / `(!x)` with no call in it.
// Existence skips (`.length > 0`, `!== 0`), value-equality skips (`browserName === "webkit"`)
// and predicate skips that carry a CALL (`!location?.startsWith(...)`) are left alone.
//
// The trailing guards are load-bearing, not tidiness. Without `(?![\d.])`, `< 1` matches the
// PREFIX of `width < 1280` -- `page.viewportSize().width < 1280` is standard Playwright, and
// this gate is blocking by default with its only escape hatch in a container-app secret. Same
// for `<= 0.5` and for `=== 0x02` on the equality pattern. The shell original could live
// without them because it ran over one glob in one repo; this runs over every tenant.
const EMPTY_CONTENT_PATTERNS: readonly RegExp[] = [
  /(?<![!<>=])===?\s*0(?![\w.])/,
  /<\s*1(?![\d.])|<=\s*0(?![\d.])/,
  /^\s*\(*\s*!\s*[A-Za-z_$][\w$.?]*\s*\)*\s*$/,
];

export interface ScannedSource {
  // The source with every comment blanked -- newlines preserved, so reported line numbers
  // still point at the real line.
  code: string;
  // Per-character: is this character inside a string or template literal?
  inString: boolean[];
}

// ONE left-to-right pass that tracks comment state and string state TOGETHER. Doing it in two
// passes is wrong in both orders, and both orders were tried: strip comments first and a `//`
// or `/*` inside a string literal blanks real code after it (`const a = "x /* y"; xit("REAL")`
// goes undetected); mask strings first and a comment's stray apostrophe ("don't") opens a
// phantom string that swallows the rest of the file.
//
// Both outputs are needed downstream. Comments must be blanked because specs legitimately
// carry the prose "no test.skip() on content", and `test.skip()` is itself a banned token --
// an unstripped scan flags a file for documenting the rule it obeys. Strings must be MASKED
// rather than blanked because one pattern (`test.skip("title", fn)`) has to see the string it
// spans, while a banned token quoted as DATA must not count: this repo's own
// assertion-delta-detect.test.ts carries `"+  it.skip('adds nine addon sections', ..."` as a
// diff fixture, and any repo with a test corpus or a linter fixture has the same shape. A gate
// that reds a PR for quoting the pattern it bans gets switched off, and then it enforces
// nothing.
//
// Known limit, which can only COST a finding and never invent one: a regex literal whose body
// starts `//` or `/*` is read as a comment.
//
// Template literals need a STACK, not a single open-quote char. With one char, the inner
// backtick of a nested template CLOSES the outer one and everything after it is scanned as
// code -- so `` `${indent(`it.only("x", fn)`)}` ``, a fixture, reports a hard-disable. That is
// the gate crying wolf on exactly the shape the mask exists to protect, on a blocking gate
// whose only escape hatch lives in a container-app secret. Interpolations are tracked with
// brace depth so `${...}` is treated as the CODE it is, and its own nested strings as strings.
export function scanSource(source: string, allowTemplates = true): ScannedSource {
  const code: string[] = new Array<string>(source.length);
  const inString = new Array<boolean>(source.length).fill(false);
  // Bottom-to-top: each `template` frame is an open backtick; each `interp` frame is an open
  // `${` inside one, carrying the brace depth that decides which `}` closes it.
  type Frame = { kind: 'template' } | { kind: 'interp'; braces: number };
  const stack: Frame[] = [];
  type State = 'code' | 'line-comment' | 'block-comment' | 'string';
  let state: State = 'code';
  let quote = '';
  const inTemplate = (): boolean => stack.length > 0 && stack[stack.length - 1]!.kind === 'template';

  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]!;
    const next = source[i + 1];

    // Inside a template's raw text (not inside one of its `${}` interpolations).
    if (inTemplate()) {
      code[i] = ch;
      inString[i] = true;
      if (ch === '\\' && i + 1 < source.length) {
        code[i + 1] = source[i + 1]!;
        inString[i + 1] = true;
        i += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        code[i + 1] = '{';
        // The interpolation is CODE: leave `${`'s brace and everything up to the matching `}`
        // unmasked so a real disable there is still seen and its parens still counted.
        inString[i + 1] = false;
        i += 1;
        stack.push({ kind: 'interp', braces: 0 });
        continue;
      }
      if (ch === '`') stack.pop();
      continue;
    }

    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line-comment';
        code[i] = ' ';
        continue;
      }
      if (ch === '/' && next === '*') {
        state = 'block-comment';
        code[i] = ' ';
        continue;
      }
      if (ch === '`' && allowTemplates) {
        stack.push({ kind: 'template' });
        code[i] = ch;
        continue;
      }
      if (ch === "'" || ch === '"') {
        state = 'string';
        quote = ch;
        code[i] = ch;
        continue;
      }
      // Brace depth only matters inside an interpolation, where it decides which `}` ends it.
      const top = stack[stack.length - 1];
      if (top?.kind === 'interp') {
        if (ch === '{') top.braces += 1;
        else if (ch === '}') {
          if (top.braces === 0) {
            stack.pop(); // back into the enclosing template's raw text
            code[i] = ch;
            continue;
          }
          top.braces -= 1;
        }
      }
      code[i] = ch;
      continue;
    }

    if (state === 'line-comment') {
      code[i] = ch === '\n' ? '\n' : ' ';
      if (ch === '\n') state = 'code';
      continue;
    }

    if (state === 'block-comment') {
      code[i] = ch === '\n' ? '\n' : ' ';
      if (ch === '*' && next === '/') {
        code[i + 1] = ' ';
        i += 1;
        state = 'code';
      }
      continue;
    }

    // state === 'string' -- a single- or double-quoted literal.
    code[i] = ch;
    inString[i] = true;
    if (ch === '\\' && i + 1 < source.length) {
      code[i + 1] = source[i + 1]!;
      inString[i + 1] = true;
      i += 1;
      continue;
    }
    // An unterminated '/" ends at the newline so one bad line cannot swallow the file.
    if (ch === quote || ch === '\n') {
      state = 'code';
      quote = '';
    }
  }

  // A template still open at EOF means the opening backtick was not one: the commonest cause
  // is a lone backtick in code the scanner does not parse (a markdown-fence regex, a backtick
  // in JSX text). Left alone it masks EVERYTHING after it -- a whole-file false negative,
  // which on this gate is worse than a false positive. Reinterpret the file once with
  // backticks as ordinary characters rather than trusting a parse that cannot be right.
  if (stack.length > 0 && allowTemplates) return scanSource(source, false);

  return { code: code.join(''), inString };
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}

// Extracts the balanced argument text of every `test.skip(...)` call. A per-line regex is not
// enough: a skip condition legitimately spans lines and wraps itself in parens, so a line scan
// both misses multiline skips and cannot tell the call's condition from the code trailing it.
// JS has no recursive regex (the shell original used perl's `(?1)`), so the nesting is walked
// by hand.
//
// The depth walk MUST consult the string mask, not just the opener. Counting a paren that
// lives inside the skip's reason string leaves `depth !== 0` at EOF and drops the call
// SILENTLY -- so `test.skip(count === 0, "no items (")` was clean, and adding one character to
// a reason string switched the ban off. In a gate whose entire subject is people disabling
// gates, that is the bug, not a rough edge.
//
// Unterminated calls are dropped rather than throwing -- a gate that throws is recorded as a
// failing check that no edit clears, which wedges the fix loop.
function testSkipArguments(source: string, inString: boolean[]): { text: string; index: number }[] {
  const calls: { text: string; index: number }[] = [];
  const opener = /(?<![\w$])test\.skip\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(source)) !== null) {
    if (inString[match.index]) continue;
    let depth = 1;
    let i = match.index + match[0].length;
    for (; i < source.length && depth > 0; i += 1) {
      if (inString[i]) continue;
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
    }
    if (depth !== 0) continue;
    calls.push({ text: source.slice(match.index + match[0].length, i - 1), index: match.index });
  }
  return calls;
}

// The condition is the FIRST argument; everything after it is the skip's reason string, which
// may itself contain a comma or a zero. Splitting on the first comma is wrong when the
// condition contains one (`test.skip(a.slice(0, 2).length === 0, "why")`), so the split walks
// to the first comma at paren depth 0 that is not inside a string.
function firstArgument(text: string, inString: boolean[], offset: number): string {
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (inString[offset + i]) continue;
    const ch = text[i];
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') depth -= 1;
    else if (ch === ',' && depth === 0) return text.slice(0, i);
  }
  return text;
}

export function detectTestIntegrityViolations(file: string, source: string): TestIntegrityViolation[] {
  const { code, inString } = scanSource(source);
  const violations: TestIntegrityViolation[] = [];

  for (const basePattern of HARD_DISABLE_PATTERNS) {
    const pattern = new RegExp(basePattern.source, 'g');
    let hit: RegExpExecArray | null = null;
    while ((hit = pattern.exec(code)) !== null) if (!inString[hit.index]) break;
    if (!hit) continue;
    violations.push({
      file,
      kind: 'hard-disable',
      line: lineOf(code, hit.index),
      detail:
        `disables a test outright (\`${hit[0].replace(/\s+/g, '')}\`); a guard whose own failing ` +
        `case is turned off cannot fail. Re-enable it or delete it.`,
    });
    break; // One finding per file per kind: the fix is the same edit either way.
  }

  for (const call of testSkipArguments(code, inString)) {
    const argsOffset = code.indexOf(call.text, call.index);
    const condition = firstArgument(call.text, inString, argsOffset);
    if (!EMPTY_CONTENT_PATTERNS.some((pattern) => pattern.test(condition))) continue;
    violations.push({
      file,
      kind: 'empty-content-skip',
      line: lineOf(code, call.index),
      detail:
        `skips on empty/zero content (\`test.skip(${condition.trim().replace(/\s+/g, ' ')})\`); a suite ` +
        `that skips itself when its content is missing reports green on the failure it exists ` +
        `to catch. Assert the content EXISTS instead.`,
    });
    break;
  }

  return violations;
}
