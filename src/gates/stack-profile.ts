// ONE answer to "what language/toolchain is this repo?", for every gate and every piece of
// runner infra that needs it.
//
// THE PROBLEM THIS FILE EXISTS TO END: twenty gates each guessed on their own. The package
// manager alone was parsed in four unrelated places -- `runner/corepack-guard.ts` (the
// `packageManager` pin, to decide whether `corepack enable` is safe), `gates/generic/cve.ts`
// (`detectYarnMajor` + its own copy of the pin parser, to route the dependency audit),
// `packaging/build-runner-dist.ts` (this repo's OWN build tooling, a different concern -- see
// below), and a shell `if [ -f yarn.lock ]` in `.github/workflows/ci.yml`. Nothing anywhere
// read `pyproject.toml`, `uv.lock` or `sfdx-project.json`, so every non-Node tenant was
// invisible to the gate layer: gates either guessed JS/TS and asserted nothing, or reported a
// verdict about a tree they had not understood. Salesforce and Python support cannot be built
// on four private guesses, so detection happens once, here, and is attached to GateContext
// (`stackProfiles`) for every gate to read.
//
// THREE RULES:
//   1. A repo is a LIST of profiles, not one label. A Salesforce org with an LWC front end is
//      genuinely both `salesforce` and `node`, and a gate that has to pick one gets it wrong
//      for half the diff. The order is the fixed detector order (node, python, salesforce) so
//      the output is deterministic -- it is NOT a ranking, and a caller that needs "the"
//      ecosystem must decide from the entries it gets.
//   2. UNKNOWN IS A FIRST-CLASS ANSWER, never a guess. A tree with no manifest this file
//      recognises yields exactly one `unknown` profile; a Node tree whose manager cannot be
//      determined (two lockfile families, no pin) yields `manager: 'unknown'` rather than a
//      coin flip. Guessing is how `cve` once reported a clean audit of a tree it never read
//      (see cve.ts's header) -- detection that invents facts is worse than detection that
//      says it does not know.
//   3. PURE AND INJECTABLE. Detection takes a WorkspaceReader, never `node:fs` directly (the
//      house idiom -- cve.ts's `ReadWorkspaceFile`, corepack-guard's injected env/streams), so
//      every branch is unit-testable from an object literal with no temp dir. `readerAt()` is
//      the single place that touches the disk, and it never throws: an unreadable workspace
//      reads as an empty one, because a detector that can crash the runner is a worse outcome
//      than a detector that says `unknown`.
//
// NOT IN SCOPE: `packaging/build-runner-dist.ts` reads THIS repository's own package.json to
// build the runner bundle. That is build tooling reading its own source tree, not a fact about
// a tenant's checkout, and it must keep working with no runner present -- it deliberately does
// NOT go through this file.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';

// The toolchains detection can name. `unknown` is returned rather than omitted, so a caller
// always has a profile to report and can tell "we looked and found nothing" from "we never
// looked".
export type Ecosystem = 'node' | 'python' | 'salesforce' | 'unknown';

// The dependency/package manager an ecosystem's profile resolves to, or `unknown` when the
// evidence does not settle it. `yarn-classic` and `yarn-berry` are separated because they are
// two incompatible tools with different audit commands and different node_modules layouts --
// the exact conflation that produced a live "Module not found" fix-loop (corepack-guard.ts)
// and a silently-empty security audit (cve.ts).
export type DependencyManager =
  | 'npm'
  | 'yarn-classic'
  | 'yarn-berry'
  | 'pnpm'
  | 'poetry'
  | 'uv'
  | 'pdm'
  | 'pipenv'
  | 'pip'
  | 'setuptools'
  | 'sfdx'
  | 'unknown';

export interface StackProfile {
  ecosystem: Ecosystem;
  // The workspace-relative manifest/lockfile paths that PROVED this ecosystem, in the order
  // they were looked for. This is the audit trail: a report that says "node" without saying
  // "from package.json + yarn.lock" cannot be checked by the person reading it.
  detectedFrom: readonly string[];
  manager: DependencyManager;
  // The file that settled `manager` (e.g. 'package.json (packageManager)', 'poetry.lock').
  // Absent exactly when `manager` is 'unknown'.
  managerEvidence?: string;
  // The verbatim `packageManager` pin ('yarn@1.22.22') when the manifest carries one. Node
  // only; it is what corepack activates, so it outranks lockfile evidence.
  managerPin?: string;
  // Directories that exist in the checkout and hold this ecosystem's sources / tests. Both may
  // be empty -- a Node repo colocates its tests, and Apex tests live beside the classes they
  // cover -- and an EMPTY list means "none of the conventional roots are present", never "this
  // repo has no tests".
  sourceRoots: readonly string[];
  testRoots: readonly string[];
}

