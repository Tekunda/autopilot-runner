// What a Python checkout DECLARES about its own toolchain, and how to get an interpreter that
// can run it. Pure over a WorkspaceReader (gates/stack-profile.ts), so every branch is testable
// from an object literal.
//
// THE RULE THIS FILE EXISTS TO ENCODE -- DECLARED-TOOL-DRIVEN, NOT BLANKET:
//
// `ruff`, `mypy` and `pytest` are all "default" Python gates in the sense that no tenant has to
// name them in config. They are NOT default in the sense of "run on every Python repo". A gate
// runs iff THE REPO ITSELF declared that tool, and the declaration is read out of the repo's own
// manifests -- which is what makes the whole set zero-configuration: the opt-in already exists,
// written by the people who own the tree, and nothing has to be duplicated into a tenant record.
//
// The concrete case that decides it is the live one. The live Python tenant declares `pytest`
// and `ruff` in `[project.optional-dependencies].dev`, and configures `[tool.ruff]` and
// `[tool.pytest.ini_options]`. It declares NO mypy and carries NO `[tool.mypy]`. A blanket mypy
// default would run a type checker over a large un-annotated code base and emit thousands of
// `error: Function is missing a type annotation` / `Cannot find implementation or library stub`
// findings -- a red, merge-blocking gate on the tenant's very first PR, reporting a "defect" the
// repo never signed up for and that no diff-scoped fix can clear. That is not a strict gate, it
// is a broken one: it fails a repo for not having adopted an optional tool. Meanwhile a repo that
// HAS adopted mypy (a `[tool.mypy]` table, a `mypy.ini`, mypy in its dev extras) has stated the
// invariant it wants held, and gating on it is exactly right.
//
// The inverse half matters just as much: a repo that declares nothing gets `skip`/`no-config` --
// benign, because the gate genuinely has nothing to do (gate-verdict-ledger's SKIP_CLASSES) --
// and NEVER a `pass`. "This repo does not use mypy" and "mypy found no type errors" are different
// facts and this codebase has been burned by conflating them.
//
// A false POSITIVE here is just as costly as a false negative, and by a route that is easy to
// miss: a tool "declared" by a comment or a URL makes the gate bootstrap, probe, and return a
// BLOCKING `unjudged`/`infra` that no edit to the diff can clear. That is why declarations are
// read out of real dependency containers by ./manifest-scan.ts rather than by searching the file.
//
// NOT A POLICY INPUT. Like `stackProfiles` itself, everything here is filesystem-derived from the
// PR checkout, assembled runner-side, and out of the signed grant. It decides what a gate CAN
// judge, never what a tenant is allowed to do.

import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  declaresDistribution,
  iniDependencies,
  pyprojectDependencies,
  requirementsDependencies,
  stripTomlComments,
  type PythonManifestDependencies,
} from './manifest-scan.ts';
import type { StackProfile, WorkspaceReader } from '../stack-profile.ts';

// The Python tools the gate layer can run. One entry per gate; adding a tool means adding a
// member here, a detection rule in TOOL_RULES, and a gate in ./index.ts.
export type PythonTool = 'ruff' | 'mypy' | 'pytest';

export interface PythonToolDeclaration {
  tool: PythonTool;
  declared: boolean;
  // The workspace-relative file (and, where it matters, the table/key inside it) that proved the
  // declaration. Absent exactly when `declared` is false. This is the audit trail an operator
  // needs to answer "why did python-mypy skip on my repo" without guessing.
  evidence?: string;
  // Every place that WAS looked at, declared or not, so a skip finding can say what it checked
  // rather than just that it found nothing.
  lookedIn: readonly string[];
}

