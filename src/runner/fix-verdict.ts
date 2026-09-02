// The `fix` stage's own verdict on the round it just ran, produced runner-side in finalize and
// carried back to the control plane on the fix-report artifact.
//
// WHY THIS EXISTS (TEK-3784). Before it, a fix attempt could report exactly two things: it
// changed something, or it failed. It had no way to say "this finding is itself wrong", and
// nothing distinguished removing a SYMPTOM from fixing a CAUSE. Handed a finding it could not
// legitimately satisfy -- the seo site-crawl gate reporting "unresolved template markers
// {{ secrets.SF_JWT_KEY_QA }}" against a `<pre><code>` GitHub Actions sample in an article ABOUT
// writing GitHub Actions -- the fixer took the finding as ground truth and edited the article
// until the regex went quiet. Round one replaced `${{ secrets.SF_JWT_KEY_QA }}` with a literal
// `your-qa-jwt-private-key`, publishing a tutorial that shows readers pasting a JWT private key
// straight into a workflow file. Round two restored the same lines HTML-ENTITY-ESCAPED
// (`$&#123;&#123; ... &#125;&#125;`), which renders identically to a reader while no longer
// matching the guard. Both merged.
//
// So this module gives the fixer the two missing vocabulary items:
//   * DISPUTE -- a terminal outcome that changes NOTHING and says, with evidence, that the
//     finding looks like a false positive. The control plane escalates it to a human. Without
//     this the fixer's only non-failure exit was "produce a diff", which is what drove it to
//     damage the artifact.
//   * EVASION -- a deterministic rejection of a "fix" that only re-encoded the artifact. A check
//     that stops firing is not the same as a problem that is fixed; this is the same family as
//     the standing rules "every gate must fail its own step" and "required e2e must assert
//     content exists, never skip on empty".
//
// Both are computed from data the runner already has in hand at finalize time: a file the fixer
// wrote into the checkout, and the fix commit's own diff.

import { readFile } from 'node:fs/promises';

import type { FixDispute, FixEvasion, FixVerdict } from '../contracts/types.ts';
import { runCommand } from '../gates/exec.ts';

// Where a fix stage writes its dispute, at the root of the customer checkout. Deliberately a
// VISIBLE filename, not a dotfile: action.yml excludes it from the fix commit so a dispute
// really does change nothing, and if that exclusion ever regresses a human sees the stray file
// in the PR immediately instead of it hiding in a dot-path.
export const FIX_DISPUTE_FILE = 'autopilot-fix-dispute.json';

// The artifact file finalize writes for the control plane (mirrors the gate stage's
// gate-report.json). Written AFTER the commit-and-push step, so it is never committed.
export const FIX_REPORT_FILE = 'fix-report.json';

// Caps on what one model-written dispute can push into a tracker comment and a blockedReason.
// Same reasoning as ci-runner.ts's MAX_REVIEW_FINDINGS: a runaway report must be bounded where
// it is parsed, not where it is rendered.
const MAX_DISPUTES = 20;
const MAX_DISPUTE_FIELD_CHARS = 2_000;
const MAX_EVASIONS = 50;

// ---------------------------------------------------------------------------------------
// Rendered text
// ---------------------------------------------------------------------------------------

// The named HTML entities worth decoding here. Not the full HTML5 table (~2,200 names): this is
// the set that actually appears in hand-written or model-written escaping, plus the ones a
// matcher-evasion would reach for. An unrecognised name is left alone, which is the safe
// direction -- it can only make two texts compare as DIFFERENT, never as falsely identical.
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  lbrace: '{', rbrace: '}', lcub: '{', rcub: '}',
  lpar: '(', rpar: ')', lsqb: '[', rsqb: ']', lbrack: '[', rbrack: ']',
  dollar: '$', commat: '@', num: '#', percnt: '%', ast: '*', plus: '+',
  sol: '/', bsol: '\\', verbar: '|', colon: ':', semi: ';', period: '.',
  comma: ',', excl: '!', quest: '?', equals: '=', hyphen: '-', lowbar: '_',
  grave: '`', tilde: '~', circ: '^', dash: '‐',
};

// Invisible characters that carry no rendered glyph. Zero-width space/non-joiner/joiner, the
// BOM/zero-width no-break space, the word joiner, the soft hyphen, the Mongolian vowel
// separator, and the bidi embedding/override/isolate controls. Inserting any of these into a
// token breaks a source-text matcher while leaving the reader's view untouched.
const INVISIBLE_CHARS = /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