// The filesystem surface detection needs, injected so it can be a literal in a test.
// Every method must be total: no throwing, no exceptions for a missing/unreadable path.
export interface WorkspaceReader {
  // File contents, or undefined when the path is absent, is a directory, or cannot be read.
  readFile(relativePath: string): string | undefined;
  // True when the path exists at all -- file OR directory. Directories are the only reason
  // this is separate from readFile: readFileSync on a directory throws EISDIR.
  exists(relativePath: string): boolean;
  // Entry names directly under a workspace-relative directory ('' for the root). Empty when
  // the directory is absent or unreadable.
  list(relativePath: string): readonly string[];
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

// The one place this file touches the disk. Rooted at the CUSTOMER checkout
// (GITHUB_WORKSPACE), never the runner's own action directory -- the same discipline cve.ts
// spells out. Every call swallows its error: a chmod, an EMFILE or a vanished workspace must
// degrade detection to `unknown`, not crash a gate stage before it writes gate-report.json.
export function readerAt(workspaceRoot: string): WorkspaceReader {
  const resolve = (relativePath: string): string => path.join(workspaceRoot, relativePath);
  return {
    readFile(relativePath) {
      try {
        return readFileSync(resolve(relativePath), 'utf8');
      } catch {
        return undefined;
      }
    },
    exists(relativePath) {
      try {
        return existsSync(resolve(relativePath));
      } catch {
        return false;
      }
    },
    list(relativePath) {
      try {
        return readdirSync(resolve(relativePath));
      } catch {
        return [];
      }
    },
  };
}

// An in-memory reader over a flat `{ 'relative/path': contents }` map. Used by tests and by
// corepack-guard, which holds only the raw package.json text and still routes its decision
// through the real detector rather than keeping a private parser.
export function memoryReader(files: Readonly<Record<string, string>>): WorkspaceReader {
  const names = Object.keys(files);
  const dirsOf = (dir: string): string[] => {
    const prefix = dir === '' ? '' : `${dir.replace(/\/$/, '')}/`;
    const seen = new Set<string>();
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const rest = name.slice(prefix.length);
      if (rest === '') continue;
      seen.add(rest.split('/')[0]!);
    }
    return [...seen];
  };
  return {
    readFile: (relativePath) => files[relativePath],
    // A directory "exists" when any file sits under it -- an in-memory tree has no empty dirs.
    exists: (relativePath) =>
      files[relativePath] !== undefined || names.some((name) => name.startsWith(`${relativePath.replace(/\/$/, '')}/`)),
    list: (relativePath) => dirsOf(relativePath),
  };
}

// ---------------------------------------------------------------------------
// Shared manifest parsers -- the ones that used to be copy-pasted per call site
// ---------------------------------------------------------------------------

