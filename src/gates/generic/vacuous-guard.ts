// The `vacuous-guard` rule of the false-green scanner (./test-integrity-detect.ts, which owns the
// types and the entry point, masks the source and calls in here). A leaf beside
// ./python-test-scan.ts and ./shell-test-scan.ts: it reads the masked code and the string mask,
// and knows nothing about files, gates or config.

import type { TestIntegrityViolation } from './test-integrity-types.ts';

// A SKIP IS NOT THE ONLY WAY TO WRITE A FALSE GREEN; the same defect also wears an `if`:
//
//   const picked = pickFallbackTopic(scope, new Set(), corpus);
//   if (picked !== null) {   // null today, so the whole block never runs
//     ...every assertion...
//   }
//
// The guard is a bare existence test on a value the CODE UNDER TEST just returned, so the block
// goes vacuous exactly when that code is broken: the test passes BECAUSE of the defect it exists
// to catch. That is `empty-content-skip` in different clothes, and neither the skip rules in
// ./test-integrity-detect.ts nor assertion-delta see it.
//
// THE WHOLE DIFFICULTY IS PRECISION, so the rule is deliberately narrow. It fires only when ALL of
// these hold:
//   - the condition is a PURE existence test in the PRESENCE direction (`x`, `x !== null`,
//     `x != null`, `x !== undefined`) -- no call, no `&&`/`||`, no comparison to a value. The
//     opposite direction (`!x`, `x === null`) fires exactly when the value is ABSENT, which is an
//     ordinary "handle the bad case" branch, not a vacuous one. A condition carrying a call
//     (`if (fs.existsSync(p))`) is a setup guard and is skipped too;
//   - `x`'s NEAREST preceding WRITE is initialised FROM A CALL, and `x` is not a PARAMETER
//     of any enclosing function. That is what makes it "derived from the code under test" rather
//     than caller-supplied, and it is why a helper taking a flag stays quiet;
//   - the guarded body actually asserts, and there is no `else` (a two-armed conditional asserts
//     either way);
//   - NOTHING ELSE in the guard's own scope asserts UNGUARDED. This is what the finding's own
//     wording -- "asserts ONLY inside an existence guard" -- claims, and until it was checked the
//     rule fired on tests that assert unconditionally right after the guard, where the guard is an
//     ordinary branch and the test still fails when the code under test breaks. Two kinds of
//     assertion do not count. Assertions ON `x` ITSELF are presence proofs, judged by the exemption
//     below, and counting them would let `assert.equal(x, null); if (x) { ... }` -- provably
//     vacuous -- escape. Assertions inside ANOTHER guard of this same shape do not count either,
//     because they are exactly as unreachable: counting them made the rule ANTI-MONOTONE, silent
//     on two of the defect in one test and on three, while reporting the SAME two split across two
//     tests. What this condition still cannot tell apart is an UNRELATED unguarded assertion --
//     `assert.ok(corpus.length > 0)` on a different function suppresses the finding although it
//     catches nothing about `x`. That is an under-report, kept because narrowing it is what
//     re-admits the false positives above.
//
//     ON THE MEASUREMENT BEHIND THAT: on one corpus of 8,439 third-party JS/TS test files this
//     condition removed the majority of THAT CORPUS's false positives and cost none of ITS three
//     true findings. Three findings cannot measure recall, and the anti-monotone shapes above are
//     constructed counter-examples to the general form, so read it as a corpus-scoped observation
//     and nothing wider;
//   - `x` is not already asserted PRESENT, unconditionally, on the way to the guard. This is
//     the exemption, and it matches the DIRECTION of the guard, not just the token:
//     `assert.ok(x)`/`toBeTruthy()` prove truthy, `.to.exist`/`assert.exists(x)` prove neither
//     null nor undefined, and both satisfy any presence guard. `assert.equal(x, null)`,
//     `assert.ok(!x)`, `toBeNull()` and `expect(x).to.be.null` never exempt anything: those assert
//     the value is ABSENT, which is what makes the block provably vacuous. Sentinel proofs are
//     asymmetric, from measurement rather than theory: a NOT-NULL proof (`not.toBeNull()`,
//     `expect(x).not.to.be.null`, `assert.notEqual(x, null)`) also satisfies a bare `if (x)`,
//     because the values these guards wrap are `T | null` returns and reding code that had already
//     applied this rule's own prescribed fix was the single most common false positive measured;
//     a NOT-UNDEFINED proof (`toBeDefined()`) satisfies only a `!== undefined` guard, because
//     `null` IS defined but falsy and is exactly what those calls return. The exemption must also
//     DOMINATE the guard -- its own enclosing block is the guard's block or an ANCESTOR of it, and
//     it is not itself the body of a braceless `if` -- because an assertion nested in its own
//     `if (debug) ...` proves nothing when that condition is false, while one at the top of the
//     test dominates a guard buried in a `try` or a `test.step` and must not be rejected for
//     sitting a level up.
//
// KNOWN, DELIBERATE SCOPE LIMITS, stated so a clean run is not read as more than it is. This is one
// narrow SHAPE, not a general vacuity checker: loops are not scanned (`for (const p of pairs)`
// carries the same risk but has far too many benign instances to gate on), and neither are
// early-exit guards (`if (!x) return;` / `continue;`), which are the idiomatic alternative
// spelling. Nor is every "initialised from a call" spelling recognised as one: the initialiser
// test is a leading `name(` or `a.b(`, so `const m = /re/.exec(s)`, `const u = new URL(x)` and a
// destructured `const { a } = parse(s)` all read as NOT call-derived and their guards are left
// alone.
//
// TWO CLASSES OF GUARD ARE NOT VACUOUS DESPITE PASSING EVERY TEST ABOVE, and they are separable
// from each other, so one is a CHOICE and the other is excluded outright:
//   - a guard registered in a CALLBACK whose failure path is an external timeout
//     (`socket.on('data', ...)` with a `setTimeout(() => done(new Error(...)))`). This one is
//     ACCEPTED, and the acceptance is a choice about THAT class only: every CALLBACK-shaped rule
//     that suppresses it also suppresses guards inside `.map(async () => ...)` callbacks, which is
//     where every measured TRUE finding lives. It is the one measured false positive standing;
//   - a guard whose body asserts nothing but `assert.fail` / `expect.fail` / `assert.ok(false)`.
//     This is a TRIPWIRE: it fails exactly when the guard is TRUE, so an unentered block is the
//     PASSING outcome, and the fix this rule prescribes would make the test always fail. The rule
//     already refuses the mirror spelling (`if (!x) { assert.fail(); }`) by direction, so firing on
//     this one was an asymmetry, not a judgement. It is a BODY-shaped test, not a callback-shaped
//     one, so it separates cleanly -- a `.map(async)` true finding asserts with `assert.equal` and
//     is never touched by it. See TRIPWIRE.
//
// Every one of the limits above is an UNDER-report, which is the direction this file chooses when
// it cannot be sure. THE FIX IS TO ASSERT THE VALUE IS PRESENT, NOT TO DELETE THE GUARD -- which is
// also why `assert.ok(pairs.length >= 1)` before a loop that asserts per pair stays fine.
const GUARD_TRUTHY = /^\s*\(*\s*([A-Za-z_$][\w$]*)\s*\)*\s*$/;
const GUARD_SENTINEL = /^\s*\(*\s*([A-Za-z_$][\w$]*)\s*!==?\s*(null|undefined)\s*\)*\s*$/;
const BODY_ASSERTS = /(?<![\w.$])(?:assert\b|expect\s*\()/;
// A guard whose body asserts NOTHING BUT one of these is a TRIPWIRE, never a vacuity: it fails
// exactly when the guard is TRUE, so the block going unentered is the PASSING outcome the test was
// written for. Reporting one is not just a false positive, it is a false positive whose prescribed
// fix -- assert the value present, then assert unconditionally -- makes the test always fail.
const TRIPWIRE = /(?:assert\s*\.\s*fail|expect\s*\.\s*fail)(?![\w$])|assert\s*\.\s*ok\s*\(\s*false\s*[,)]/y;
const BRACELESS_ASSERT = /^\s*(?:await\s+)?(?:assert\b|expect\s*\()[^;]*;/;

// Every `{ ... }` block in the file, over the comment-blanked code with the string mask consulted.
// A `}` inside a string literal must not close a block: left uncounted, the enclosing-block lookup
// returns nothing, the exemption search silently widens to the whole file, and the rule stops
// checking that file while still reporting clean -- a failure that is always toward silence, which
// is the one direction that cannot be noticed.
//
// `parent` and the ascending `starts` exist for SPEED, not tidiness. A linear scan of every block
// per lookup is quadratic in the file, and this gate reads files up to structure.ts's
// `maxTestFileBytes` (2 MB).
interface BlockIndex {
  // Open-brace index -> matching close-brace index. An unclosed `{` is absent, so it contains
  // nothing -- the same answer the linear scan gave.
  end: ReadonlyMap<number, number>;
  // Open-brace indexes, ascending.
  starts: readonly number[];
  // Open-brace index -> the open-brace index of the block enclosing it.
  parent: ReadonlyMap<number, number>;
  // Open-brace index -> the open-brace index of the OUTERMOST block enclosing it, which is the
  // block itself when it is already top level. The declaration search is bounded by it: it is the
  // widest scope whose code is guaranteed to run before the guard. A declaration at MODULE scope
  // is therefore not seen, and its guard is left alone -- an under-report, which is the direction
  // this file chooses when it has to choose. Filled here rather than walked per candidate: the
  // enclosing block is always pushed before the block it encloses, so its own answer is already
  // known by the time the inner block opens.
  outermost: ReadonlyMap<number, number>;
}

function buildBlockIndex(code: string, inString: readonly boolean[]): BlockIndex {
  const open: number[] = [];
  const end = new Map<number, number>();
  const parent = new Map<number, number>();
  const outermost = new Map<number, number>();
  const starts: number[] = [];
  for (let i = 0; i < code.length; i += 1) {
    if (inString[i]) continue;
    if (code[i] === '{') {
      const enclosing = open[open.length - 1];
      if (enclosing !== undefined) parent.set(i, enclosing);
      outermost.set(i, enclosing === undefined ? i : outermost.get(enclosing)!);
      open.push(i);
      starts.push(i);
    } else if (code[i] === '}') {
      const start = open.pop();
      if (start !== undefined) end.set(start, i);
    }
  }
  return { end, starts, parent, outermost };
}

// The innermost `{ ... }` containing `index`, or undefined at top level.
//
// Blocks nest properly, so the answer is always an ancestor of -- or equal to -- the LAST block
// opened before `index`: any block containing `index` opens before it and closes after it, so it
// also contains that last-opened block. Binary-search for that one, then climb `parent` past the
// siblings that have already closed. O(log n + depth) rather than O(blocks).
function enclosingBlock(index: BlockIndex, at: number): number | undefined {
  let block: number | undefined = index.starts[lowerBound(index.starts, at) - 1];
  while (block !== undefined && (index.end.get(block) ?? -1) < at) block = index.parent.get(block);
  return block;
}

// The number of entries in the ascending `values` that are strictly below `at`, which doubles as
// the insertion point for `at`. Every range question this file asks is two of these subtracted.
function lowerBound(values: readonly number[], at: number): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (values[mid]! < at) low = mid + 1;
    else high = mid;
  }
  return low;
}