export interface PythonToolchain {
  // The profile this toolchain was derived from -- the caller has already decided the repo is
  // Python; this carries the roots and the manager along so a gate need not re-find them.
  profile: StackProfile;
  declarations: readonly PythonToolDeclaration[];
  // The declared tools, which the bootstrap installs by name as its last step -- see
  // `pythonInstallCommand`'s "DECLARED MUST IMPLY INSTALLED".
  toolBackstop: readonly PythonTool[];
  // EVERY recognised dev-ish extra the project declares, installed as `.[dev,test]`. Plural
  // because installing only the first is how a repo that puts pytest in `test` and black in `dev`
  // ended up with a "declared" tool that was never installed.
  installExtras: readonly string[];
  // A digest of every dependency manifest's CONTENT. The bootstrap sentinel carries it, so a
  // surviving venv on a long-lived self-hosted runner is reused only while the manifests are
  // unchanged -- see `pythonBootstrapCommand`.
  manifestFingerprint: string;
}

// ---------------------------------------------------------------------------
// Manifest reading
// ---------------------------------------------------------------------------

interface Manifests {
  pyproject?: string;
  setupCfg?: string;
  toxIni?: string;
  requirements: ReadonlyMap<string, string>;
  present: ReadonlySet<string>;
}

const STANDALONE_CONFIGS = [
  '.ruff.toml',
  'ruff.toml',
  'mypy.ini',
  '.mypy.ini',
  'pytest.ini',
  '.pytest.ini',
  'tox.ini',
  'setup.cfg',
] as const;

function readManifests(reader: WorkspaceReader): Manifests {
  const requirements = new Map<string, string>();
  for (const name of reader.list('')) {
    if (!/^requirements.*\.txt$/.test(name)) continue;
    const raw = reader.readFile(name);
    if (raw !== undefined) requirements.set(name, raw);
  }
  const present = new Set(STANDALONE_CONFIGS.filter((name) => reader.exists(name)));
  const pyproject = reader.readFile('pyproject.toml');
  const setupCfg = reader.readFile('setup.cfg');
  const toxIni = reader.readFile('tox.ini');
  return {
    ...(pyproject !== undefined ? { pyproject } : {}),
    ...(setupCfg !== undefined ? { setupCfg } : {}),
    ...(toxIni !== undefined ? { toxIni } : {}),
    requirements,
    present,
  };
}

// A table header counts as an opt-in on its own: a repo does not configure a linter it never runs.
// Comments are stripped first, so a commented-out `# [tool.mypy]` is not a declaration.
function hasTable(raw: string | undefined, table: string): boolean {
  if (raw === undefined) return false;
  return new RegExp(String.raw`^\s*\[${table.replace(/\./g, '\\.')}[.\]]`, 'm').test(stripTomlComments(raw));
}

function hasIniSection(raw: string | undefined, section: string): boolean {
  if (raw === undefined) return false;
  return new RegExp(String.raw`^\s*\[${section.replace(/[.:]/g, '\\$&')}\]`, 'm').test(stripTomlComments(raw));
}

// ---------------------------------------------------------------------------
// Per-tool declaration rules
// ---------------------------------------------------------------------------

interface ToolRule {
  tool: PythonTool;
  distribution: string;
  pyprojectTables: readonly string[];
  configFiles: readonly string[];
  iniSections: readonly string[];
}

const TOOL_RULES: readonly ToolRule[] = [
  { tool: 'ruff', distribution: 'ruff', pyprojectTables: ['tool.ruff'], configFiles: ['.ruff.toml', 'ruff.toml'], iniSections: [] },
  { tool: 'mypy', distribution: 'mypy', pyprojectTables: ['tool.mypy'], configFiles: ['mypy.ini', '.mypy.ini'], iniSections: ['mypy'] },
  {
    tool: 'pytest',
    distribution: 'pytest',
    pyprojectTables: ['tool.pytest.ini_options'],
    configFiles: ['pytest.ini', '.pytest.ini'],
    iniSections: ['pytest', 'tool:pytest'],
  },
];

function declarationFor(
  rule: ToolRule,
  manifests: Manifests,
  deps: Map<string, PythonManifestDependencies>,
): PythonToolDeclaration {
  const lookedIn: string[] = [];
  const declares = (file: string): boolean => declaresDistribution(deps.get(file)?.requirements ?? [], rule.distribution);

  // Ordered by how strongly each source states an opt-in: a config TABLE first (a repo does not
  // configure a linter it never runs), then a standalone config file, then a dependency list.
  const sources: (() => string | undefined)[] = [
    () => pyprojectEvidence(rule, manifests, lookedIn, declares),
    () => standaloneConfigEvidence(rule, manifests, lookedIn),
    () => iniEvidence(rule, manifests, lookedIn, declares),
    () => requirementsEvidence(rule, manifests, lookedIn, declares),
  ];
  for (const source of sources) {
    const evidence = source();
    if (evidence !== undefined) return { tool: rule.tool, declared: true, evidence, lookedIn };
  }
  return { tool: rule.tool, declared: false, lookedIn };
}

