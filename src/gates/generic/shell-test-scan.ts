// The shell half of the false-green scanner (./test-integrity-detect.ts, which owns the types and
// the entry point and routes `.sh`/`.bash` files here).
//
// REPORT-ONLY WHILE IT BURNS IN. structure.ts routes every finding from this module to the `warn`
// path, never the `fail` path, so a shell finding is printed and cannot block a merge. That is not
// timidity: two of the three rules below were redding correct code when first measured, and the
// corpus that pronounced them clean structurally could not have contained either shape -- 100% of
// its shell suites lived in `scripts/*.test.sh` and it had no `tests/**/*.sh` at all. Two things
// have to be true before the demotion in structure.ts is deleted, and they are DIFFERENT KINDS OF
// EVIDENCE -- demanding a printed finding for both makes the second one unsatisfiable:
//   - a repo whose shell suites use HELPER FUNCTIONS WITH GUARD CLAUSES has had findings PRINTED
//     across PRs, and none of them landed on a guard clause. Those suites ARE selected, so a
//     finding is available as evidence and its absence on that shape is what the burn-in buys.
//   - a repo carrying NON-SUITE shell scripts under `tests/`, `e2e/` or `spec/` has been SEEN.
//     `SHELL_SUITE_MARKERS` deselects those files, so no finding can ever be printed from one and
//     "no finding on them" proves nothing on its own; what the burn-in has to record is that the
//     shape was PRESENT in a judged repo at all.
// Both shapes are to be sought out, not waited for. Having seen the shape and measured nothing is
// evidence of absence; having seen no such repo is absence of evidence, and a gate promoted on
// that is a gate promoted on nothing.
//
// SELECTION IS NARROWER THAN THE OTHER LANGUAGES', and every one of the narrowings is stated here
// because a DESELECTED file is the one outcome nobody can see. A file this module cannot judge but
// structure.ts still SELECTS raises `unjudgeable-language`, which is loud and stays out of the
// coverage record; a file structure.ts never selects banks an ordinary green `pass` that says
// "0 test file(s) selected" -- indistinguishable from a diff that genuinely had no tests in it. So
// the list below is not trivia, it is the shape of the blind spot. Selection is
// `SHELL_SUITE_MARKERS` in structure.ts: `.test.`, `.spec.`, `_test.`, `-test.`, `_spec.` and a
// `test_` PREFIX, matched on the filename and never on the directory. NOT selected, and therefore
// silently green:
//   - `tests/totals.sh` and any other suite named only by its DIRECTORY. Directory membership is
//     what graded `tests/setup.sh` and `ci/e2e/up.sh` as suites, and shell has no function-level
//     "is this a test at all?" precondition to recover from that inside the judge, so the whole
//     directory signal is gone -- honest suites included.
//   - `run-tests.sh`, `all_tests.sh`, `tests.sh`: a plural or verb-shaped runner name matches no
//     marker.
//   - `.bats`, `.zsh`, `.ksh` and shebang-only scripts with no extension. `.bats` is the
//     mainstream shell TEST framework, so naming it is the point: a repo whose suite is
//     `tests/*.bats` gets no coverage from this module at all, and a clean run says nothing about
//     it. Its grammar is not shell's -- `@test "x" { ... }` blocks with a function-level structure
//     the rules below do not model -- so it wants the same treatment `.sh` just got, not a quiet
//     extension of the selection list.
// And the reverse narrowing, an OVER-selection: `test_` is a prefix, so `test_helper.bash` (the
// canonical bats helper name), `test_helpers.sh` and `test_common.sh` are selected and judged, and
// each measures `no-assertion`. They are infrastructure. Left in deliberately: while these rules
// are report-only a printed finding on a shape the burn-in is explicitly hunting for is evidence,
// and the alternative is enumerating instances of an open class of helper names.
//
// THE OVER-REPORT BESIDE IT, and the one likeliest to matter, because it lands on the LAST LINE OF
// A PASSING SUITE. `FAILURE_COUNTER` below exempts a verdict line whose counter is named `fail`,
// `err` or `bad`, so `[ "$FAIL" = 0 ] && exit 0` is correctly read as a suite reporting its verdict
// rather than skipping itself. A counter named anything else is not exempt and raises
// `empty-content-skip`: `[ "$rc" = 0 ] && exit 0`, `[ "$problems" = 0 ] && exit 0`,
// `[ "$missing" -eq 0 ] && exit 0`. On the corpus these rules were calibrated against `rc` is in
// fact the DOMINANT counter name -- 146 verdict comparisons against `rc`/`RC` to 41 against
// `fail`/`FAIL` -- so the exemption is named after the minority spelling. None of the 46
// suites there flags today only because their verdict lines carry no `&& exit 0`.
//
// Adding `rc|problems|missing` to that regex is the wrong fix: it enumerates instances of an open
// class one level down from the helper names above. The class-level signal is not the NAME, it is
// whether the variable is a running count the suite INCREMENTS (`FAIL=$((FAIL+1))`) rather than a
// quantity of content it measured (`n=$(ls | wc -l)`) -- and "compared to zero on a line that also
// exits" cannot serve, because that is byte-for-byte the shape of the true positive
// `[ "$n" -eq 0 ] && exit 0` this rule exists to catch. A dataflow rule is a rule, with its own
// spellings (`((FAIL++))`, `let`, a flat `FAIL=1` set inside a helper, an increment lost in a
// subshell) and its own over-report direction, so it wants measuring against a corpus rather than
// bolting on here. Until then this is a stated residual, which is exactly what the report-only
// burn-in is collecting.
//
// The tenant knob is `structure.testFileExtensions` (drop `.sh` and no shell file is selected).
// `structure.testFileMarkers` deliberately does NOT govern shell -- see SHELL_SUITE_MARKERS -- so
// a tenant whose suites are `check_*.sh` has no way to say so today.
//
// Same three ideas as the other halves, shell spellings:
//
//   hard-disable       the run stops UNCONDITIONALLY before its checks -- a top-level `exit 0`
//                      (or a bare `exit`) with checks still below it, which is what a
//                      "temporarily skipped" shell suite always turns into.
//   empty-content-skip the run bails when the content it exists to check is ABSENT --
//                      `[ -z "$x" ] && exit 0`, `[ -f "$fixture" ] || exit 0`,
//                      `if [ "$n" -eq 0 ]; then exit 0; fi`.
//   no-assertion       nothing in the file can produce a non-zero status, so the suite reports
//                      green whatever the code under test does.
//
// WHY A SEPARATE MODULE, AND A SEPARATE MASKER. Shell is a different GRAMMAR, not a different
// pattern list, and four of its differences are load-bearing here:
//   - comments are `#` to end of line, but `$#`, `${v#p}` and `${#a[@]}` are ordinary code, so a
//     `#` opens a comment only at the start of a word;
//   - a single-quoted string has NO escapes at all (`'\'` is a complete string), while `$'...'`
//     and `"..."` do have them, so one quote rule cannot serve both;
//   - a HERE-DOC body is data, not code, and masking it is not a nicety. Shell suites build their
//     stubs with `cat > bin/gh <<'EOF' ... exit 0 ... EOF`; without here-doc masking every one of
//     those stub `exit 0`s reads as the suite disabling itself, which was measurably the dominant
//     false positive on the corpus these rules were calibrated against;
//   - a backtick opens a command SUBSTITUTION, whose contents are code. Masking it as a string
//     literal, the way the C-style scanner masks a template literal, would hide real calls.
//
// UNDER-REPORT, NEVER OVER-REPORT, for the reason python-test-scan.ts states: the gate is blocking
// by default and its only escape hatch lives in a container-app secret, so ambiguity costs a
// FINDING rather than inventing one. The report-only demotion above is a burn-in, not a licence to
// relax that -- these rules have to be right BEFORE they are promoted, not after. Concretely: an unterminated here-doc is left as
// ordinary code rather than blanked to EOF; the failure vocabulary is deliberately generous; a
// file under `set -e` is exempt from the assertion-less rule because there EVERY command asserts;
// and a file that pipes a here-doc into another interpreter has delegated its assertions to a
// language this scanner cannot read, so that rule stands down too.
//
// DELIBERATELY OUT OF SCOPE: the vacuous-guard rule (assertions reachable only inside
// `if [ -n "$out" ]; then`). Not because the PREDICATE is unreadable -- `emptyContentSkip` below
// reads `[ -z "$out" ]` precisely enough to base a finding on, and `out=$(...)` is a cleaner
// "initialised from a call" signal than JS offers. The missing piece is the BLOCK. That rule's
// precision comes from an exact lexical structure: which statements the guard actually governs,
// whether an `else` arm exists, and whether a proof dominates the guard. Shell offers this module
// only `shellLines`'s depth walk, which its own comment calls approximate by design, and the first
// review of this file found that same walk producing a false positive in `emptyContentSkip`. A
// second rule resting on it would compound the imprecision, on a gate whose only escape hatch lives
// in a container-app secret. When shell suites are judged by a real parser this becomes worth
// revisiting; over an approximate depth count it is not.

