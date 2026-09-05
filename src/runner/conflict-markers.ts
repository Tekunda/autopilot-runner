// Refuse to push a half-resolved merge (GA gate B3).
//
// The coding stage's push step is `git add -A` followed by `git commit`. `git add -A` will
// cheerfully stage a file that still contains `<<<<<<< HEAD`, so an agent that gave up halfway
// through a conflict resolution -- or a conflict-resolve stage that merged, hit a conflict and
// then "finished" -- produced a commit, a force-push and a PR whose diff is literal merge
// markers. The shell pipeline this replaced had this guard; Autopilot shipped without it.
//
// This is the guard, in TypeScript rather than as bash inside action.yml, for two reasons: it is
// testable (action.yml's shell has no unit tests, only string-presence assertions), and the
// refusal message can name every offending file AND line instead of being an opaque grep exit
// code -- which matters, because this failure is read by whoever has to go fix the branch.
//
// WHAT IT SCANS: the INDEX, not the working tree. The push step stages first, so the index is
// exactly the content about to become a commit; scanning the working tree would both miss
// excluded paths and flag files that were never staged.
//
// FALSE POSITIVES: a lone `=======` line is a perfectly ordinary Markdown setext underline, a
// table rule or an ASCII divider, and refusing on it would block legitimate documentation pushes.
// So a file is refused only when it carries the CONFLICTING PAIR -- an opening `<<<<<<< ` line and
// a closing `>>>>>>> ` line. Every marker line in such a file is then reported, separators
// included, because that is the map of what has to be resolved.

import { runCommand } from '../gates/exec.ts';
import { isDirectlyExecuted } from './entrypoint.ts';

// Git writes markers as a run of the same character at the start of a line, followed by
// end-of-line or a label (`<<<<<<< HEAD`, `>>>>>>> origin/main`, `||||||| merged common ancestors`
// under diff3).
//
// Seven is only the DEFAULT run length. `.gitattributes` can set `conflict-marker-size` per path,
// and git honours it in BOTH directions -- `=32` writes 32-character markers, `=4` writes
// four-character ones. A hardcoded `{7}` missed the long ones; a hardcoded `{7,}` still missed the
// short ones. So the size is RESOLVED PER FILE (git check-attr) and the patterns are built from
// it, which is the only way the scanner and the repository agree on what a marker is.
//
// Sizes below MIN_HONOURED_MARKER_SIZE are ignored in favour of the default: at 1 or 2 every `=`
// or `==` in the file would read as a separator, which is a worse failure than not honouring a
// pathological setting.
export const DEFAULT_MARKER_SIZE = 7;
const MIN_HONOURED_MARKER_SIZE = 3;
const MAX_HONOURED_MARKER_SIZE = 200;

// The separator is label-FREE (`^={n,}$`) while the outer markers allow a trailing label:
// `=======` with trailing text is a heading underline or a divider, and refusing on those would
// block ordinary docs.
function markerPatterns(size: number): ReadonlyArray<{ kind: ConflictMarkerKind; re: RegExp }> {
  const n = `{${size},}`;
  return [
    { kind: 'ours', re: new RegExp(`^<${n}(?:[ \\t].*)?$`) },
    { kind: 'base', re: new RegExp(`^\\|${n}(?:[ \\t].*)?$`) },
    { kind: 'separator', re: new RegExp(`^=${n}$`) },
    { kind: 'theirs', re: new RegExp(`^>${n}(?:[ \\t].*)?$`) },
  ];
}

// git's own marker shape for an OUTER marker carrying a label, at this file's size.
function labelledOuter(size: number): RegExp {
  return new RegExp(`^(?:<{${size},}|>{${size},})[ \\t]\\S`);
}


export type ConflictMarkerKind = 'ours' | 'base' | 'separator' | 'theirs';

export interface ConflictMarker {
  /** 1-based line number, so the message points where an editor does. */
  line: number;
  kind: ConflictMarkerKind;
  text: string;
  /**
   * An OUTER marker (`ours`/`theirs`) carrying a label, i.e. git's own `<<<<<<< HEAD` shape.
   * Decided at scan time, where this file's marker size is known, so the predicate below stays
   * size-agnostic.
   */
  labelled: boolean;
}