function pyprojectEvidence(
  rule: ToolRule,
  manifests: Manifests,
  lookedIn: string[],
  declares: (file: string) => boolean,
): string | undefined {
  if (manifests.pyproject === undefined) return undefined;
  lookedIn.push('pyproject.toml');
  for (const table of rule.pyprojectTables) {
    if (hasTable(manifests.pyproject, table)) return `pyproject.toml [${table}]`;
  }
  return declares('pyproject.toml') ? `pyproject.toml (declares "${rule.distribution}")` : undefined;
}

function standaloneConfigEvidence(rule: ToolRule, manifests: Manifests, lookedIn: string[]): string | undefined {
  for (const file of rule.configFiles) {
    lookedIn.push(file);
    if (manifests.present.has(file)) return file;
  }
  return undefined;
}

function iniEvidence(
  rule: ToolRule,
  manifests: Manifests,
  lookedIn: string[],
  declares: (file: string) => boolean,
): string | undefined {
  for (const [file, raw] of [
    ['setup.cfg', manifests.setupCfg],
    ['tox.ini', manifests.toxIni],
  ] as const) {
    if (raw === undefined) continue;
    lookedIn.push(file);
    for (const section of rule.iniSections) {
      if (hasIniSection(raw, section)) return `${file} [${section}]`;
    }
    if (declares(file)) return `${file} (declares "${rule.distribution}")`;
  }
  return undefined;
}

function requirementsEvidence(
  rule: ToolRule,
  manifests: Manifests,
  lookedIn: string[],
  declares: (file: string) => boolean,
): string | undefined {
  for (const file of manifests.requirements.keys()) {
    lookedIn.push(file);
    if (declares(file)) return `${file} (declares "${rule.distribution}")`;
  }
  return undefined;
}

// The extras a project might put its linters and test runner in, most conventional first. The
// bootstrap installs the FIRST one the project actually declares, which is what makes the tools
// present without any tenant configuration.
const DEV_EXTRA_PREFERENCE = ['dev', 'test', 'tests', 'develop', 'dev-dependencies', 'lint', 'all'] as const;

// ALL of them, not the first. `[project.optional-dependencies]` with `dev = ["black"]` and
// `test = ["pytest"]` is ordinary, and installing only `dev` left pytest declared-but-absent -- a
// blocking `unjudged`/`infra` on every PR that no edit to the diff can clear. `pip install
// -e '.[dev,test]'` costs nothing extra when only one exists.
function pickInstallExtras(extras: readonly string[]): string[] {
  const lowered = new Map(extras.map((extra) => [extra.toLowerCase(), extra] as const));
  return DEV_EXTRA_PREFERENCE.map((candidate) => lowered.get(candidate)).filter(
    (extra): extra is string => extra !== undefined,
  );
}