import type { TestIntegrityViolation } from './test-integrity-types.ts';

const SHELL_EXTENSIONS: readonly string[] = ['.sh', '.bash'];

export function isShellTestFile(file: string): boolean {
  return SHELL_EXTENSIONS.some((ext) => file.endsWith(ext));
}

interface ScannedShell {
  // Comments and here-doc bodies blanked to spaces; newlines preserved, so a reported line number
  // still points at the real line. Quoted text is KEPT (see `inString`) because the predicates
  // these rules read live inside quotes: `[ -z "$out" ]` blanked to `[ -z      ]` is unreadable.
  code: string;
  // Per-character: is this character inside a quoted literal? A banned token quoted as DATA
  // (`echo "no failures"`) must not count, the same rule the C-style scanner applies.
  inString: boolean[];
}

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
}

type Blank = (from: number, to: number) => void;

// ONE left-to-right pass, for the reason test-integrity-detect.ts's scanSource gives: comment
// state and quote state decide each other, so resolving them in two passes is wrong in both
// orders.
function scanShellSource(source: string): ScannedShell {
  const code: string[] = source.split('');
  const inString = new Array<boolean>(source.length).fill(false);
  const blank: Blank = (from, to) => {
    for (let i = from; i < to && i < source.length; i += 1) if (code[i] !== '\n') code[i] = ' ';
  };

  // Here-docs opened on the current line, consumed in order at the next newline.
  let pending: Heredoc[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const opener = heredocOpener(source, i);
    if (ch === '\n' && pending.length > 0) {
      i = consumeHeredocs(source, i + 1, pending, blank);
      pending = [];
    } else if (ch === '#' && opensComment(source, i)) {
      i = blankToEndOfLine(source, i, blank);
    } else if (ch === "'" || ch === '"') {
      // `$'...'` is ANSI-C quoting and DOES honour backslash escapes; a plain `'...'` does not, so
      // `'\''` is a closed string followed by more code and must not be read as an escape.
      i = markQuoted(source, i, ch, ch === '"' || source[i - 1] === '$', inString);
    } else if (opener) {
      pending.push(opener.heredoc);
      i += opener.length;
    } else {
      i += 1;
    }
  }

  return { code: code.join(''), inString };
}

