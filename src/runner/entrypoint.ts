// "Am I being run directly?" for the runner's script entry points.
//
// The idiom this replaces -- `import.meta.url === \`file://${process.argv[1]}\`` -- is wrong in a
// way that never announces itself. Node's ESM loader resolves symlinks before it computes
// `import.meta.url`, while `process.argv[1]` keeps the path as the caller wrote it. So the moment
// any parent directory is a symlink (macOS `/var` -> `/private/var`, a symlinked checkout, a
// container bind-mount) the comparison is false, `main()` never runs, and the process exits 0
// having done nothing at all.
//
// For a gate whose job is to FAIL something -- refusing a conflicted push, rejecting a bad grant
// -- a silent no-op is the worst possible failure mode: it looks exactly like success. Resolving
// realpath on both sides costs one syscall and removes the class.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isDirectlyExecuted(moduleUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    // argv[1] does not resolve (deleted, permission denied): it is not this module.
    return false;
  }
}