// The one entry point: what does this checkout declare?
export function detectPythonToolchain(reader: WorkspaceReader, profile: StackProfile): PythonToolchain {
  const manifests = readManifests(reader);
  const deps = new Map<string, PythonManifestDependencies>();
  deps.set('pyproject.toml', pyprojectDependencies(manifests.pyproject));
  deps.set('setup.cfg', iniDependencies(manifests.setupCfg));
  deps.set('tox.ini', iniDependencies(manifests.toxIni));
  for (const [file, raw] of manifests.requirements) deps.set(file, requirementsDependencies(raw));

  const extras = [...(deps.get('pyproject.toml')?.extras ?? []), ...(deps.get('setup.cfg')?.extras ?? [])];
  const installExtras = pickInstallExtras(extras);

  // Every manifest's CONTENT, in a stable order, so a pin bump changes the digest.
  const digest = createHash('sha256');
  for (const [name, raw] of [
    ['pyproject.toml', manifests.pyproject],
    ['setup.cfg', manifests.setupCfg],
    ['setup.py', reader.readFile('setup.py')],
    ...[...manifests.requirements.entries()].sort(([a], [b]) => a.localeCompare(b)),
  ] as const) {
    digest.update(`${name}\u0000${raw ?? ''}\u0000`);
  }

  const declarations = TOOL_RULES.map((rule) => declarationFor(rule, manifests, deps));
  return {
    profile,
    declarations,
    installExtras,
    // DECLARED MUST IMPLY INSTALLED. Everything above reads what the repo SAYS; this is the list
    // that makes it true. See `pythonInstallCommand`.
    toolBackstop: declarations.filter((declaration) => declaration.declared).map((declaration) => declaration.tool),
    manifestFingerprint: digest.digest('hex').slice(0, 16),
  };
}

export function declarationOf(toolchain: PythonToolchain, tool: PythonTool): PythonToolDeclaration {
  return (
    toolchain.declarations.find((declaration) => declaration.tool === tool) ?? { tool, declared: false, lookedIn: [] }
  );
}

// The one Python profile in a detected stack, if any. A polyglot repo (Python service + an LWC or
// Next.js front end) legitimately carries more than one profile and `stackProfiles` is explicitly
// NOT a ranking, so this asks the only question a Python gate has: is there a Python tree here?
export function pythonProfileOf(profiles: readonly StackProfile[] | undefined): StackProfile | undefined {
  return profiles?.find((profile) => profile.ecosystem === 'python');
}

// ---------------------------------------------------------------------------
// The interpreter -- PEP 668, and why the venv is NOT in the checkout
// ---------------------------------------------------------------------------

// WHY A VENV AT ALL. Three reasons, and the order matters because the first one is conditional
// while the other two always hold.
//
//   1. PEP 668. The composite runner action does `actions/setup-node` + `npm ci` for its own code
//      and nothing else, so a Python gate arrives on a runner with a SYSTEM interpreter and no
//      project environment. On an EXTERNALLY-MANAGED interpreter -- most distro Pythons, and
//      specifically the SELF-HOSTED runners tenants use -- a bare `pip install -e '.[dev]'` fails
//      with `error: externally-managed-environment` before anything is installed. A gate that
//      shells straight to `ruff` then does not lint an un-linted repo: it fails to start, and the
//      naive reading of that failure ("the linter is unhappy") is a red gate nobody can fix.
//
//      NOT universal, and it was wrong to write it as if it were: GitHub's HOSTED images delete the
//      `EXTERNALLY-MANAGED` marker during provisioning, so ubuntu-latest's `python3` accepts a bare
//      install. This is about the environments we do not control, not about every runner.
//   2. ISOLATION. Whatever the runner already has installed -- a different ruff, a plugin, a
//      half-configured mypy -- must not decide a tenant's verdict. The venv is built from the
//      project's own manifests and nothing else.
//   3. NOT POLLUTING THE MACHINE. A long-lived self-hosted runner is shared across every job it
//      ever runs; installing a tenant's dependency tree into its system site-packages would leak
//      one repo's pins into the next repo's gate run.
//
// WHY IT IS OUTSIDE THE CHECKOUT. The first cut built it at `<checkout>/.venv`, and that is a hole:
// the checkout is PR-AUTHORED. A branch that commits `.venv/bin/python` (or `.venv/bin/ruff`)
// supplies its own "toolchain", the `[ -x ... ]` guard sees it, and the gate then probes and runs a
// shim that can exit 0 without checking anything. Rooting the venv in the OS temp directory, keyed
// by a digest of the workspace path, puts it somewhere no PR can write to. The three gates in one
// stage still share it because the key is deterministic.
//
// WHY CONSOLE SCRIPTS, NOT `python -m`. `python -m ruff` puts the CWD at `sys.path[0]`, ahead of the
// venv's site-packages -- and the CWD is the checkout. A committed `ruff/__main__.py` (or a
// top-level `pytest.py`, which happens by ACCIDENT) is imported in preference to the real tool, so
// both the probe and the run execute PR-authored code. Measured on one repo, the same violations:
// without the shim `python-ruff` reported them; with a three-line `ruff/__main__.py` that printed
// a version and exited 0 it PASSED. The venv's console scripts (`<venv>/bin/ruff`) are absolute
// paths outside the checkout and resolve nothing from the CWD.
export const PYTHON_VENV_ROOT_ENV = 'AUTOPILOT_PYTHON_VENV_ROOT';