export interface ConflictFinding {
  path: string;
  markers: ConflictMarker[];
}

/**
 * Every conflict marker line in one file's content. Pure -- the unit under test.
 *
 * `markerSize` is the file's resolved `conflict-marker-size` (see markerPatterns); callers that
 * do not know it get git's default.
 */
export function scanConflictMarkers(content: string, markerSize: number = DEFAULT_MARKER_SIZE): ConflictMarker[] {
  const size = normaliseMarkerSize(markerSize);
  const patterns = markerPatterns(size);
  const labelled = labelledOuter(size);
  const found: ConflictMarker[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i]!.replace(/\r$/, ''); // a CRLF checkout must not hide a marker
    for (const { kind, re } of patterns) {
      if (re.test(text)) {
        found.push({ line: i + 1, kind, text, labelled: labelled.test(text) });
        break;
      }
    }
  }
  return found;
}

/** A `conflict-marker-size` we are willing to honour, else git's default. */
export function normaliseMarkerSize(size: number): number {
  if (!Number.isInteger(size) || size < MIN_HONOURED_MARKER_SIZE || size > MAX_HONOURED_MARKER_SIZE) {
    return DEFAULT_MARKER_SIZE;
  }
  return size;
}

// Is this file a half-resolved merge? Two triggers.
//
// 1. An `ours` line followed by a `theirs` line -- the intact conflict git left behind.
// 2. EITHER outer marker WITH A LABEL, on its own. A resolution that runs out halfway leaves only
//    one end behind, and it can be either end: top-down deletes `<<<<<<< HEAD` and the ours-side
//    and stops, leaving `=======` + `>>>>>>> branch`; bottom-up deletes `>>>>>>> branch` and the
//    theirs-side and stops, leaving `<<<<<<< HEAD` + `=======`. A truncated model write leaves the
//    opening one too. Requiring the pair missed all of these, and requiring a label on only the
//    closing marker missed half of them -- the same argument covers both ends, so both ends get it.
//
// Why this does not re-open the false-positive problem that makes `=======`-alone unusable: a line
// of `=` at marker width is an ordinary Markdown setext underline, a table rule, an ASCII divider.
// A line of `<` or `>` at marker width followed by a space and a label is essentially never
// legitimate prose. (The one construction that can produce it is seven nested compact CommonMark
// block quotes -- `>>>>>>> text`. That is vanishingly rare, and refusing it is the safe direction:
// the cost is one explained push failure, against a merge conflict shipped into a PR diff.) So the
// conservatism is spent where it buys something and not where it only costs.
//
// A BARE run of `<` or `>` with no label stays benign -- it could be ASCII art or a truncated
// quote -- exactly as `=======` does.
export function isUnresolvedConflict(markers: readonly ConflictMarker[]): boolean {
  const ours = markers.findIndex((m) => m.kind === 'ours');
  if (ours !== -1 && markers.slice(ours + 1).some((m) => m.kind === 'theirs')) return true;
  return markers.some((m) => m.labelled);
}

async function git(args: string[], cwd: string): Promise<{ exitCode: number; stdout: string }> {
  const { exitCode, stdout, stderr } = await runCommand('git', args, cwd, { maxBuffer: 64 * 1024 * 1024 });
  // exit 1 is `git grep`'s "no matches", a normal answer here. Anything above that is a real
  // tooling failure and must not be mistaken for a clean tree.
  if (exitCode > 1) throw new Error(`git ${args.join(' ')} failed (exit ${exitCode}): ${stderr.trim()}`);
  return { exitCode, stdout };
}