// Walks the balanced `(...)` starting at `from`, returning the index just past its `)`, or -1 if it
// never closes. Parens inside strings do not count -- the lesson testSkipArguments learned.
function closeParen(code: string, inString: readonly boolean[], from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i += 1) {
    if (inString[i]) continue;
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Where each function PARAMETER name is in scope. A caller-supplied value is not "derived from the
// code under test", so a guard on one is ordinary defensive code -- and the scope that matters is
// any ENCLOSING one, because the case this exists for is a SHADOWING parameter: `const p = pick()`
// in a `describe` body with `(p) => { if (p) ... }` below it reads as call-derived from the
// declaration and is not.
//
// Read as a per-file index rather than a walk up the block chain per candidate: that walk sliced a
// 300-character window and ran a regex over it ONCE PER ENCLOSING SCOPE PER CANDIDATE, which is
// linear in NESTING DEPTH rather than in file length -- the same quadratic on a different axis,
// and reachable by construction from a deeply nested suite the same way 2 MB is.
//
// Blocks nest properly, so "some enclosing scope declares `identifier`" is a containment question:
// a declaring block `s` encloses `block` exactly when `s <= block` and `s` closes after `block`.
// Both lists below are keyed by name and ascending in `s`, with `maxEnd` the running maximum of
// the close positions, so the question is one binary search plus one lookup.
interface ParameterScopes {
  starts: number[];
  maxEnd: number[];
}

const SIGNATURE = /\(([^()]*)\)\s*(?::[^()]*)?(?:=>\s*)?$/;
// A whole-word name in a parameter list, so a type annotation and a destructured or defaulted
// parameter all yield the names a guard could be reading.
const IDENTIFIER = /(?<![\w.$])[A-Za-z_$][\w$]*/g;

function buildParameterIndex(code: string, index: BlockIndex): Map<string, ParameterScopes> {
  const byName = new Map<string, ParameterScopes>();
  for (const start of index.starts) {
    const signature = SIGNATURE.exec(code.slice(Math.max(0, start - 300), start));
    if (!signature) continue;
    // An unclosed `{` runs to the end of the file, which is what the walk this replaces also saw.
    const closes = index.end.get(start) ?? code.length;
    IDENTIFIER.lastIndex = 0;
    let name: RegExpExecArray | null;
    while ((name = IDENTIFIER.exec(signature[1]!)) !== null) {
      const scopes = byName.get(name[0]) ?? { starts: [], maxEnd: [] };
      byName.set(name[0], scopes);
      scopes.starts.push(start);
      scopes.maxEnd.push(Math.max(closes, scopes.maxEnd[scopes.maxEnd.length - 1] ?? -1));
    }
  }
  return byName;
}

function isEnclosingParameter(
  parameters: ReadonlyMap<string, ParameterScopes>,
  block: number | undefined,
  identifier: string,
): boolean {
  if (block === undefined) return false;
  const scopes = parameters.get(identifier);
  if (!scopes) return false;
  const declaring = lowerBound(scopes.starts, block + 1);
  return declaring > 0 && scopes.maxEnd[declaring - 1]! > block;
}

// NO LOOKUP IN THIS FILE IS LINEAR IN FILE LENGTH PER CANDIDATE, AND ONLY ONE IS LINEAR IN NESTING
// DEPTH. Both indexes below replace a `code.slice(...)` plus a global regex scan that ran for each
// guard found: on a 2 MB file (structure.ts's `maxTestFileBytes`, so reachable by construction from
// a PR) of ordinary `const p = pick(); assert.ok(p); if (p) {...}` blocks wrapped in one
// `describe`, that shape measured 85 s -- fully synchronous, on a gate the runner executes under
// `Promise.all` with no timeout around it, so it blocks every parallel gate too. DENSITY, not size,
// is the trigger: the same 2 MB with the guards spread across separate top-level tests measured
// 1.6 s, which is why "it is bounded by the enclosing block" was not the fix it looked like. A file
// wrapped in a single `describe` -- how most suites in the world are written -- makes that bound
// the whole file.
//
// THE QUADRATIC HAS A SECOND AXIS, and the sentence above is written to be checkable against it:
// walking the block chain per candidate is linear in NESTING DEPTH, not in file length, so it
// survives every fixture built out of a flat suite. Two of the three such walks are gone -- the
// enclosing-parameter test is the index above and `outermost` is filled in the brace pass -- and
// ONE is left: `hasDominatingProof` climbs `parent` from the guard's own block. Its bound is
// O(depth) map lookups per REPORTABLE candidate, and it returns on its first line for any
// identifier the file never proves present, which is most of them. Depth is the axis to measure:
// at a fixed ~250 KB of guards the scan is linear in it, and the budget test below pins BOTH axes
// for that reason.
interface Write {
  at: number;
  // Initialised from a call, i.e. from the code under test rather than from a literal.
  derived: boolean;
}

const DECLARATION = /(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::\s*[^=;]+)?=\s*(?:await\s+)?([^;\n]*)/g;
const ASSIGNMENT = /^[ \t]*([A-Za-z_$][\w$]*)\s*=(?!=)\s*(?:await\s+)?([^;\n]*)/gm;
const CALL_INITIALISER = /^[A-Za-z_$][\w$.]*\s*\(/;
const FUNCTION_INITIALISER = /^(?:function|async)\b/;

// Every WRITE in the file, by identifier, ascending. A plain re-assignment is a write too, and
// reading declarations ONLY made `let p = pick(); p = p ?? fallback();` fire on a value the test
// had just given a default -- the block is not vacuous, because the fallback guarantees it runs.
// The assignment form is anchored to the start of a statement so a `=` inside a string, an argument
// list or a comparison cannot pass for one.
function buildWriteIndex(code: string): Map<string, Write[]> {
  const writes = new Map<string, Write[]>();
  for (const pattern of [DECLARATION, ASSIGNMENT]) {
    pattern.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = pattern.exec(code)) !== null) {
      const initialiser = hit[2]!;
      const write = {
        at: hit.index,
        derived: CALL_INITIALISER.test(initialiser) && !FUNCTION_INITIALISER.test(initialiser),
      };
      const existing = writes.get(hit[1]!);
      if (existing) existing.push(write);
      else writes.set(hit[1]!, [write]);
    }
  }
  // The two patterns are scanned separately, so their hits interleave; the nearest-write lookup
  // binary-searches this list and needs it ascending.
  for (const list of writes.values()) list.sort((a, b) => a.at - b.at);
  return writes;
}