// Where this checkout's venv lives. Deterministic (so one stage's gates share it), outside the
// checkout (so no PR can plant one), and keyed by the workspace path (so two checkouts on one
// self-hosted runner do not collide).
export function venvDirFor(workspaceRoot: string, tmpRoot: string): string {
  const key = createHash('sha256').update(path.resolve(workspaceRoot)).digest('hex').slice(0, 16);
  // An EMPTY or RELATIVE root would `path.join` to a relative path, which resolves against the
  // gate's cwd -- the checkout -- putting the venv straight back inside the tree this design moves
  // it out of. `AUTOPILOT_PYTHON_VENV_ROOT=''` reaches here as `''` (empty string is not nullish,
  // so `??` does not catch it), so the guard is here rather than at the env read.
  const root = path.isAbsolute(tmpRoot) ? tmpRoot : tmpdir();
  return path.join(root, `autopilot-python-venv-${key}`);
}

export function venvBin(venvDir: string, name: string): string {
  return path.join(venvDir, 'bin', name);
}

// Written LAST, and only on a fully successful bootstrap. Its presence -- not the presence of
// `bin/python` -- is what a later gate tests. See `pythonBootstrapCommand`.
function venvSentinel(venvDir: string): string {
  return path.join(venvDir, '.autopilot-bootstrap-ok');
}

// Single-quote for `sh -c`. Paths here come from the detector's own fixed patterns and from
// `os.tmpdir()` rather than from PR-authored text, but the quoting is not optional on principle:
// this string is handed to a shell, and a detector that one day lists a filename from the tree must
// not be the thing that makes it an injection.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