// What THIS STAGE staged, as paths, diffing the index against the revision the checkout was at
// before the agent ran.
//
// This scoping is load-bearing, not an optimization. `git add -A` makes the index the whole tree,
// so scanning it wholesale would judge every file in the customer's repository -- and any file
// ALREADY COMMITTED there that happens to contain an ours/theirs pair would refuse the push
// permanently, on every coding stage, no matter what the agent touched. A git-training repo, a
// merge-tooling repo, a `docs/resolving-conflicts.md`, a linter's fixture directory: each becomes
// an unexplainable wedge on ticket #1. The guard must only ever judge what this stage is adding.
//
// ACMR excludes deletions: a file being removed cannot carry an unresolved conflict into the
// commit. (A rename reports its DESTINATION path, which is the one in the index, so the lookups
// below still resolve.) The base revision is the PRE-AGENT sha rather than HEAD because the vendor
// action may commit on its own, which would move HEAD past the conflicted content and hide it.
async function stagedPaths(cwd: string, sinceRef: string): Promise<string[]> {
  const { stdout } = await git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR', sinceRef], cwd);
  return stdout.split('\0').filter((p) => p.length > 0);
}

// Each path's effective `conflict-marker-size`, straight from git's own attribute resolution
// (`-z` -> `<path>\0<attr>\0<value>\0` triples). Asking git rather than parsing `.gitattributes`
// ourselves is the point: precedence across nested files, pattern matching and macro expansion are
// git's rules, and a scanner that disagreed with the repository about what a marker is would be
// exactly the bug this closes.
//
// Paths go as arguments in chunks rather than through `--stdin`, so this needs no stdin seam on
// the shared runCommand primitive; the chunk bound keeps a very large staged set inside ARG_MAX.
// Unset/unspecified/non-numeric values all fall back to the default via normaliseMarkerSize.
const ATTR_CHUNK = 200;

async function markerSizes(cwd: string, paths: readonly string[]): Promise<Map<string, number>> {
  const sizes = new Map<string, number>();
  for (let i = 0; i < paths.length; i += ATTR_CHUNK) {
    const chunk = paths.slice(i, i + ATTR_CHUNK);
    const { exitCode, stdout, stderr } = await runCommand(
      'git',
      ['check-attr', '-z', 'conflict-marker-size', '--', ...chunk],
      cwd,
      { maxBuffer: 8 * 1024 * 1024 },
    );
    // Attribute lookup improves ACCURACY; it is never a gate. If git cannot answer, every file
    // simply keeps the default size. Failing the push over it would turn a diagnostic into an
    // outage.
    if (exitCode !== 0) {
      process.stderr.write(
        `conflict-scan: could not resolve conflict-marker-size (${stderr.trim()}); using the default\n`,
      );
      continue;
    }
    const fields = stdout.split('\0');
    for (let f = 0; f + 2 < fields.length; f += 3) {
      const size = Number(fields[f + 2]);
      if (Number.isInteger(size)) sizes.set(fields[f]!, size);
    }
  }
  return sizes;
}

// Files above this are not scanned. A merge conflict does not occur in a multi-megabyte generated
// artifact, and line-splitting several of them is the one way this scan could hurt a runner. Same
// posture (and same reason) as fix-verdict.ts's own scan cap.
const MAX_SCANNED_BYTES = 5 * 1024 * 1024;

/** Staged content of one path, as git will commit it. */
async function stagedContent(path: string, cwd: string): Promise<string> {
  const { exitCode, stdout } = await git(['show', `:${path}`], cwd);
  return exitCode === 0 ? stdout : '';
}

// A NUL byte means git would treat this blob as binary, and a binary file has no lines to judge.
// Checked in-process rather than via `git grep -I` because this scanner no longer asks grep
// anything -- see findStagedConflicts.
function looksBinary(content: string): boolean {
  return content.includes('\0');
}

/**
 * Every file THIS STAGE staged that is a half-resolved merge, with the marker lines that prove it.
 *
 * `sinceRef` is the revision the checkout was at before the agent ran (action.yml's
 * `steps.pre-agent.outputs.sha`). Files the customer already had committed are never judged.
 *
 * There is deliberately NO `git grep` pre-filter any more. One used to narrow the candidate set,
 * and its hardcoded pattern was a second, independent definition of "what a marker looks like"
 * that could disagree with the one that actually decides -- which is exactly how a custom
 * `conflict-marker-size` slipped through: grep found the file, the patterns then matched nothing,
 * and it pushed. The path set is already scoped to this stage's own changes, so reading them
 * directly is both cheaper to reason about and impossible to desynchronise.
 */