// `#` opens a comment only at the start of a word. `$#` and `${name#prefix}` are ordinary code, and
// blanking from there would hide the rest of a real line.
function opensComment(source: string, at: number): boolean {
  return at === 0 || /[\s;&|(]/.test(source[at - 1]!);
}

function blankToEndOfLine(source: string, at: number, blank: Blank): number {
  const end = source.indexOf('\n', at);
  const stop = end === -1 ? source.length : end;
  blank(at, stop);
  return stop;
}

// A here-doc opener, but never the here-STRING `<<<`, which redirects a value and appears far more
// often than here-docs in test suites (`grep -q x <<<"$out"`).
//
// A QUOTED delimiter is anything up to the closing quote: `<<"END-OF-STUB"` and `<<'py.EOF'` are
// ordinary shell, and refusing them was not conservative, it was the opposite. The body then went
// unmasked, so every `exit 0` inside a stub script read as the suite disabling itself -- a
// `hard-disable` finding on a correct suite, from the very masking this module exists to do.
const HEREDOC_OPENER = /^<<(-?)\s*(?:'([^'\s]+)'|"([^"\s]+)"|([A-Za-z_][\w.-]*))/;

function heredocOpener(source: string, at: number): { heredoc: Heredoc; length: number } | undefined {
  if (source[at] !== '<' || source[at + 1] !== '<' || source[at + 2] === '<') return undefined;
  const opener = HEREDOC_OPENER.exec(source.slice(at));
  const delimiter = opener?.[2] ?? opener?.[3] ?? opener?.[4];
  if (!opener || delimiter === undefined) return undefined;
  return { heredoc: { delimiter, stripTabs: opener[1] === '-' }, length: opener[0].length };
}