// The NEAREST preceding WRITE decides, call-derived or not: a later redeclaration (a different test
// reusing the name) must be able to clear the verdict again, not just an earlier call-derived one
// setting it once and sticking.
function isCallDerivedLocal(
  writes: ReadonlyMap<string, Write[]>,
  identifier: string,
  from: number,
  at: number,
): boolean {
  const list = writes.get(identifier);
  if (!list) return false;
  // Binary-searched in place: materialising the positions to reuse `lowerBound` would be O(writes)
  // per candidate, which is the quadratic this index exists to remove.
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (list[mid]!.at < at) low = mid + 1;
    else high = mid;
  }
  const nearest = list[low - 1];
  return nearest !== undefined && nearest.at >= from && nearest.derived;
}

// What an assertion PROVES about its subject, which is what decides whether it can exempt a guard.
// Anything that proves the subject ABSENT is not one of these and never becomes a proof.
type ProofKind = 'truthy' | 'exists' | 'not-null' | 'not-undefined';

interface Proof {
  at: number;
  kind: ProofKind;
}

interface AssertionIndex {
  // Ascending positions of EVERY assertion in the file, for "does anything else in this scope
  // assert" range counts.
  all: readonly number[];
  // Ascending positions of the assertions whose first argument is exactly that bare identifier.
  //
  // DELIBERATELY NOT "every assertion whose statement mentions the identifier". That reads
  // `assert.equal(picked.kind, 'x')` AFTER the guard as an assertion about `picked` rather than as
  // the test asserting something else -- but that assertion DEREFERENCES `picked`, so it throws
  // when the value is absent and the defect is caught after all. Measured over 11,096 third-party
  // test files the wider form changed no verdict at all, so it buys nothing against a constructed
  // false positive. The case it was reached for -- a second guard on the SAME value -- is settled
  // by `assertionsOutsideGuards` instead, which does not care what the assertion looks like.
  bySubject: ReadonlyMap<string, number[]>;
  // Presence proofs, by subject then by the block enclosing the proof, so the dominance test is a
  // walk up the guard's own ancestors rather than a scan of the file.
  proofs: ReadonlyMap<string, Map<number | undefined, Proof[]>>;
}