// Latin lookalikes for the Cyrillic and Greek letters an evasion would substitute. NFKC (applied
// below) does NOT fold these -- they are distinct letters, not compatibility forms -- so they
// need an explicit table. Deliberately small: only the glyphs that are visually identical to a
// Latin letter in the fonts a site actually renders in. Being incomplete is a stated limit, not
// a bug: an unlisted homoglyph makes two texts compare DIFFERENT, so it is missed, never
// mis-flagged.
const HOMOGLYPHS: Readonly<Record<string, string>> = {
  // Cyrillic
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y',
  'х': 'x', 'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M',
  'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'У': 'Y',
  'Х': 'X', 'і': 'i', 'Ѕ': 'S', 'ѕ': 's', 'ј': 'j', 'һ': 'h',
  // Greek
  'ο': 'o', 'Α': 'A', 'Β': 'B', 'Ε': 'E', 'Ζ': 'Z', 'Η': 'H',
  'Ι': 'I', 'Κ': 'K', 'Μ': 'M', 'Ν': 'N', 'Ο': 'O', 'Ρ': 'P',
  'Τ': 'T', 'Υ': 'Y', 'Χ': 'X', 'α': 'a',
};

const ENTITY = /&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,30});/g;

function decodeEntity(body: string): string | undefined {
  if (body.startsWith('#')) {
    const isHex = body[1] === 'x' || body[1] === 'X';
    const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
    // Surrogate halves and out-of-range code points are not text; leave them encoded rather
    // than producing a lone surrogate that would corrupt every downstream comparison.
    if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return undefined;
    if (code >= 0xd800 && code <= 0xdfff) return undefined;
    return String.fromCodePoint(code);
  }
  return NAMED_ENTITIES[body];
}

// What a reader actually sees, as closely as a deterministic pass can get: entities decoded,
// invisibles dropped, homoglyphs folded to their Latin twins, and NFKC applied (which folds
// fullwidth forms, the mathematical alphanumerics, and ligatures).
//
// Entity decoding is a SINGLE non-overlapping pass, and that is correct rather than lazy: a
// browser also decodes once, so `&amp;#123;` renders as the literal text "&#123;", not as "{".
// Decoding repeatedly would make those two compare equal when a reader sees different things.
export function renderedText(source: string): string {
  const decoded = source.replace(ENTITY, (whole, body: string) => decodeEntity(body) ?? whole);
  const folded = [...decoded.replace(INVISIBLE_CHARS, '')].map((ch) => HOMOGLYPHS[ch] ?? ch).join('');
  return folded.normalize('NFKC');
}

// ---------------------------------------------------------------------------------------
// Evasion detection
// ---------------------------------------------------------------------------------------

/** One changed file of the fix commit: its content before the round and after it. */
export interface FixFileDiff {
  path: string;
  /** Content at the fix grant's base. Empty string for a file the fix created. */
  before: string;
  /** Content at the fix commit. Empty string for a file the fix deleted. */
  after: string;
}

// The characters HTML text actually requires escaping for. Escaping anything ELSE -- a brace, a
// dollar, a letter -- buys no rendering correctness whatsoever, so its only effect is to change
// what a SOURCE-text matcher sees while leaving the reader's view byte-identical. That is the
// whole of the stage-two behaviour (`$&#123;&#123; ... &#125;&#125;`), and it is why this rule
// can be sharp instead of a heuristic: `&amp;`/`&lt;`/`&gt;`/`&quot;`/`&apos;` are ordinary HTML
// hygiene and are never flagged, and everything else is gratuitous by construction.
const HTML_STRUCTURAL = new Set(['&', '<', '>', '"', "'"]);

function gratuitousEntitiesIn(line: string): string[] {
  const found: string[] = [];
  for (const match of line.matchAll(ENTITY)) {
    const decoded = decodeEntity(match[1]!);
    if (decoded === undefined || HTML_STRUCTURAL.has(decoded)) continue;
    found.push(match[0]);
  }
  return found;
}