// The install step. Returned as a `sh -c` fragment rather than an argv because it is a sequence,
// and because it is exactly what an operator will want to paste into a terminal to reproduce a
// bootstrap failure.
//
// EVERY manager routes through `python3 -m venv` + pip rather than through poetry/uv/pdm's own
// environment machinery. That is a deliberate narrowing, not an oversight: those tools are
// themselves absent from a clean runner, so "use poetry" begins with "install poetry", which begins
// with PEP 668 again. pip installing from the project's own manifest gets the declared dev tools in
// every case; what it does NOT do is honour a lockfile's pinned transitive set. The gates run
// linters and a test suite, not a dependency audit, so a resolved-vs-locked difference cannot
// silently turn a finding into a pass -- and the dependency audit deliberately does not run here at
// all (see cve.ts and ./index.ts).
//
// NO `|| <fallback>` ON THE EXTRAS INSTALL. The first cut wrote
// `pip install -e '.[dev]' || pip install -e .`, which DISCARDS the real error: a project whose dev
// extra fails to resolve (a dev extra routinely pulls native wheels and a browser driver) then
// bootstrapped "successfully" without its tools, and the gate reported the misleading "declared
// but not installed after a successful bootstrap". The extra is now only named when the manifest
// actually declares it, so a failure to install it is a real failure with its own error text.
export function pythonInstallCommand(
  profile: StackProfile,
  workspaceRoot: string,
  installExtras: readonly string[],
  toolBackstop: readonly PythonTool[],
): string {
  const pip = '"$venv/bin/python" -m pip install -q';
  const steps: string[] = [];
  const requirements = profile.detectedFrom.filter((name) => /^requirements.*\.txt$/.test(name));
  const hasProjectManifest =
    profile.detectedFrom.includes('pyproject.toml') ||
    profile.detectedFrom.includes('setup.py') ||
    profile.detectedFrom.includes('setup.cfg');

  // ABSOLUTE paths, because the bootstrap does NOT run with the checkout as its cwd -- see
  // `pythonBootstrapCommand`. `-e '<abs path>[dev,test]'` is pip's documented spelling for an
  // editable install of a project elsewhere on disk.
  if (hasProjectManifest) {
    const target = installExtras.length > 0 ? `${workspaceRoot}[${installExtras.join(',')}]` : workspaceRoot;
    steps.push(`${pip} -e ${shellQuote(target)}`);
  }
  for (const file of requirements) steps.push(`${pip} -r ${shellQuote(`${workspaceRoot}/${file}`)}`);

  // DECLARED MUST IMPLY INSTALLED, and until this step it did not.
  //
  // Three ordinary repos ended up with a tool this file reports as DECLARED and the probe then
  // finds absent -- a blocking `unjudged`/`infra`, escalated to a human, unfixable by any edit to
  // the diff, which is the precise failure the declared-tool rule exists to prevent:
  //   - a tool in an extra we do not install (`dev = ["black"]`, `test = ["pytest"]`);
  //   - poetry's `[tool.poetry.group.dev.dependencies]`, which are NOT PEP 621 extras -- pip
  //     installs nothing for them, and `pip install -e '.[dev]'` merely WARNS and exits 0;
  //   - PEP 735 `[dependency-groups]` (uv), which need `pip install --group`, not `.[dev]`.
  //
  // Rather than model three packaging dialects, the last step installs the declared tools BY NAME.
  // pip does not upgrade an already-satisfied requirement, so this is a no-op whenever the
  // project's own install already provided the tool (pins intact); it only fires when the tool
  // would otherwise have been missing. Unversioned on purpose: a version this file invented would
  // be a fact about the repo that nobody wrote.
  if (toolBackstop.length > 0) steps.push(`${pip} ${toolBackstop.map(shellQuote).join(' ')}`);

  if (steps.length === 0) {
    // A Python tree proved by a lockfile alone (poetry.lock with no committed pyproject in the
    // checkout -- a partial clone). There is nothing to install from, so the venv is built bare and
    // the tool probe reports the tool as missing rather than inventing an install.
    return ':';
  }
  return steps.join('; ');
}