const ASSERTION_HEAD = /(?<![\w.$])(assert|expect)(?![\w$])/g;
// chai's `should` interface: the subject is the RECEIVER, not an argument.
const SHOULD_HEAD = /(?<![\w.$])([A-Za-z_$][\w$]*)\s*\.\s*should(?![\w$])/g;
const MEMBER_CALL = /((?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/y;
// The `!` prefix is captured, not rejected: `assert.ok(!p)` IS an assertion about `p` -- so it is
// not "something else the test asserts" -- while proving the OPPOSITE of presence, so it must
// never become a proof.
const FIRST_ARGUMENT = /\s*(!*)\s*([A-Za-z_$][\w$]*)\s*(?=[,)])/y;
// The matcher chain, to the end of the statement. Deliberately line-bounded: a matcher on the
// next line is not read, which is an under-report, not a wrong answer.
const STATEMENT_TAIL = /[^;\n]*/y;

// `.not.` anywhere in the chain flips the direction of every matcher below it.
const NEGATED = /(?<![\w$])not\s*\./;
// `toBeInstanceOf`, `toMatchObject` and `toHaveProperty` are here for the same reason `assert.ok`
// is: each FAILS on `null` and on `undefined` (there is no instance, no object to match against and
// no property to read), so passing one proves a present, non-null object, which is truthy. Their
// only absence spelling goes through `.not.`, which NEGATED already flips.
//
// `toBeTypeOf` is DELIBERATELY ABSENT despite looking like a sibling. `typeof null` is `'object'`,
// so `expect(x).toBeTypeOf('object')` -- the only spelling measured in the wild -- PASSES on null
// and proves nothing a `!== null` guard needs; and `toBeTypeOf('undefined')` is an outright ABSENCE
// assertion reachable without `.not.`, which no matcher on this list may be. Adding it would be an
// exemption in the wrong DIRECTION, which is precisely what this table refuses.
const TRUTHY_MATCHER =
  /\.(?:toBeTruthy|toBeVisible|toBeAttached|toBeInstanceOf|toMatchObject|toHaveProperty)\s*\(|\.be\.ok(?![\w$])/;
const EXISTS_MATCHER = /\.exists?(?![\w$])/;
const NULL_MATCHER = /\.toBeNull\s*\(|\.be\.null(?![\w$])/;
const UNDEFINED_MATCHER = /\.toBeUndefined\s*\(|\.be\.undefined(?![\w$])/;
const DEFINED_MATCHER = /\.toBeDefined\s*\(/;
const NULL_ARGUMENT = /^,\s*null\s*[,)]/;
const UNDEFINED_ARGUMENT = /^,\s*undefined\s*[,)]/;

// `expect(x)...` and `x.should...`, which name the subject once and then say what they prove in a
// chain. The direction rule lives here: a matcher only proves presence in the direction its own
// negation puts it.
function chainedProof(tail: string): ProofKind | undefined {
  const negated = NEGATED.test(tail);
  if (TRUTHY_MATCHER.test(tail)) return negated ? undefined : 'truthy';
  if (EXISTS_MATCHER.test(tail)) return negated ? undefined : 'exists';
  if (NULL_MATCHER.test(tail)) return negated ? 'not-null' : undefined;
  if (UNDEFINED_MATCHER.test(tail)) return negated ? 'not-undefined' : undefined;
  if (DEFINED_MATCHER.test(tail)) return negated ? undefined : 'not-undefined';
  return undefined;
}

// `assert(x)` and the `assert.*` interfaces, where the method name says what is proved. chai's
// spellings are here because chai is the assertion library of the mocha ecosystem this gate runs
// against, and their absence made the rule red suites that had already applied its prescribed fix.
function assertProof(method: string, tail: string): ProofKind | undefined {
  // `instanceOf` and `isObject` both fail on `null` and on `undefined`, so each proves a present
  // object. Their absence spellings are DIFFERENT METHOD NAMES (`notInstanceOf`, `isNotObject`),
  // not a `.not.` in the chain, so neither reaches these clauses.
  if (method === '' || method === 'ok' || method === 'isOk' || method === 'instanceOf' || method === 'isObject') {
    return 'truthy';
  }
  if (method === 'exists') return 'exists';
  if (method === 'isNotNull') return 'not-null';
  if (method === 'isDefined' || method === 'isNotUndefined') return 'not-undefined';
  if (method === 'notEqual' || method === 'notStrictEqual') {
    if (NULL_ARGUMENT.test(tail)) return 'not-null';
    if (UNDEFINED_ARGUMENT.test(tail)) return 'not-undefined';
  }
  return undefined;
}

interface AssertionSite {
  at: number;
  subject?: string;
  proof?: ProofKind;
}

// Every `assert...(x)`, `expect(x)...` and `x.should...` in the file, in one pass. The subject is
// read only when the first argument is a BARE identifier, which is the only form the guard rules
// ask about; anything else is still an assertion, just not one about a named value.
function collectAssertionSites(code: string, inString: readonly boolean[]): AssertionSite[] {
  const sites: AssertionSite[] = [];

  ASSERTION_HEAD.lastIndex = 0;
  let head: RegExpExecArray | null;
  while ((head = ASSERTION_HEAD.exec(code)) !== null) {
    if (inString[head.index]) continue;
    MEMBER_CALL.lastIndex = head.index + head[0].length;
    // A mention rather than a call (`import assert from 'node:assert'`) asserts nothing.
    const call = MEMBER_CALL.exec(code);
    if (!call) continue;
    FIRST_ARGUMENT.lastIndex = MEMBER_CALL.lastIndex;
    const argument = FIRST_ARGUMENT.exec(code);
    STATEMENT_TAIL.lastIndex = argument ? FIRST_ARGUMENT.lastIndex : MEMBER_CALL.lastIndex;
    const tail = STATEMENT_TAIL.exec(code)![0];
    const subject = argument?.[2];
    const negated = (argument?.[1]?.length ?? 0) % 2 === 1;
    const proof =
      subject === undefined || negated
        ? undefined
        : head[1] === 'assert'
          ? assertProof(call[1]!.replace(/[\s.]/g, ''), tail)
          : chainedProof(tail);
    sites.push({ at: head.index, subject, proof });
  }

  SHOULD_HEAD.lastIndex = 0;
  while ((head = SHOULD_HEAD.exec(code)) !== null) {
    if (inString[head.index]) continue;
    STATEMENT_TAIL.lastIndex = SHOULD_HEAD.lastIndex;
    sites.push({ at: head.index, subject: head[1]!, proof: chainedProof(STATEMENT_TAIL.exec(code)![0]) });
  }

  sites.sort((a, b) => a.at - b.at);
  return sites;
}

function buildAssertionIndex(code: string, inString: readonly boolean[], index: BlockIndex): AssertionIndex {
  const all: number[] = [];
  const bySubject = new Map<string, number[]>();
  const proofs = new Map<string, Map<number | undefined, Proof[]>>();
  for (const site of collectAssertionSites(code, inString)) {
    all.push(site.at);
    if (site.subject === undefined) continue;
    const positions = bySubject.get(site.subject);
    if (positions) positions.push(site.at);
    else bySubject.set(site.subject, [site.at]);
    // A proof that is itself the body of a braceless `if` proves nothing when that condition is
    // false, so it never enters the index.
    if (site.proof === undefined || isBracelessIfBody(code, inString, site.at)) continue;
    const block = enclosingBlock(index, site.at);
    const byBlock = proofs.get(site.subject) ?? new Map<number | undefined, Proof[]>();
    proofs.set(site.subject, byBlock);
    const inBlock = byBlock.get(block);
    if (inBlock) inBlock.push({ at: site.at, kind: site.proof });
    else byBlock.set(block, [{ at: site.at, kind: site.proof }]);
  }
  return { all, bySubject, proofs };
}

// Does a proof of this kind settle a guard with this sentinel? See the header for why the two
// sentinel directions are not mirror images of each other.
function satisfies(proof: ProofKind, sentinel: string | undefined): boolean {
  if (proof === 'truthy' || proof === 'exists') return true;
  return sentinel === 'undefined' ? proof === 'not-undefined' : proof === 'not-null';
}

// An assertion that is itself the body of a braceless `if` proves nothing when that condition is
// false, and the brace map cannot see that shape at all -- there is no brace. So the text before
// the exemption is walked back through one balanced `(...)` to check for an `if` in front of it.
function isBracelessIfBody(code: string, inString: readonly boolean[], at: number): boolean {
  // Walked character by character rather than over `code.slice(0, at)`: that slice plus a `\s+$`
  // trim on it was, measured, 33 of the 34 seconds this rule spent on a 2 MB file.
  let i = skipSpaceBackwards(code, at - 1);
  if (i < 0 || code[i] !== ')') return false;
  let depth = 0;
  for (; i >= 0; i -= 1) {
    if (inString[i]) continue;
    if (code[i] === ')') depth += 1;
    else if (code[i] === '(') {
      depth -= 1;
      if (depth === 0) return endsWithWord(code, skipSpaceBackwards(code, i - 1), 'if');
    }
  }
  return false;
}

function skipSpaceBackwards(code: string, from: number): number {
  let i = from;
  while (i >= 0 && /\s/.test(code[i]!)) i -= 1;
  return i;
}

// Does `code` end at `at` (inclusive) with the whole word `word`?
function endsWithWord(code: string, at: number, word: string): boolean {
  const start = at - word.length + 1;
  return start >= 0 && code.slice(start, at + 1) === word && !/[\w.$]/.test(code[start - 1] ?? '');
}

interface Guard {
  identifier: string;
  // The literal a `!==` guard compares against, which decides which proofs can exempt it.
  sentinel?: string;
}

// `else if (...)` and `if (...) { } else`, found without slicing the file either side of the guard.
// The obvious `/else\s*$/.test(code.slice(0, at))` and `/^\s*else\b/.test(code.slice(at))` are each
// O(file) per candidate, which is quadratic over a file this gate reads up to 2 MB of.
function precededByElse(code: string, at: number): boolean {
  return endsWithWord(code, skipSpaceBackwards(code, at - 1), 'else');
}

function followedByElse(code: string, at: number): boolean {
  let i = at;
  while (i < code.length && /\s/.test(code[i]!)) i += 1;
  return code.startsWith('else', i) && !/[\w$]/.test(code[i + 4] ?? '');
}

// A PURE existence test in the PRESENCE direction, and nothing else. `!x`, `x === null` and any
// condition carrying a call or an operator return undefined and are left alone -- see the header.
function guardCondition(condition: string): Guard | undefined {
  const truthy = GUARD_TRUTHY.exec(condition);
  if (truthy) return { identifier: truthy[1]! };
  const compared = GUARD_SENTINEL.exec(condition);
  return compared ? { identifier: compared[1]!, sentinel: compared[2]! } : undefined;
}

// The guarded statement: a `{ ... }` block, or a single braceless assertion (`if (x) await
// expect(...)`). Returns nothing unless the body actually asserts -- a guard around logging is
// not a test at all.
function guardedBody(
  code: string,
  index: BlockIndex,
  conditionEnd: number,
): { start: number; end: number } | undefined {
  // Both walks stay off `code.slice(conditionEnd)`: slicing the file tail once per candidate is
  // the quadratic this rule keeps growing back. The braceless window stops at the first `;`, which
  // is exactly where BRACELESS_ASSERT's own `[^;]*;` would have stopped.
  let start = conditionEnd;
  while (start < code.length && /\s/.test(code[start]!)) start += 1;
  const semicolon = code.indexOf(';', start);
  const end =
    code[start] === '{'
      ? (index.end.get(start) ?? -1) + 1
      : start +
        (semicolon === -1 ? 0 : (BRACELESS_ASSERT.exec(code.slice(start, semicolon + 1))?.[0].length ?? 0));
  if (end <= start || !BODY_ASSERTS.test(code.slice(start, end))) return undefined;
  return { start, end };
}

// The assertions that are NOT inside ANY guard this file has judged unreachable-when-broken --
// which is what "does the test assert when the guard is false" has to be asked about.
//
// COUNTING EVERY OTHER ASSERTION IN THE BLOCK MADE THE RULE ANTI-MONOTONE: a second vacuous guard's
// assertions are "something else the test asserts", so two of the defect in one test reported
// nothing while the SAME two split across two tests reported one, and three reported nothing at
// all -- silence in exactly the case where nothing is asserted unless several separate calls all
// return non-null. Excluding the candidate bodies removes that. They are sorted and merged first
// rather than taken as given: a guard nested inside another guard's body OVERLAPS it, and the sweep
// below would double-count or skip against unordered, overlapping spans.
//
// A TRIPWIRE body belongs in this set too even though it is never itself reported: `assert.fail`
// runs only on the path that FAILS the test, so it says nothing about what a green run asserted.
interface OutsideGuards {
  all: readonly number[];
  onSubject(identifier: string): readonly number[];
}

function assertionsOutsideGuards(
  assertions: AssertionIndex,
  bodies: readonly { start: number; end: number }[],
): OutsideGuards {
  const spans = [...bodies].sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ start: span.start, end: span.end });
  }
  const onSubject = new Map<string, readonly number[]>();
  return {
    all: outsideSpans(assertions.all, merged),
    onSubject(identifier: string): readonly number[] {
      const known = onSubject.get(identifier);
      if (known) return known;
      const kept = outsideSpans(assertions.bySubject.get(identifier) ?? [], merged);
      onSubject.set(identifier, kept);
      return kept;
    },
  };
}

