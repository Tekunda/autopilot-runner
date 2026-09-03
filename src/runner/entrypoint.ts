// "Am I being run directly?" for every script entry point in the repo -- the runner's, the
// control-plane CLIs (src/main.ts, src/service/main.ts) and the packaging build.
//
// The idiom this replaces -- `import.meta.url === \`file://${process.argv[1]}\`` -- is wrong in a
// way that never announces itself. Node's ESM loader resolves symlinks before it computes
// `import.meta.url`, while `process.argv[1]` keeps the path as the caller wrote it. So the moment
// an ABSOLUTE argv[1] reaches the script through a symlink (a symlinked checkout, a container
// bind-mount, macOS `/var` -> `/private/var`) the comparison is false, `main()` never runs, and
// the process exits 0 having done nothing at all.
//
// No current invocation passes an absolute argv[1] -- action.yml runs `node
// src/runner/action-entry.ts` under a `working-directory:`, the Dockerfile runs `node
// dist/service/main.js` under a WORKDIR -- and Node absolutizes a relative argv[1] against an
// already-realpath-resolved cwd, so it cannot carry a symlink. That is why this never fired in
// production. The point of resolving realpath is to remove the class before someone writes
// `node ${{ github.action_path }}/src/...` and reintroduces it silently.
//
// For a gate whose job is to FAIL something -- refusing a conflicted push, rejecting a bad grant
// -- a silent no-op is the worst possible failure mode: it looks exactly like success. Resolving
// realpath costs one syscall and removes the class.

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function isDirectlyExecuted(moduleUrl: string, entry: string | undefined = process.argv[1]): boolean {
  if (!entry) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(entry)).href;
  } catch {
    // realpath failed (EACCES on a parent dir, ELOOP, a race that unlinked the script). The
    // entry may well still BE this module, so answering `false` here would manufacture exactly
    // the silent no-op this function exists to prevent. Degrade to the unresolved comparison
    // instead: no worse than the old idiom, and correct whenever no symlink is involved.
    return moduleUrl === pathToFileURL(path.resolve(entry)).href;
  }
}