// The `packageManager` pin corepack honours. A non-empty string is the pin; ANYTHING else --
// missing field, non-string, blank string, unparseable file, absent file -- is "unpinned".
// Previously duplicated verbatim in runner/corepack-guard.ts and gates/generic/cve.ts.
export function readPackageManagerPin(packageJsonRaw: string | undefined): string | undefined {
  const parsed = parseJsonObject(packageJsonRaw);
  const value = (parsed as { packageManager?: unknown } | undefined)?.packageManager;
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

// Which Yarn a `yarn.lock` belongs to, WITHOUT a `packageManager` pin to say. `.yarnrc.yml` is
// Berry-only and is the better marker of the two, because a Berry repo with
// `nodeLinker: node-modules` still writes a `yarn.lock` -- just not a v1 one.
// "# yarn lockfile v1" is Yarn 1's own banner; Berry writes `__metadata: version: N` instead,
// so the ABSENCE of the banner is not evidence of v1 -- hence `undefined`, not a default.
// Moved here verbatim from gates/generic/cve.ts, which now imports it.
export function detectYarnMajor(hasYarnrcYml: boolean, yarnLockRaw: string): number | undefined {
  if (hasYarnrcYml) return 2;
  if (/^#\s*yarn lockfile v1\s*$/m.test(yarnLockRaw)) return 1;
  return undefined;
}

function parseJsonObject(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

// ---------------------------------------------------------------------------
// detectStack
// ---------------------------------------------------------------------------

// Detect every ecosystem present in the checkout. Never throws, never guesses, and always
// returns at least one profile (an `unknown` one when nothing was recognised) so a report can
// always say what was looked for.
export function detectStack(reader: WorkspaceReader): StackProfile[] {
  const profiles = [detectNode(reader), detectPython(reader), detectSalesforce(reader)].filter(
    (profile): profile is StackProfile => profile !== undefined,
  );
  return profiles.length > 0 ? profiles : [unknownProfile()];
}

// Convenience wrapper for callers holding a workspace path (the runner's gate stages).
export function detectStackAt(workspaceRoot: string): StackProfile[] {
  return detectStack(readerAt(workspaceRoot));
}

function unknownProfile(): StackProfile {
  return { ecosystem: 'unknown', detectedFrom: [], manager: 'unknown', sourceRoots: [], testRoots: [] };
}

function presentPaths(reader: WorkspaceReader, candidates: readonly string[]): string[] {
  return candidates.filter((candidate) => reader.exists(candidate));
}

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

const NODE_MANIFESTS = ['package.json'] as const;
const NPM_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'] as const;
const NODE_EVIDENCE = [...NODE_MANIFESTS, ...NPM_LOCKFILES, 'yarn.lock', 'pnpm-lock.yaml', '.yarnrc.yml'] as const;
const NODE_SOURCE_ROOTS = ['src', 'lib', 'app', 'packages'] as const;
const NODE_TEST_ROOTS = ['test', 'tests', '__tests__', 'spec', 'e2e'] as const;

function detectNode(reader: WorkspaceReader): StackProfile | undefined {
  const detectedFrom = presentPaths(reader, NODE_EVIDENCE);
  // A bare `.yarnrc.yml` with no manifest and no lockfile is config residue, not a Node repo.
  if (!detectedFrom.some((name) => name !== '.yarnrc.yml')) return undefined;

  const packageJsonRaw = reader.readFile('package.json');
  const pin = readPackageManagerPin(packageJsonRaw);
  const { manager, managerEvidence } = nodeManager(reader, pin);

  return {
    ecosystem: 'node',
    detectedFrom,
    manager,
    ...(managerEvidence !== undefined ? { managerEvidence } : {}),
    ...(pin !== undefined ? { managerPin: pin } : {}),
    sourceRoots: presentPaths(reader, NODE_SOURCE_ROOTS),
    testRoots: presentPaths(reader, NODE_TEST_ROOTS),
  };
}

// The pin is consulted FIRST for every manager: it is what corepack activates, so it decides
// which binary actually runs whatever the lockfiles say (cve.ts learned this the expensive
// way -- a stray unmaintained package-lock.json in a Yarn repo re-pointed a whole audit).
// Two lockfile FAMILIES with no pin to break the tie is `unknown`, not a coin flip.
function nodeManager(
  reader: WorkspaceReader,
  pin: string | undefined,
): { manager: DependencyManager; managerEvidence?: string } {
  if (pin !== undefined) {
    const manager = managerFromPin(pin);
    if (manager !== 'unknown') return { manager, managerEvidence: 'package.json (packageManager)' };
    // A pin naming a manager this file does not know is still not licence to fall back to the
    // lockfiles: the pin is what will actually run.
    return { manager: 'unknown' };
  }

  const hasNpmLock = NPM_LOCKFILES.some((name) => reader.exists(name));
  const yarnLock = reader.readFile('yarn.lock');
  const hasPnpmLock = reader.exists('pnpm-lock.yaml');
  const families = [hasNpmLock, yarnLock !== undefined, hasPnpmLock].filter(Boolean).length;
  if (families !== 1) return { manager: 'unknown' };

  if (hasNpmLock) {
    const which = NPM_LOCKFILES.find((name) => reader.exists(name))!;
    return { manager: 'npm', managerEvidence: which };
  }
  if (hasPnpmLock) return { manager: 'pnpm', managerEvidence: 'pnpm-lock.yaml' };

  const major = detectYarnMajor(reader.exists('.yarnrc.yml'), yarnLock!);
  if (major === 1) return { manager: 'yarn-classic', managerEvidence: 'yarn.lock' };
  if (major !== undefined) return { manager: 'yarn-berry', managerEvidence: reader.exists('.yarnrc.yml') ? '.yarnrc.yml' : 'yarn.lock' };
  return { manager: 'unknown' };
}

function managerFromPin(pin: string): DependencyManager {
  const parsed = /^([^@\s]+)@(\d+)(?:[.\d]*)?/.exec(pin.trim());
  const name = parsed?.[1];
  const major = parsed ? Number(parsed[2]) : undefined;
  if (name === 'npm') return 'npm';
  if (name === 'pnpm') return 'pnpm';
  if (name === 'yarn') return major === 1 ? 'yarn-classic' : 'yarn-berry';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

const PYTHON_FIXED_EVIDENCE = [
  'pyproject.toml',
  'setup.py',
  'setup.cfg',
  'poetry.lock',
  'uv.lock',
  'pdm.lock',
  'Pipfile',
  'Pipfile.lock',
] as const;
const PYTHON_SOURCE_ROOTS = ['src'] as const;
const PYTHON_TEST_ROOTS = ['tests', 'test'] as const;

// `requirements*.txt` is a glob, not a fixed name (requirements-dev.txt, requirements.prod.txt),
// so the root listing decides. Sorted for a deterministic report.
function requirementsFiles(reader: WorkspaceReader): string[] {
  return reader
    .list('')
    .filter((name) => /^requirements.*\.txt$/.test(name))
    .sort();
}

function detectPython(reader: WorkspaceReader): StackProfile | undefined {
  const detectedFrom = [...presentPaths(reader, PYTHON_FIXED_EVIDENCE), ...requirementsFiles(reader)];
  if (detectedFrom.length === 0) return undefined;

  const { manager, managerEvidence } = pythonManager(reader, detectedFrom);
  return {
    ecosystem: 'python',
    detectedFrom,
    manager,
    ...(managerEvidence !== undefined ? { managerEvidence } : {}),
    sourceRoots: pythonSourceRoots(reader),
    testRoots: presentPaths(reader, PYTHON_TEST_ROOTS),
  };
}

// Lockfile evidence outranks the manifest: a `poetry.lock` is what actually resolved the tree,
// while a `[tool.*]` table only says what was configured. Both outrank the loose fallbacks.
function pythonManager(
  reader: WorkspaceReader,
  detectedFrom: readonly string[],
): { manager: DependencyManager; managerEvidence?: string } {
  const lockfiles: ReadonlyArray<readonly [string, DependencyManager]> = [
    ['poetry.lock', 'poetry'],
    ['uv.lock', 'uv'],
    ['pdm.lock', 'pdm'],
    ['Pipfile.lock', 'pipenv'],
  ];
  const lock = lockfiles.filter(([name]) => detectedFrom.includes(name));
  // More than one lockfile is the Node two-families case again: evidence that contradicts
  // itself settles nothing.
  if (lock.length === 1) return { manager: lock[0]![1], managerEvidence: lock[0]![0] };
  if (lock.length > 1) return { manager: 'unknown' };

  const pyproject = reader.readFile('pyproject.toml');
  if (pyproject !== undefined) {
    const table = pyprojectManager(pyproject);
    if (table !== undefined) return { manager: table, managerEvidence: 'pyproject.toml' };
  }
  if (detectedFrom.includes('Pipfile')) return { manager: 'pipenv', managerEvidence: 'Pipfile' };
  const requirements = detectedFrom.find((name) => /^requirements.*\.txt$/.test(name));
  if (requirements !== undefined) return { manager: 'pip', managerEvidence: requirements };
  if (detectedFrom.includes('setup.py') || detectedFrom.includes('setup.cfg')) {
    return { manager: 'setuptools', managerEvidence: detectedFrom.includes('setup.py') ? 'setup.py' : 'setup.cfg' };
  }
  return { manager: 'unknown' };
}

// A deliberately small TOML sniff -- section headers and the build backend only. A real TOML
// parser is a runtime dependency this repo does not have and does not need: every rule below
// keys off a line-anchored table header or the `build-backend` string, both of which are
// unambiguous in valid TOML. Anything it cannot read stays `undefined` (i.e. unknown).
function pyprojectManager(raw: string): DependencyManager | undefined {
  if (/^\s*\[tool\.poetry[.\]]/m.test(raw)) return 'poetry';
  if (/^\s*\[tool\.pdm[.\]]/m.test(raw)) return 'pdm';
  if (/^\s*\[tool\.uv[.\]]/m.test(raw)) return 'uv';
  const backend = /^\s*build-backend\s*=\s*["']([^"']+)["']/m.exec(raw)?.[1];
  if (backend?.startsWith('poetry')) return 'poetry';
  if (backend?.startsWith('pdm')) return 'pdm';
  if (backend?.startsWith('setuptools')) return 'setuptools';
  return undefined;
}

// `src/` when the src-layout is used, otherwise the top-level import packages -- a root
// directory holding an `__init__.py` is Python's own definition of one, so this needs no
// guessing. Sorted, and capped so a pathological root cannot fill a report.
function pythonSourceRoots(reader: WorkspaceReader): string[] {
  const src = presentPaths(reader, PYTHON_SOURCE_ROOTS);
  if (src.length > 0) return src;
  return reader
    .list('')
    .filter((name) => !name.startsWith('.') && reader.exists(`${name}/__init__.py`))
    .sort()
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// Salesforce
// ---------------------------------------------------------------------------

function detectSalesforce(reader: WorkspaceReader): StackProfile | undefined {
  const projectRaw = reader.readFile('sfdx-project.json');
  if (projectRaw === undefined) return undefined;

  return {
    ecosystem: 'salesforce',
    detectedFrom: ['sfdx-project.json'],
    manager: 'sfdx',
    managerEvidence: 'sfdx-project.json',
    sourceRoots: salesforcePackageDirs(reader, projectRaw),
    // Deliberately EMPTY, not "unknown": Apex tests are not a directory. They are ordinary
    // classes inside the same package directories, marked `@isTest`, so there is no test root
    // to name and inventing one ('force-app/test') would be a fact this file made up.
    testRoots: [],
  };
}

// `packageDirectories[].path` is the sfdx project's own declaration of where its metadata
// lives. Declared paths that are not in the checkout are dropped (a partial clone, or a stale
// entry), but if NONE survive the declaration is reported as-is -- the project file is still
// the truth about intent, and silently emptying the list would read as "no sources".
function salesforcePackageDirs(reader: WorkspaceReader, projectRaw: string): string[] {
  const parsed = parseJsonObject(projectRaw);
  const dirs = parsed?.packageDirectories;
  if (!Array.isArray(dirs)) return presentPaths(reader, ['force-app']);
  const declared = dirs
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as { path?: unknown }).path : undefined))
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
    .map((value) => value.replace(/^\.\//, '').replace(/\/$/, ''));
  if (declared.length === 0) return presentPaths(reader, ['force-app']);
  const present = declared.filter((dir) => reader.exists(dir));
  return present.length > 0 ? present : declared;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

// One human-readable line per profile, for the gate report and the run log. A JSON blob in a
// report is a fact nobody reads; this says which ecosystems were found, WHICH FILES proved
// each one, and what the manager resolved to -- the three things an operator debugging a
// mis-gated tenant actually needs.
export function describeStack(profiles: readonly StackProfile[]): string[] {
  return profiles.map((profile) => {
    const parts = [
      `${profile.ecosystem}: ${profile.manager === 'unknown' ? 'manager undetermined' : profile.manager}`,
    ];
    if (profile.managerPin !== undefined) parts[0] += ` (pinned ${profile.managerPin})`;
    else if (profile.managerEvidence !== undefined) parts[0] += ` (from ${profile.managerEvidence})`;
    parts.push(
      profile.detectedFrom.length > 0 ? `detected from ${profile.detectedFrom.join(', ')}` : 'no manifest found',
    );
    if (profile.sourceRoots.length > 0) parts.push(`source ${profile.sourceRoots.join(', ')}`);
    if (profile.testRoots.length > 0) parts.push(`tests ${profile.testRoots.join(', ')}`);
    return parts.join(' — ');
  });
}