// The ascending `positions` that fall in none of the merged, ascending `spans`. One sweep, so the
// whole file's answer costs what a single per-candidate range scan used to.
function outsideSpans(positions: readonly number[], spans: readonly { start: number; end: number }[]): number[] {
  const kept: number[] = [];
  let span = 0;
  for (const at of positions) {
    while (span < spans.length && spans[span]!.end <= at) span += 1;
    if (span === spans.length || at < spans[span]!.start) kept.push(at);
  }
  return kept;
}

// Does anything OTHER than a guarded body assert, in the scope the guard sits in? If so the test
// still asserts when the guard is false, so it is not the false green this rule reports -- see the
// header. Assertions on the guard's own identifier are not counted: those are presence proofs,
// judged by direction elsewhere, and counting them would let the provably vacuous
// `assert.equal(x, null); if (x) { ... }` escape.
function assertsBeyondGuard(outside: OutsideGuards, scope: { start: number; end: number }, identifier: string): boolean {
  const beyond = countInRange(outside.all, scope.start, scope.end);
  const onIdentifier = countInRange(outside.onSubject(identifier), scope.start, scope.end);
  return beyond - onIdentifier > 0;
}

function countInRange(positions: readonly number[], from: number, to: number): number {
  return lowerBound(positions, to) - lowerBound(positions, from);
}