export async function findStagedConflicts(cwd: string, sinceRef = 'HEAD'): Promise<ConflictFinding[]> {
  const paths = await stagedPaths(cwd, sinceRef);
  if (paths.length === 0) return []; // this stage staged nothing -- there is nothing to judge
  const excluded = scanExclusions();
  const scanned = paths.filter((path) => !isExcluded(path, excluded));
  const sizes = await markerSizes(cwd, scanned);
  const findings: ConflictFinding[] = [];
  for (const path of scanned) {
    const content = await stagedContent(path, cwd);
    if (content.length > MAX_SCANNED_BYTES || looksBinary(content)) continue;
    const markers = scanConflictMarkers(content, sizes.get(path) ?? DEFAULT_MARKER_SIZE);
    if (isUnresolvedConflict(markers)) findings.push({ path, markers });
  }
  return findings;
}

// The escape hatch, for the case the scanner genuinely cannot distinguish: a ticket whose WHOLE
// POINT is to add a file containing conflict markers (a conflict-resolution runbook, a merge-tool
// fixture). Without one, such a ticket refuses forever and the fix loop cannot resolve it either,
// because there is nothing wrong to fix. Comma-separated exact paths or `dir/` prefixes, set on
// the runner workflow; unset -- the normal case -- excludes nothing.
export function scanExclusions(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.AUTOPILOT_CONFLICT_SCAN_EXCLUDE ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export function isExcluded(path: string, exclusions: readonly string[]): boolean {
  return exclusions.some((entry) => (entry.endsWith('/') ? path.startsWith(entry) : path === entry));
}

// The refusal, written for whoever has to fix the branch: every file, every line, and the one
// sentence that says why a push was refused rather than a commit made.
export function renderConflictRefusal(findings: readonly ConflictFinding[]): string {
  const lines = [
    'REFUSING TO PUSH: staged files still contain unresolved merge conflict markers.',
    '',
    'A commit here would put literal `<<<<<<<` / `>>>>>>>` lines into the branch and the PR diff.',
    'Resolve each conflict below, stage the result, and re-run the stage.',
    '',
  ];
  for (const finding of findings) {
    lines.push(`  ${finding.path}`);
    for (const marker of finding.markers) {
      lines.push(`    line ${marker.line}: ${marker.text}`);
    }
  }
  lines.push('');
  lines.push(`${findings.length} file(s) with unresolved conflicts.`);
  // The one case this scanner cannot tell apart from a bug: a change whose POINT is to add a file
  // containing markers. Without naming the way out, such a ticket refuses forever -- and the fix
  // loop cannot clear it either, because nothing is actually wrong. Say so here, where the person
  // who has to decide is already reading.
  lines.push('');
  lines.push('If these markers are INTENTIONAL content (a conflict-resolution runbook, a merge-tool');
  lines.push('fixture), this scan cannot tell. Exclude the path by setting AUTOPILOT_CONFLICT_SCAN_EXCLUDE');
  lines.push('on the runner workflow -- comma-separated exact paths, or `dir/` for a whole directory.');
  return lines.join('\n');
}

// CLI: action.yml's "Commit and push coding result" step runs this between `git add -A` and
// `git commit`, from the customer checkout. A non-zero exit fails the step (the composite step's
// shell is `bash -eo pipefail`), so the push never happens.
async function main(): Promise<void> {
  const cwd = process.env.GITHUB_WORKSPACE || process.cwd();
  // The revision the checkout was at before the agent ran, so only what this stage staged is
  // judged (see findStagedConflicts). action.yml passes `steps.pre-agent.outputs.sha`; the HEAD
  // fallback keeps the guard scoped -- never repo-wide -- if that output is ever missing.
  const sinceRef = process.env.AUTOPILOT_PRE_AGENT_SHA || 'HEAD';
  const findings = await findStagedConflicts(cwd, sinceRef);
  if (findings.length === 0) return;
  // ::error:: renders in the Actions job summary as well as the log, so this is visible without
  // opening the step.
  process.stderr.write(`::error::${findings.length} staged file(s) contain unresolved merge conflict markers\n`);
  process.stderr.write(`${renderConflictRefusal(findings)}\n`);
  process.exitCode = 1;
}

if (isDirectlyExecuted(import.meta.url)) {
  void main();
}