// The full bootstrap, as ONE `sh -c` script.
//
// IT MUST NOT RUN WITH THE CHECKOUT AS ITS CWD. `python3 -m venv` and `python -m pip` are both
// `-m`, which puts the cwd at `sys.path[0]` -- so a committed top-level `pip/` or `venv/` package
// is imported in preference to the real one. Verified end to end with this file's own generated
// script: a `pip/__main__.py` that writes exit-0 shims into `<venv>/bin` made the bootstrap exit 0,
// the sentinel get written, the probe pass, and all three gates report `pass` having linted and
// tested nothing. Hardening only the tool INVOCATION (console scripts, absolute paths) closed half
// the hole; the other half is here. `venv/` and `pip/` at a repo root also happen by accident.
//
// So the caller runs this with cwd = the venv's parent (outside the checkout), and every path the
// script touches is absolute. `pythonInstallCommand` is written for that.
//
// WHAT THIS STILL DOES NOT PREVENT, stated plainly rather than overclaimed: `pip install -e` runs
// the project's own build backend (`[build-system] requires`, `setup.py`), which is PR-authored and
// executes as the runner user, and can therefore write into `<venv>/bin` itself. That is inherent
// to installing a Python project at all -- there is no gating a repo without running its build. The
// guarantee this file does make is narrower and is the one that was broken: nothing is shadowed by
// ACCIDENT, and no gate reports a verdict for a tool that never ran.
//
// THE RACE THIS SHAPE EXISTS TO CLOSE. `runGates` is `Promise.all`, so all three Python gates enter
// the bootstrap against the same workspace at the same moment. `python3 -m venv` creates
// `bin/python` BEFORE ensurepip and long before the install, so a guard of
// `[ -x <venv>/bin/python ]` returns true MID-BOOTSTRAP: a sibling short-circuits the whole block
// and then probes an empty venv. Reproduced through the real `runGates` on this repo's own fixture
// at roughly 1 in 6-8 runs, as `python-pytest unjudged infra ... No module named pytest`. On the
// live tenant exactly two gates bootstrap concurrently, and `unjudged` cannot be excused by
// `blocking:false`, so it is a nondeterministic HARD WEDGE on the customer's first PR. Concurrent
// `pip install` into one environment is not safe on its own terms either.
//
// Two guards, both required:
//   - the SENTINEL. Written last, after every install returns 0, and carrying the manifest
//     fingerprint. It is the only thing tested, so a half-built venv is never mistaken for a
//     finished one -- and a stale venv surviving on a long-lived SELF-HOSTED runner (the live
//     tenant has three) is rebuilt when a PR bumps a pin, instead of silently gating against the
//     old dependency set. The WAITER checks the fingerprint too: a sibling that is part-way through
//     `rm -rf`-ing a stale venv would otherwise hand the waiter a sentinel for a tree being deleted.
//   - the LOCK. `mkdir` is atomic on every POSIX filesystem, so it is the lock: the loser waits for
//     the sentinel rather than racing the installer. The in-process caller (tool-gate.ts) also
//     memoises the bootstrap per venv path, which is what actually serialises the `Promise.all`
//     case; this is the belt to that's braces, and covers two processes sharing a workspace.
//
// Paths are bound to shell VARIABLES once at the top rather than interpolated at each use. That is
// not tidiness: the `trap` body is itself a quoted string, so a single-quoted path spliced into it
// terminates the trap's own quoting and the cleanup silently becomes a different command.
export function pythonBootstrapCommand(
  profile: StackProfile,
  venvDir: string,
  workspaceRoot: string,
  fingerprint: string,
  installExtras: readonly string[] = [],
  toolBackstop: readonly PythonTool[] = [],
): string {
  return [
    'set -e',
    `venv=${shellQuote(venvDir)}`,
    `lock=${shellQuote(`${venvDir}.lock`)}`,
    `sentinel=${shellQuote(venvSentinel(venvDir))}`,
    `stamp=${shellQuote(fingerprint)}`,
    'ready() { [ -f "$sentinel" ] && [ "$(cat "$sentinel" 2>/dev/null)" = "$stamp" ]; }',
    // Fast path: a complete venv built from these exact manifests.
    'if ready; then exit 0; fi',
    // Contend for the right to build. `mkdir` fails if the directory exists, atomically.
    'if mkdir "$lock" 2>/dev/null; then',
    // INT/TERM/HUP as well as EXIT: `execFile`'s timeout kills the child with SIGTERM, and an
    // untrapped signal terminates `sh` WITHOUT running the EXIT trap -- orphaning the lock in
    // exactly the case the reclaim below was written for.
    `  trap 'rmdir "$lock" 2>/dev/null || true' EXIT INT TERM HUP`,
    // A venv from a DIFFERENT manifest set, or a half-built one, is removed rather than patched.
    '  rm -rf "$venv"',
    '  python3 -m venv "$venv"',
    '  "$venv/bin/python" -m pip install -q --upgrade pip',
    `  ${pythonInstallCommand(profile, workspaceRoot, installExtras, toolBackstop)}`,
    // LAST. Everything above returned 0, so the sentinel means "this venv is finished".
    `  printf '%s' "$stamp" > "$sentinel"`,
    'else',
    // Another builder holds the lock. Wait for its sentinel rather than racing it -- and stop early
    // if the lock vanishes without one, so a failed builder does not cost every sibling the full
    // wait. The bound is deliberately SHORTER than the caller's 10-minute exec timeout: at parity
    // the process is killed on the same tick and the reclaim below could never run.
    '  i=0',
    '  while ! ready && [ $i -lt 240 ]; do',
    '    if [ ! -d "$lock" ]; then sleep 1; break; fi',
    '    sleep 1; i=$((i+1))',
    '  done',
    // Still nothing: the holder is gone without finishing (a SIGKILL -- every other exit runs the
    // trap above). Reclaim the lock so the NEXT run can build, instead of wedging this workspace at
    // `unjudged`/`infra` forever on a long-lived self-hosted runner.
    '  if ! ready; then rmdir "$lock" 2>/dev/null || true; fi',
    '  ready',
    'fi',
  ].join('\n');
}