// Is the guard's own predicate already proved, unconditionally, on every path that reaches the
// guard? That means the proof's own enclosing block is the guard's block or an ANCESTOR of it --
// an `assert.ok(x)` at the top of the test dominates a guard buried in a `try` or a `test.step`,
// and rejecting it would red code that had already applied the documented fix. What it must NOT
// accept is a proof in a SIBLING block, which is how an `assert.ok(x)` in a DIFFERENT test would
// otherwise exempt this one.
function hasDominatingProof(
  assertions: AssertionIndex,
  index: BlockIndex,
  block: number | undefined,
  span: { guard: number; bodyEnd: number },
  guard: Guard,
): boolean {
  const byBlock = assertions.proofs.get(guard.identifier);
  if (!byBlock) return false;
  // A guard at top level is dominated only by a proof at top level; one inside a block is
  // dominated by its own block and every ancestor, and by nothing outside them.
  let scope = block;
  for (;;) {
    for (const proof of byBlock.get(scope) ?? []) {
      // A proof inside the block being judged is exactly the assertion whose reachability is in
      // question.
      if (proof.at >= span.guard && proof.at < span.bodyEnd) continue;
      if (satisfies(proof.kind, guard.sentinel)) return true;
    }
    if (scope === undefined) return false;
    const parent = index.parent.get(scope);
    if (parent === undefined) return false;
    scope = parent;
  }
}