// Marks a quoted run as string, returning the index just past its closing quote (or EOF). `code`
// is untouched: the predicates these rules read live inside quotes, so blanking the body would
// make every one of them unreadable.
function markQuoted(source: string, start: number, quote: string, escapes: boolean, inString: boolean[]): number {
  let i = start + 1;
  while (i < source.length) {
    if (escapes && source[i] === '\\' && i + 1 < source.length) {
      inString[i] = true;
      inString[i + 1] = true;
      i += 2;
      continue;
    }
    if (source[i] === quote) return i + 1;
    inString[i] = true;
    i += 1;
  }
  return i;
}

// Blanks each pending here-doc body, in the order the openers appeared. An UNTERMINATED here-doc
// is left as ordinary code rather than blanked to EOF: a `<<` this parser misread (a left shift in
// `$((a<<b))`) would otherwise blank the whole rest of the file, and every rule below would then
// report clean on a file it never read -- the exact defect this scanner exists to catch.
function consumeHeredocs(source: string, from: number, pending: readonly Heredoc[], blank: Blank): number {
  let cursor = from;
  for (const { delimiter, stripTabs } of pending) {
    // The delimiter IS escaped: a quoted one may carry `.`, `+`, `(` and every other metacharacter,
    // and an unescaped `py.EOF` would terminate on `pyxEOF` -- blanking less, or more, than the
    // body.
    const quoted = delimiter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const terminator = new RegExp(`^${stripTabs ? '\t*' : ''}${quoted}[ \t]*$`, 'm');
    const found = terminator.exec(source.slice(cursor));
    if (!found) return cursor;
    const end = cursor + found.index + found[0].length;
    blank(cursor, end);
    cursor = end;
  }
  return cursor;
}

// Anything that can make a shell suite FAIL. Deliberately generous, and scoped to THIS file so the
// house vocabulary of shell suites cannot leak into another language's rules: the dominant idiom
// measured across a real corpus is a pair of `ok`/`bad` helpers over a `FAIL` counter, with
// `assert_*` a small minority, and `bad`/`fail` are ordinary English words that appear constantly
// in JS, TS and Python source. `ok` is deliberately absent: it is the SUCCESS side of that idiom
// and proves nothing about the suite being able to fail.
const SHELL_FAILURE_PATTERNS: readonly RegExp[] = [
  // A non-zero, or computed, exit/return status. `exit 0` is deliberately excluded.
  /(?<![\w-])(?:exit|return)\s+"?\$?(?:[1-9]\d*|\{?[A-Za-z_?])/,
  /(?<![\w-])(?:fail|bad|die|abort|assert|expect|error)/i,
];

