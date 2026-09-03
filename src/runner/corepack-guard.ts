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

import { detectStack, memoryReader, readerAt, type StackProfile } from '../gates/stack-profile.ts';

import { isDirectlyExecuted } from './entrypoint.ts';

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
//
// The pin is no longer parsed HERE: this file used to carry its own copy of that parser (and
// gates/generic/cve.ts a third), which is how four call sites came to guess the tenant's
// toolchain independently. It now runs the ONE detector (gates/stack-profile.ts) over an
// in-memory tree holding just the package.json text it was handed, and reads the pin off the
// resulting Node profile.
export function evaluateCorepackProvisioning(packageJsonRaw: string | undefined, repo: string): CorepackDecision {
  const files: Record<string, string> = packageJsonRaw === undefined ? {} : { 'package.json': packageJsonRaw };
  return decideFromStack(detectStack(memoryReader(files)), repo);
}

// The single rule, expressed once against the shared detector's output: corepack is safe
// exactly when the Node profile carries a `packageManager` pin. `managerPin` is set from the
// same non-empty-string test the private parser used to apply, so this is a de-duplication and
// not a behaviour change -- and a tree with no Node profile at all (no manifest, no lockfile)
// carries no pin either, so it still routes to `skip`.
function decideFromStack(profiles: readonly StackProfile[], repo: string): CorepackDecision {
  const node = profiles.find((profile) => profile.ecosystem === 'node');
  if (node?.managerPin !== undefined) return { enableCorepack: true };
  return {
    enableCorepack: false,
    diagnostic:
      `tenant repo ${repo} has no \`packageManager\` pin in package.json; corepack may activate a ` +
      'mismatched Yarn/npm version against its lockfile -- skipping `corepack enable` and using the ' +
      'system-installed package manager. Pin it (e.g. "packageManager": "yarn@1.22.22") to match the ' +
      "lockfile's generator.",
  };
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
  // Reads the real checkout through the shared detector, so the CLI path and the pure path
  // above agree by construction rather than by two parsers happening to stay in step.
  const decision = decideFromStack(detectStack(readerAt(workspace)), repo);
  if (decision.diagnostic) err.write(`::warning title=corepack unpinned::${decision.diagnostic}\n`);
  out.write(decision.enableCorepack ? 'enable\n' : 'skip\n');
}

if (isDirectlyExecuted(import.meta.url)) {
  runCorepackGuard(process.env, process.stdout, process.stderr);
}