// Does the guarded body assert nothing but tripwires? See TRIPWIRE. `should` heads are read too,
// so a body mixing `assert.fail` with `p.should.equal(1)` is not one. An assertion the mask says is
// inside a string is not read at all, so a body whose only `assert` is quoted counts as tripwire
// -- an under-report on a block that asserts nothing, which is the right answer anyway.
function assertsOnlyTripwires(
  code: string,
  inString: readonly boolean[],
  body: { start: number; end: number },
): boolean {
  for (const pattern of [ASSERTION_HEAD, SHOULD_HEAD]) {
    pattern.lastIndex = body.start;
    let head: RegExpExecArray | null;
    while ((head = pattern.exec(code)) !== null && head.index < body.end) {
      if (inString[head.index]) continue;
      TRIPWIRE.lastIndex = head.index;
      if (!TRIPWIRE.test(code)) return false;
    }
  }
  return true;
}

// The candidate at an `if (`, decided from syntax alone: a pure presence test whose body asserts
// and has no `else`. Everything past this point needs the file-wide indexes, so this is the filter
// that keeps most files from ever building them.
function candidateGuard(
  code: string,
  inString: readonly boolean[],
  index: BlockIndex,
  at: number,
  openerLength: number,
): { guard: Guard; condition: string; body: { start: number; end: number } } | undefined {
  const conditionEnd = closeParen(code, inString, at + openerLength - 1);
  if (conditionEnd === -1) return undefined;
  const condition = code.slice(at + openerLength, conditionEnd - 1);
  const guard = guardCondition(condition);
  if (!guard) return undefined;
  const body = guardedBody(code, index, conditionEnd);
  // A two-armed conditional asserts either way, so it is never vacuous.
  if (!body || followedByElse(code, body.end)) return undefined;
  return { guard, condition, body };
}