// A here-doc fed to another INTERPRETER carries the suite's checks in a language this scanner does
// not read. Judging such a file assertion-less would be a confident false positive, so the rule
// stands down instead -- under-report, never over-report.
//
// Scoped to an interpreter in COMMAND POSITION on the opening line, rather than to any here-doc at
// all or to the interpreter's name anywhere on it. Both narrowings are load-bearing:
//   - a shell suite writing a fixture or a stub with `cat > bin/gh <<'EOF'` has delegated NOTHING,
//     and exempting every here-doc would have made this rule inert on most of a real corpus -- a
//     check that examines nothing and reports green, one level down;
//   - `.` and `/` are not word characters, so a name test alone matched `helper.sh`, `run.bash` and
//     `$BIN/sh`. Writing a `.sh` stub via here-doc is one of the commonest things a shell suite
//     does, and every one of those files had `no-assertion` silently switched off. Command position
//     means the start of a line or just after a `;`, `|`, `&` or `(`.
//
// WHAT MAY SIT BETWEEN THE SEPARATOR AND THE NAME, because a lost exemption is a confident false
// `no-assertion` on a file whose checks this scanner cannot read, and this module bans
// over-reporting above. None of these changes WHAT is being invoked:
//   - a directory prefix and/or a QUOTE: `/usr/bin/python3`, `"$BIN/sh" -`. The quote is not
//     cosmetic -- `"` is not a word character, so without it the earlier claim that a quoted
//     `"$BIN/sh" -` invocation still counted was simply false.
//   - `env` or `command`, themselves optionally pathed: `/usr/bin/env python3 - <<PY`.
//   - any number of `VAR=value` assignments: `PYTHONPATH=. python3 - <<PY`.
//   - the interpreter held in a VARIABLE, `$PY - <<PY` / `"$PYTHON" - <<PY`, which no name list can
//     recognise. Admitted only in the `<var> - <<D` spelling, where the bare `-` is the
//     read-the-script-from-stdin flag and so is itself the evidence of delegation. Without that
//     requirement `$SUDO cat > f <<EOF` would exempt a file that delegates nothing.
// `jq` and `psql` are on the name list for the same reason as the interpreters: `jq -e` and a
// `psql` script carry the suite's verdict in a language this scanner does not read.
const INVOCATION_PREFIX = String.raw`(?:(?:[\w.$/-]*\/)?(?:command|env)[ \t]+|[A-Za-z_]\w*=\S*[ \t]+)*`;
const INTERPRETERS = String.raw`(?:python3?|node|deno|perl|ruby|php|awk|osascript|jq|psql|bash|sh|zsh)`;
const DELEGATING_HEREDOC = new RegExp(
  String.raw`(?:^|[;&|(])[ \t]*${INVOCATION_PREFIX}` +
    String.raw`(?:['"]?(?:[\w.$/-]*\/)?${INTERPRETERS}(?![\w.-])|['"]?\$\{?\w+\}?['"]?[ \t]+-(?=[ \t]|$))` +
    String.raw`[^\n]*<<-?\s*['"]?\w`,
  'm',
);

// Under `set -e` every command is an assertion: the first non-zero status ends the run. A suite
// written that way legitimately carries no failure vocabulary at all.
const ERREXIT = /^\s*set\s+-[a-zA-Z]*e/m;

// A statement that ends SUCCESSFULLY and unconditionally, as a whole line. The keyword is captured
// because `exit` and `return` are not interchangeable: see `emptyContentSkip`.
const SUCCESS_EXIT = /^(exit|return)(?:\s+0)?\s*;?$/;

// The same, matched INSIDE a line, after a `&&`/`||`/`then` the caller has already located.
const INLINE_SUCCESS_EXIT = /(?<![\w-])(exit|return)(?:\s+0)?\s*(?:;|\}|$)/;

