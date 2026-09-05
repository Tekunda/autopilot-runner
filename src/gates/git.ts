// Shared git seam for gates that need more than the changed-file NAMES: resolving a base
// ref to a concrete sha and fetching the unified diff of specific files against HEAD. Both
// run through runCommand (./exec.ts) against a cwd -- the customer PR checkout for a gate,
// or the runner's own checkout for prepare-stage's computeChangedFiles, which factors its
// base resolution through resolveBaseSha here so there is one source of truth for "where is
// the base".

import { runCommand } from './exec.ts';

// Resolve `baseRef` (a branch name like "main") to a concrete commit sha reachable from this
// checkout. Best-effort fetches origin first (the action's checkout has origin; a local test
// tree may not), then prefers the freshly-fetched remote ref, falling back to a locally-known
// branch of the same name. Throws when neither exists -- an empty base would silently diff
// over nothing.
export async function resolveBaseSha(baseRef: string, cwd: string = process.cwd()): Promise<string> {
  const remoteRef = `refs/remotes/origin/${baseRef}`;
  // No origin (or offline) -> fall back to a locally-known branch below.
  await runCommand('git', ['fetch', '--no-tags', 'origin', `+refs/heads/${baseRef}:${remoteRef}`], cwd).catch(
    () => undefined,
  );

  const revParse = async (ref: string): Promise<string> => {
    const result = await runCommand('git', ['rev-parse', '--verify', '--quiet', ref], cwd).catch(() => undefined);
    return result && result.exitCode === 0 ? result.stdout.trim() : '';
  };

  const base = (await revParse(remoteRef)) || (await revParse(`refs/heads/${baseRef}`));
  if (!base) throw new Error(`resolveBaseSha: base ref "${baseRef}" not found locally or on origin`);
  return base;
}

async function diff(base: string, files: string[], cwd: string): Promise<string> {
  const { exitCode, stdout, stderr } = await runCommand('git', ['diff', `${base}...HEAD`, '--', ...files], cwd);
  // runCommand recovers a non-zero exit as a result rather than rejecting; a git diff that
  // exits non-zero (e.g. a severed shallow history with no merge-base) is a real failure the
  // caller must see, so surface it as a throw the retry/skip path handles.
  if (exitCode !== 0) throw new Error(`git diff failed (exit ${exitCode}): ${stderr.trim()}`);
  return stdout;
}

// Deepen a shallow checkout, once, before a retry. A default actions/checkout is shallow
// (depth 1), so a base commit's ancestry -- or its tree -- may simply not be present locally on
// the first attempt. Best-effort by design and by NAME: every caller here is already inside a
// catch, retries afterwards regardless, and re-throws the ORIGINAL error if the retry still
// cannot answer. Failing to unshallow (no origin, already complete, offline) is therefore not a
// fact any caller can act on -- the retry's outcome is. One helper rather than one discard per
// caller so that stays a single deliberate decision instead of three copies of it.
async function unshallowOnce(cwd: string): Promise<void> {
  await runCommand('git', ['fetch', '--unshallow', 'origin'], cwd).catch(() => undefined);
}

// The unified diff of `files` between `base` and HEAD (three-dot: changes on HEAD's side of
// the merge-base only). A default actions/checkout is shallow (depth 1), severing the ancestry
// a three-dot diff needs; on failure this unshallows once and retries, re-throwing the original
// error if the retry still cannot compute the diff.
export async function unifiedDiffForFiles(base: string, files: string[], cwd: string = process.cwd()): Promise<string> {
  try {
    return await diff(base, files, cwd);
  } catch (err) {
    await unshallowOnce(cwd);
    return diff(base, files, cwd).catch(() => {
      throw err;
    });
  }
}

