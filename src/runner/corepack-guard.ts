// Runner-infra guard for the heavy gate stage's corepack provisioning (see action.yml's
// "Provision heavy gate stage" step). Once `corepack enable` runs, corepack intercepts the
// tenant's `yarn`/`npm`/`pnpm` shim on the runner. When the tenant repo's root package.json PINS a
// manager (the `packageManager` field) corepack activates exactly that version -- correct,
// deterministic, the intended behaviour. When it does NOT, corepack activates its own bundled
// DEFAULT (a modern Berry Yarn), whose node_modules layout mismatches a classic Yarn-1 lockfile and
// produces an opaque downstream build failure ("Module not found: Can't resolve ...") that reads as
// a code defect and burns a fix-loop with no code to fix (real prod incident).
//
// This guard makes that case fail LOUD-but-safe: for an UNPINNED repo it does NOT run `corepack
// enable` (so the system-installed yarn/npm stays active, matching a classic lockfile) and emits a
// clear, actionable diagnostic annotation nudging the tenant to pin. A PINNED repo is entirely
// unaffected -- corepack runs and honours the pin exactly as before.

import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface CorepackDecision {
  // Whether the caller should run `corepack enable`. True ONLY when the repo pins a manager.
  enableCorepack: boolean;
  // A human-facing diagnostic to surface (as a ::warning:: annotation) when the repo is unpinned.
  diagnostic?: string;
}

// Pure detection: given the raw root package.json text (or undefined if unreadable) and the repo
// slug, decide whether corepack should be enabled and what diagnostic to surface. A non-empty
// string `packageManager` field is the pin corepack honours; anything else -- missing field,
// unparseable file, absent file -- is treated as UNPINNED, so we fall back to the system manager
// and warn. Kept side-effect-free so it is unit-testable without a filesystem or a runner.
export function evaluateCorepackProvisioning(packageJsonRaw: string | undefined, repo: string): CorepackDecision {
  if (readPackageManagerPin(packageJsonRaw)) return { enableCorepack: true };
  return {
    enableCorepack: false,
    diagnostic:
      `tenant repo ${repo} has no \`packageManager\` pin in package.json; corepack may activate a ` +
      'mismatched Yarn/npm version against its lockfile -- skipping `corepack enable` and using the ' +
      'system-installed package manager. Pin it (e.g. "packageManager": "yarn@1.22.22") to match the ' +
      "lockfile's generator.",
  };
}

function readPackageManagerPin(packageJsonRaw: string | undefined): string | undefined {
  if (!packageJsonRaw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonRaw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const value = (parsed as { packageManager?: unknown }).packageManager;
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function readWorkspacePackageJson(workspace: string): string | undefined {
  try {
    return readFileSync(path.join(workspace, 'package.json'), 'utf8');
  } catch {
    return undefined;
  }
}

// CLI shim invoked by the "Provision heavy gate stage" step: reads the checked-out customer repo's
// root package.json (GITHUB_WORKSPACE), prints `enable` or `skip` on stdout for the shell to branch
// on, and emits the unpinned diagnostic as a ::warning:: on stderr so it never pollutes that token
// (GitHub parses workflow commands from either stream).
export function runCorepackGuard(
  env: NodeJS.ProcessEnv,
  out: { write(chunk: string): unknown },
  err: { write(chunk: string): unknown },
): void {
  const workspace = env.GITHUB_WORKSPACE ?? '.';
  const repo = env.GITHUB_REPOSITORY ?? 'unknown';
  const decision = evaluateCorepackProvisioning(readWorkspacePackageJson(workspace), repo);
  if (decision.diagnostic) err.write(`::warning title=corepack unpinned::${decision.diagnostic}\n`);
  out.write(decision.enableCorepack ? 'enable\n' : 'skip\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCorepackGuard(process.env, process.stdout, process.stderr);
}