// Predicates that mean "the content this suite exists to check is ABSENT", matched by the
// DIRECTION of the test exactly as the C-style and Python halves do. A value equality
// (`[ "$os" = darwin ]`) is a legitimate environment skip and is left alone.
//
// The `(?![\d.])` guards carry the same weight they carry on the C-style side: without them
// `-lt 1` matches the prefix of `-lt 1280`.
const SHELL_ABSENCE_PREDICATES: readonly RegExp[] = [
  /\[\[?\s*-z\s/,
  /\[\[?\s*!\s*-[fdesr]\s/,
  /-eq\s+0(?![\d.])|-lt\s+1(?![\d.])|-le\s+0(?![\d.])/,
  /=\s*"?0"?\s*\]/,
];

// `[ "$fail" -eq 0 ] && exit 0` is a suite REPORTING ITS VERDICT, not skipping itself: the zero it
// compares against is a failure COUNT, so exiting on it is the correct outcome. Without this the
// count-zero predicates above would red the ordinary last line of a passing shell suite, which is
// the false positive most likely to get a blocking gate switched off.
const FAILURE_COUNTER = /(?:fail|err|bad)\w*"?\s*(?:-eq|-lt|-le|=)/i;

// The inverted spelling: a PRESENCE test whose FAILURE arm skips. `[ -n "$x" ] || exit 0` and
// `[ -s "$f" ] || return 0` are the same defect written the other way round, and a rule that knew
// only the `&&` form would miss half the class.
const SHELL_PRESENCE_PREDICATES: readonly RegExp[] = [/\[\[?\s*-[nfdesr]\s/, /-gt\s+0(?![\d.])|-ge\s+1(?![\d.])/];

interface ShellLine {
  text: string;
  // 1-based.
  number: number;
  // Nesting depth of the statements ON this line: 0 means they run unconditionally at the top
  // level.
  depth: number;
  // Does an enclosing block run in a CHILD shell? There `exit` ends the child, not the run.
  subshell: boolean;
}

// `(`/`)` are deliberately absent. A `case` arm terminates with a bare `)`, `$(( ))` and `f()` are
// ordinary, and counting any of them as a block would make the walk wrong in the direction that
// MANUFACTURES findings. The two shapes that genuinely nest without a keyword are handled below,
// as a subshell and as an inline function body.
const BLOCK_TOKENS = /(?<![\w-])(?:if|case|do|fi|esac|done)(?![\w-])|[{}]/g;
const BLOCK_OPENERS = new Set(['if', 'case', 'do', '{']);

// A function DEFINITION whose body opens on this line. The `{` and `}` of a one-line helper cancel
// within the line, so the depth counter alone reads `dump(){ [ -z "$1" ] && return 0; }` as
// top-level control flow -- which is this module's own house idiom for a helper, and was the
// residual false positive the multi-line fix left standing. A DEFINITION, never any `{`:
// `[ -z "$out" ] && { echo "no fixtures"; exit 0; }` is a braced consequent and a real finding.
const FUNCTION_BODY_OPENER =
  /(?:^|[;&])[ \t]*(?:function[ \t]+[A-Za-z_][\w.:-]*(?:[ \t]*\([ \t]*\))?|[A-Za-z_][\w.:-]*[ \t]*\([ \t]*\))[ \t]*[{(]/;

// A loop whose body is the right-hand side of a PIPELINE runs in a child shell, so an `exit` in it
// ends that child and the run continues. `find . | while read -r f; do ... done` is the shape, and
// `||` is not a pipe.
const PIPED_INTO = /(?:^|[^|])\|(?!\|)/;

// Net block depth per line, over the masked code. Approximate by design -- shell has no grammar a
// scanner this small can parse -- and used only to require that a `hard-disable` finding is
// genuinely unconditional. Paired with a column-0 requirement at the call site, so a wrong depth
// alone cannot manufacture a finding.
function shellLines(code: string): ShellLine[] {
  const stack: boolean[] = [];
  return code.split('\n').map((text, index) => {
    const line: ShellLine = {
      text,
      number: index + 1,
      depth: stack.length + (FUNCTION_BODY_OPENER.test(text) ? 1 : 0),
      subshell: stack.includes(true),
    };
    for (const token of text.matchAll(BLOCK_TOKENS)) {
      if (BLOCK_OPENERS.has(token[0])) {
        stack.push(token[0] === 'do' && PIPED_INTO.test(text.slice(0, token.index)));
      } else if (stack.length > 0) {
        stack.pop();
      }
    }
    return line;
  });
}

function violation(
  file: string,
  kind: TestIntegrityViolation['kind'],
  line: number,
  detail: string,
): TestIntegrityViolation {
  return { file, kind, line, detail };
}

export function detectShellTestIntegrityViolations(file: string, source: string): TestIntegrityViolation[] {
  const { code, inString } = scanShellSource(source);
  const lines = shellLines(code);

  // ONE finding per file per kind, matching the other two halves: the fix is the same edit either
  // way, and a gate that prints forty lines for one bad file gets skimmed.
  return [hardDisable(file, lines), emptyContentSkip(file, lines), noAssertion(file, code, inString)].filter(
    (found): found is TestIntegrityViolation => found !== undefined,
  );
}

// A top-level, unconditional `exit 0` with checks still BELOW it. The trailing checks are what make
// this a finding rather than an ordinary end of script: they are dead, so the suite reports green
// having run only the part above the exit.
function hardDisable(file: string, lines: readonly ShellLine[]): TestIntegrityViolation | undefined {
  for (const line of lines) {
    // Column 0 as well as depth 0: the depth walk is approximate, and an indented `exit 0` is
    // almost always inside a function or a branch, where it is ordinary control flow.
    if (line.depth !== 0 || /^\s/.test(line.text) || !SUCCESS_EXIT.test(line.text.trim())) continue;
    if (!lines.some((other) => other.number > line.number && isCheck(other.text))) continue;
    return violation(
      file,
      'hard-disable',
      line.number,
      `\`${line.text.trim()}\` ends this suite unconditionally at the top level while checks remain ` +
        `below it, so those checks never run and the suite reports green having skipped them. Remove ` +
        `the early exit or delete the dead checks.`,
    );
  }
  return undefined;
}

// Anything below an early exit that would have run. A delegating here-doc OPENER counts as one in
// its own right: its body is blanked, so a suite whose only checks live in `python3 - <<PY ... PY`
// had no failure vocabulary left for `dead` to find, and a real top-level `exit 0` above it went
// unreported. Missing a DISABLED suite is the one direction this gate cannot afford, so the opener
// line -- which the masker leaves intact -- stands in for the checks it hides.
function isCheck(text: string): boolean {
  return SHELL_FAILURE_PATTERNS.some((pattern) => pattern.test(text)) || DELEGATING_HEREDOC.test(text);
}

// A skip conditioned on the ABSENCE of the content the suite exists to check.
function emptyContentSkip(file: string, lines: readonly ShellLine[]): TestIntegrityViolation | undefined {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const absent = SHELL_ABSENCE_PREDICATES.some((pattern) => pattern.test(line.text)) && !FAILURE_COUNTER.test(line.text);
    // The inverted form only counts when the `||` is actually there: `[ -n "$x" ] && exit 0` skips
    // when content EXISTS, which is a different thing and not this rule's.
    const inverted = /\|\|/.test(line.text) && SHELL_PRESENCE_PREDICATES.some((p) => p.test(line.text));
    if (!absent && !inverted) continue;
    const skip = skipsWithin(lines, i, absent);
    if (!skip) continue;
    // The same depth-0 / column-0 discipline `hardDisable` has, and for a sharper reason: a
    // `return` ends the FUNCTION, not the run. `[ -z "$d" ] && return` is the commonest guard
    // clause shell offers, and reporting it as "ends this suite" was factually wrong -- an ordinary
    // well-formed suite with one guard-clause helper redded on a blocking gate, which is exactly
    // what gets a gate switched off.
    if (skip === 'return' && (line.depth !== 0 || /^\s/.test(line.text))) continue;
    // `exit` ends the run from wherever it sits -- but only if it really sits in the RUN. Dropping
    // the column-0 guard for it entirely was the mirror mistake: `hardDisable` carries that guard
    // precisely because a subshell body sits at depth 0 (this file ships a test for it), and this
    // rule then contradicted the same semantics. Two shapes indent a line the walk still calls
    // depth 0 -- a `( ... )` group and a `$( ... )` substitution -- and both are a child shell.
    // A `cmd | while read; do` body is a child shell too, at depth 1, which is why the frame
    // records it. Everything genuine (a function body, `if`, `for`, `case`) is still reached.
    if (skip === 'exit' && ((line.depth === 0 && /^\s/.test(line.text)) || line.subshell)) continue;
    return violation(
      file,
      'empty-content-skip',
      line.number,
      `\`${line.text.trim()}\` ends the run SUCCESSFULLY when the content this suite exists to check ` +
        `is absent, so a missing or empty fixture reports green on the failure the suite exists to ` +
        `catch. Assert the content EXISTS instead.`,
    );
  }
  return undefined;
}

// Does the predicate on `lines[index]` lead to a successful exit, and WITH WHICH KEYWORD? Three
// spellings, which is the whole class shell offers: the `&&`/`||` consequent on the same line, a
// one-line `if ...; then exit 0; fi`, and the multi-line `if` block the line opens.
function skipsWithin(lines: readonly ShellLine[], index: number, absent: boolean): 'exit' | 'return' | undefined {
  const { text, depth } = lines[index]!;
  // An absence predicate skips through its `&&` arm; a presence predicate through its `||` arm.
  const operator = text.indexOf(absent ? '&&' : '||');
  const chained = operator === -1 ? null : INLINE_SUCCESS_EXIT.exec(text.slice(operator));
  if (chained) return keyword(chained);
  if (!/(?<![\w-])if(?![\w-])/.test(text)) return undefined;

  const then = text.indexOf('then');
  // Only the `then` arm counts: an `exit 0` in the `else` arm runs when content is PRESENT.
  const oneLine = then === -1 ? null : INLINE_SUCCESS_EXIT.exec(splitBeforeElse(text.slice(then)));
  if (oneLine) return keyword(oneLine);

  for (let i = index + 1; i < lines.length && lines[i]!.depth > depth; i += 1) {
    if (/(?<![\w-])el(?:se|if)(?![\w-])/.test(lines[i]!.text)) return undefined;
    const block = SUCCESS_EXIT.exec(lines[i]!.text.trim());
    if (block) return keyword(block);
  }
  return undefined;
}

function keyword(found: RegExpExecArray): 'exit' | 'return' {
  return found[1] === 'return' ? 'return' : 'exit';
}

function splitBeforeElse(text: string): string {
  return text.split(/(?<![\w-])el(?:se|if)(?![\w-])/)[0] ?? text;
}

// Nothing in the file can produce a non-zero status. See SHELL_FAILURE_PATTERNS for the vocabulary
// and the two exemptions (`set -e`, a delegating here-doc), both of which stand the rule down
// rather than risk a confident false positive.
function noAssertion(file: string, code: string, inString: readonly boolean[]): TestIntegrityViolation | undefined {
  if (ERREXIT.test(code) || DELEGATING_HEREDOC.test(code)) return undefined;
  for (const pattern of SHELL_FAILURE_PATTERNS) {
    const scan = new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
    let hit: RegExpExecArray | null;
    while ((hit = scan.exec(code)) !== null) {
      // A banned-looking token quoted as DATA proves nothing: `echo "no failures"` is not a check.
      if (!inString[hit.index]) return undefined;
    }
  }
  return violation(
    file,
    'no-assertion',
    1,
    'this shell test file contains nothing that can produce a non-zero exit status -- no failure ' +
      'counter, no `exit 1`, no assertion helper -- so it reports green whatever the code under ' +
      'test does. Make it fail on the behaviour it exercises, or delete it.',
  );
}