function invisiblesIn(line: string): string[] {
  return [...line.matchAll(INVISIBLE_CHARS)].map((m) => `U+${m[0]!.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
}

function homoglyphsIn(line: string): string[] {
  return [...line].filter((ch) => HOMOGLYPHS[ch] !== undefined).map((ch) => `U+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`);
}

function uniq(values: string[]): string[] {
  return [...new Set(values)];
}

// The line with ONLY its structural entities decoded. Two lines that agree under this but differ
// as source differ solely in whether `&`/`<`/`>`/`"`/`'` are spelled raw or escaped -- which is
// what HTML escaping IS FOR, and is the one way to change the source without changing the
// rendering that is not an evasion. Everything else survives the transform and still compares
// as different.
function structuralFormOf(line: string): string {
  return line.replace(ENTITY, (whole, body: string) => {
    const decoded = decodeEntity(body);
    return decoded !== undefined && HTML_STRUCTURAL.has(decoded) ? decoded : whole;
  });
}

// Multiset difference over lines: the lines present in `a` that `b` does not also have, counting
// duplicates. A real LCS diff would name hunks more precisely, but for this question -- "did any
// line get REPLACED by a differently-encoded twin" -- the multiset is enough and has no
// alignment heuristics to get wrong.
function lineDelta(a: string[], b: string[]): string[] {
  const counts = new Map<string, number>();
  for (const line of b) counts.set(line, (counts.get(line) ?? 0) + 1);
  const out: string[] = [];
  for (const line of a) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else out.push(line);
  }
  return out;
}

function clip(text: string, limit = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

// Every way this round's diff re-encodes the artifact instead of changing it.
//
// Two independent signals, because they catch the two halves of the observed incident:
//
//   RENDERED NO-OP -- a line was replaced by one that renders identically. The source moved, the
//   reader's view did not. The one legitimate reason to do that is escaping an HTML-structural
//   character (`&` -> `&amp;`), which is what escaping is FOR, so a pair that agrees once those
//   are decoded is skipped. Any OTHER rendered-identical swap is an evasion.
//
//   GRATUITOUS ESCAPE -- an added line introduces entity escapes for characters HTML does not
//   require escaping (or invisibles, or homoglyphs) that the file did not contain before. This is
//   the signal that catches stage two on its own round: the fixer RESTORED the original lines, so
//   the round genuinely changed what renders and the rendered-no-op test alone would have passed
//   it. What gives it away is that the restored text was spelled `$&#123;&#123;` -- an encoding
//   with no rendering purpose, introduced by this round, on a line the guard had complained about.
//
// A file the fix DELETED is not scanned: deleting content is a real change to what renders, and
// there are no added lines to have encoded anything.
export function findEvasions(diffs: readonly FixFileDiff[]): FixEvasion[] {
  const evasions: FixEvasion[] = [];

  for (const diff of diffs) {
    if (diff.after.length === 0) continue;
    const beforeLines = diff.before.split('\n');
    const afterLines = diff.after.split('\n');
    const added = lineDelta(afterLines, beforeLines);
    const removed = lineDelta(beforeLines, afterLines);

    // lineDelta subtracts literal equals, so an added line can never be byte-identical to a
    // removed one. A rendered match between the two is therefore always an encoding-only swap.
    const removedByRender = new Map<string, string>();
    for (const line of removed) {
      const key = renderedText(line);
      if (!removedByRender.has(key)) removedByRender.set(key, line);
    }

    for (const line of added) {
      const twin = removedByRender.get(renderedText(line));
      // Escaping a bare `&` into `&amp;` renders the same and IS the correct change -- flagging it
      // would reject real HTML hygiene as an evasion. Only a rendered-identical pair that still
      // differs once structural escaping is normalised away has changed the encoding for some
      // reason other than encoding.
      if (twin !== undefined && structuralFormOf(twin) !== structuralFormOf(line)) {
        evasions.push({
          kind: 'rendered-no-op',
          path: diff.path,
          detail:
            `line re-encoded without changing what it renders: "${clip(twin)}" became "${clip(line)}", ` +
            `which a reader cannot tell apart`,
        });
        continue;
      }
      if (twin !== undefined) continue;

      // Only encodings this round INTRODUCED count. A file that already spelled something with
      // entities keeps doing so without being blamed for it, so pre-existing escaping in the
      // artifact is not a finding -- only escaping the fixer just added.
      const newEntities = uniq(gratuitousEntitiesIn(line)).filter((e) => !diff.before.includes(e));
      const newInvisibles = uniq(invisiblesIn(line)).filter((code) => !invisiblesIn(diff.before).includes(code));
      const newHomoglyphs = uniq(homoglyphsIn(line)).filter((code) => !homoglyphsIn(diff.before).includes(code));
      const introduced = [...newEntities, ...newInvisibles, ...newHomoglyphs];
      if (introduced.length > 0) {
        evasions.push({
          kind: 'gratuitous-escape',
          path: diff.path,
          detail:
            `line introduces encoding with no rendering effect (${introduced.slice(0, 8).join(', ')}): ` +
            `"${clip(line)}". Escaping characters HTML does not require escaping changes only what a ` +
            `source-text matcher sees, not what a reader sees`,
        });
      }
      if (evasions.length >= MAX_EVASIONS) return evasions.slice(0, MAX_EVASIONS);
    }
  }

  return evasions;
}

// ---------------------------------------------------------------------------------------
// Dispute file
// ---------------------------------------------------------------------------------------

function clipField(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_DISPUTE_FIELD_CHARS ? `${trimmed.slice(0, MAX_DISPUTE_FIELD_CHARS)}...` : trimmed;
}

// Parse the fixer's dispute file: `{ "disputes": [{ "finding": "...", "evidence": "..." }] }`.
//
// BOTH fields are required and a row missing either is DROPPED. That is deliberate and it is the
// safe direction here, the opposite of a fail-closed parse elsewhere: an accepted dispute STOPS
// the pipeline and calls a human, so an evidence-free assertion must not be able to do that. A
// fixer that wants out of a finding has to say which finding and why. Dropping every row leaves
// `[]`, which reads as "no dispute" and lets the round be judged on its diff as usual.
export function parseFixDisputeFile(text: string): FixDispute[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const raw = (parsed as { disputes?: unknown })?.disputes;
  if (!Array.isArray(raw)) return [];

  const disputes: FixDispute[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const finding = clipField(e.finding);
    const evidence = clipField(e.evidence);
    if (!finding || !evidence) continue;
    disputes.push({ finding, evidence });
    if (disputes.length >= MAX_DISPUTES) break;
  }
  return disputes;
}

// ---------------------------------------------------------------------------------------
// Reading the round from the checkout
// ---------------------------------------------------------------------------------------

// Files larger than this are not scanned for evasion. A 2MB minified bundle or a generated
// lockfile has no rendered text to compare, and holding several of them in memory line-split is
// the one way this scan could hurt a runner.
const MAX_SCANNED_FILE_BYTES = 512 * 1024;

async function git(args: string[], cwd: string): Promise<string> {
  const { exitCode, stdout, stderr } = await runCommand('git', args, cwd, { maxBuffer: 32 * 1024 * 1024 });
  if (exitCode !== 0) throw new Error(`git ${args[0]} failed (exit ${exitCode}): ${stderr.trim()}`);
  return stdout;
}

// Content of `path` at `rev`, or '' when the file does not exist there (added or deleted).
async function blobAt(rev: string, path: string, cwd: string): Promise<string> {
  const { exitCode, stdout } = await runCommand('git', ['show', `${rev}:${path}`], cwd, { maxBuffer: 32 * 1024 * 1024 });
  return exitCode === 0 ? stdout : '';
}

// Looks like text, i.e. worth comparing as rendered content. A NUL byte is git's own binary
// heuristic and it is good enough here.
function isText(content: string): boolean {
  return content.length <= MAX_SCANNED_FILE_BYTES && !content.includes('\0');
}

// The fix round's own changes: every path that differs between `baseSha` and HEAD, with both
// versions of its content.
//
// `baseSha` must be the CHECKOUT'S HEAD AS IT WAS BEFORE THE AGENT RAN, recorded by action.yml
// straight after the checkout step. It cannot be re-derived here from the grant's baseBranch,
// and that is not a detail: for a fix grant the baseBranch IS the PR head branch the round has
// just force-pushed to, so resolving it at finalize time returns the fix's own commit and the
// diff comes back empty -- an evasion would scan clean precisely because it landed.
//
// Two-dot, not three: HEAD descends directly from this sha, so there is no merge base to find
// and nothing for a shallow clone to sever.
//
// THROWS when the diff cannot be computed. The caller must surface that rather than read it as
// "nothing changed" -- the same distinction between a diff that is EMPTY and one that could not
// be COMPUTED that agent-qa learned the hard way.
export async function readFixDiff(baseSha: string, cwd: string): Promise<FixFileDiff[]> {
  const base = baseSha.trim();
  if (!/^[0-9a-f]{7,40}$/i.test(base)) {
    throw new Error(`the runner did not record the pre-fix revision (got "${baseSha}"), so this fix cannot be scanned`);
  }
  const names = (await git(['diff', '--name-only', `${base}..HEAD`], cwd))
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const diffs: FixFileDiff[] = [];
  for (const path of names) {
    const [before, after] = await Promise.all([blobAt(base, path, cwd), blobAt('HEAD', path, cwd)]);
    if (!isText(before) || !isText(after)) continue;
    diffs.push({ path, before, after });
  }
  return diffs;
}

// Read the fixer's dispute file out of the checkout. Absent (the ordinary case) yields [].
export async function readFixDisputes(cwd: string): Promise<FixDispute[]> {
  try {
    return parseFixDisputeFile(await readFile(`${cwd}/${FIX_DISPUTE_FILE}`, 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Assemble the round's verdict from what the checkout holds. `baseSha` is the pre-agent HEAD (see
 * readFixDiff).
 *
 * `scanError` is a first-class outcome, not a swallowed failure: a diff that could not be read
 * leaves us unable to say whether the round was an evasion, and an undecidable answer must be
 * SURFACED, never silently accepted. The control plane treats it as unjudged, which is the
 * existing convention for "a gate ran but reached no verdict" and routes to a human.
 */
export async function buildFixVerdict(cwd: string, baseSha: string): Promise<FixVerdict> {
  const disputes = await readFixDisputes(cwd);
  try {
    return { disputes, evasions: findEvasions(await readFixDiff(baseSha, cwd)) };
  } catch (err) {
    return { disputes, evasions: [], scanError: err instanceof Error ? err.message : String(err) };
  }
}