// A guard that has survived every test that judges it ALONE. Whether the test asserts anything
// beyond it is decided afterwards, because that answer depends on the other candidates in the file.
interface Candidate {
  at: number;
  guard: Guard;
  condition: string;
  body: { start: number; end: number };
  scope: { start: number; end: number };
  // A tripwire body is never reported, but its assertions are still guarded ones -- see
  // `assertionsOutsideGuards`.
  reportable: boolean;
}

// The span the "does anything else in here assert" question is asked over: the guard's own
// enclosing block, or the whole file when the guard is at top level.
function guardScope(code: string, index: BlockIndex, block: number | undefined): { start: number; end: number } {
  if (block === undefined) return { start: 0, end: code.length };
  return { start: block, end: index.end.get(block) ?? code.length };
}

// Every guard in the file that survives the tests that judge it ALONE, in source order, with the
// assertion index those tests had to build. Separate from the report below because the LAST
// condition -- whether the test asserts anything beyond the guards -- is a question about the whole
// list rather than about any one entry, and cannot be answered until the list is complete.
function collectCandidates(
  code: string,
  inString: readonly boolean[],
  index: BlockIndex,
): { candidates: Candidate[]; assertions: AssertionIndex | undefined } {
  const opener = /(?<![\w.$])if\s*\(/g;
  let match: RegExpExecArray | null;
  // Every index here is O(file) to build and is wanted only once a candidate has survived the cheap
  // syntactic tests, which most files never produce.
  let parameters: Map<string, ParameterScopes> | undefined;
  let writes: Map<string, Write[]> | undefined;
  let assertions: AssertionIndex | undefined;
  const candidates: Candidate[] = [];

  while ((match = opener.exec(code)) !== null) {
    // `else if` is one arm of a two-armed conditional; the other arm still runs.
    if (inString[match.index] || precededByElse(code, match.index)) continue;

    const candidate = candidateGuard(code, inString, index, match.index, match[0].length);
    if (!candidate) continue;
    const { guard, condition, body } = candidate;

    const block = enclosingBlock(index, match.index);
    parameters ??= buildParameterIndex(code, index);
    if (isEnclosingParameter(parameters, block, guard.identifier)) continue;
    const outermost = block === undefined ? undefined : index.outermost.get(block);
    writes ??= buildWriteIndex(code);
    if (!isCallDerivedLocal(writes, guard.identifier, outermost ?? 0, match.index)) continue;

    assertions ??= buildAssertionIndex(code, inString, index);
    if (hasDominatingProof(assertions, index, block, { guard: match.index, bodyEnd: body.end }, guard)) continue;

    candidates.push({
      at: match.index,
      guard,
      condition,
      body,
      scope: guardScope(code, index, block),
      reportable: !assertsOnlyTripwires(code, inString, body),
    });
  }

  return { candidates, assertions };
}

export function detectVacuousGuards(
  file: string,
  code: string,
  inString: readonly boolean[],
): TestIntegrityViolation | undefined {
  const { candidates, assertions } = collectCandidates(code, inString, buildBlockIndex(code, inString));
  if (!assertions) return undefined;
  const outside = assertionsOutsideGuards(assertions, candidates.map((candidate) => candidate.body));
  for (const candidate of candidates) {
    if (!candidate.reportable) continue;
    if (assertsBeyondGuard(outside, candidate.scope, candidate.guard.identifier)) continue;

    return {
      file,
      kind: 'vacuous-guard',
      line: lineOf(code, candidate.at),
      detail:
        `asserts only inside an existence guard (\`if (${candidate.condition.trim().replace(/\s+/g, ' ')})\`) on a ` +
        `value the code under test returned; the block goes vacuous exactly when that code breaks, so the ` +
        `test passes BECAUSE of the defect. Assert \`${candidate.guard.identifier}\` is present first, then ` +
        `assert unconditionally.`,
    };
  }
  return undefined;
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i += 1) if (source[i] === '\n') line += 1;
  return line;
}
