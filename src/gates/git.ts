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

// The unified diff of `files` between `base` and HEAD (three-dot: changes on HEAD's side of
// the merge-base only). A default actions/checkout is shallow (depth 1), severing the ancestry
// a three-dot diff needs; on failure this unshallows once and retries, re-throwing the original
// error if the retry still cannot compute the diff.
export async function unifiedDiffForFiles(base: string, files: string[], cwd: string = process.cwd()): Promise<string> {
  try {
    return await diff(base, files, cwd);
  } catch (err) {
    await runCommand('git', ['fetch', '--unshallow', 'origin'], cwd).catch(() => undefined);
    return diff(base, files, cwd).catch(() => {
      throw err;
    });
  }
}