// The paths this change DELETED, between `base` and HEAD. Callers use it to tell a changed
// file that is absent from the checkout because the diff removed it (expected) from one that
// is absent because the checkout is wrong or the path never resolved (a real fault they must
// not report as a clean scan).
//
// `-z` is not optional here: without it git octal-escapes any non-ASCII path
// ("apps/caf\303\251.spec.ts") and quotes names with spaces, so a comparison against the
// host-supplied changed-file list silently misses exactly the paths most likely to be
// mishandled elsewhere. The NUL stream is status and path alternating; rename/copy entries
// (R/C) carry TWO paths, so the source path is consumed and only the destination advances.
export async function deletedFilesSince(base: string, cwd: string = process.cwd()): Promise<Set<string>> {
  const nameStatus = async (): Promise<string> => {
    const { exitCode, stdout, stderr } = await runCommand(
      'git',
      ['diff', '--name-status', '-z', `${base}...HEAD`],
      cwd,
    );
    if (exitCode !== 0) throw new Error(`git diff --name-status failed (exit ${exitCode}): ${stderr.trim()}`);
    return stdout;
  };

  let raw: string;
  try {
    raw = await nameStatus();
  } catch (err) {
    await unshallowOnce(cwd);
    raw = await nameStatus().catch(() => {
      throw err;
    });
  }

  const fields = raw.split('\0');
  const deleted = new Set<string>();
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      i += 2; // source + destination
      continue;
    }
    const file = fields[i + 1];
    i += 1;
    if (status.startsWith('D') && file) deleted.add(file);
  }
  return deleted;
}

// A file's CONTENT as of `base`, or `undefined` when the path did not exist there -- which is the
// ONLY thing `undefined` may ever mean here. Everything else THROWS.
//
// That distinction is load-bearing for any gate judging whether a PR made something WORSE. "The
// base had no such file" (a genuinely new page, whose debt this PR authored) and "git could not
// answer" (a severed shallow history, a base ref that vanished, an unreadable object) are
// different facts, and folding the second into the first would hand every caller a silent
// "nothing was there before" for a question git never answered -- the same fail-open this module
// refuses everywhere else (see deletedFilesSince's header).
//
// `git show <base>:<relPath>` resolves the path against the REPOSITORY ROOT (no `./` prefix), so
// `relPath` must be repo-root-relative -- exactly the shape a PR's changed-file list carries, and
// `cwd` the checkout root those paths are relative to.
async function showAtBase(base: string, relPath: string, cwd: string): Promise<string | undefined> {
  const { exitCode, stdout, stderr } = await runCommand('git', ['show', `${base}:${relPath}`], cwd);
  if (exitCode === 0) return stdout;
  // git's two "the tree is fine, this path simply is not in it" messages. Matched on the message
  // and not the exit code, because git spends 128 on every fatal -- absence and corruption alike.
  if (/does not exist in|exists on disk, but not in/.test(stderr)) {
    // ...but those SAME messages come back for a rev git cannot resolve at all: `git show
    // deadbeef…:a.txt` says "path 'a.txt' exists on disk, but not in 'deadbeef…'", which is a
    // statement about a commit that does not exist. Trusting the message alone would report a
    // severed shallow history as "the base never had this file". So the absence claim is only
    // accepted once the rev is confirmed to name a real object.
    const verified = await runCommand('git', ['rev-parse', '--verify', '--quiet', `${base}^{object}`], cwd);
    if (verified.exitCode === 0) return undefined;
    throw new Error(`git show ${base}:${relPath} failed: "${base}" names no object in this checkout`);
  }
  throw new Error(`git show ${base}:${relPath} failed (exit ${exitCode}): ${stderr.trim()}`);
}

// Same unshallow-once-and-retry shape as unifiedDiffForFiles: a default actions/checkout is
// shallow (depth 1), so the base commit's tree may not be present locally on the first attempt.
// The ORIGINAL error is re-thrown when the retry still cannot answer, so the caller reports the
// real cause rather than the retry's.
export async function fileAtBase(
  base: string,
  relPath: string,
  cwd: string = process.cwd(),
): Promise<string | undefined> {
  try {
    return await showAtBase(base, relPath, cwd);
  } catch (err) {
    await unshallowOnce(cwd);
    return showAtBase(base, relPath, cwd).catch(() => {
      throw err;
    });
  }
}
