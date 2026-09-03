// The generic Python tool gates: `python-ruff`, `python-mypy`, `python-pytest`.
//
// WHY THESE ARE GENERIC GATES AND NOT TENANT COMMAND GATES. `CommandGateSpec` runs a shell line
// from `PackConfig.commandGates`, which is a TENANT RECORD -- somebody has to write the line, per
// tenant, by hand, including the PEP 668 venv bootstrap. That is the state the Invoices-Wizard
// runbook documents, and it is the thing this change exists to remove: "a pyproject.toml repo
// gets the Python gate set with zero hand configuration" is only achievable if the gates are in
// the signed grant for EVERY tenant, because `enabledGateSpecs` runs server-side and the control
// plane cannot see a checkout. So the gates are always signed, always registered, and each one
// decides at RUN time -- from `ctx.stackProfiles`, which is assembled runner-side where the
// checkout is -- whether it has anything to judge.
//
// That design puts the whole weight on the skip/unjudged discipline, so it is spelled out here
// and the file has a test for every branch:
//
//   no Python profile in the checkout   -> skip / no-config   (benign: a Node repo has no ruff
//                                          to run, and saying so is not a verdict about it)
//   Python, tool not DECLARED           -> skip / no-config   (benign: see toolchain.ts's header
//                                          for why declaration is the opt-in)
//   Python, tool declared, no .py in    -> skip / no-matching-files  (non-benign: the gate has a
//     this diff (ruff/mypy only)           matcher and it selected nothing on THIS PR)
//   venv bootstrap failed               -> unjudged / infra   (blocking, one bounded retry)
//   declared tool not importable after  -> unjudged / infra   (blocking; "declared but absent"
//     a successful bootstrap                is NOT "clean")
//   tool could not be spawned / timed   -> unjudged / infra   (blocking)
//     out / blew its output budget
//   tool killed by a signal, or the     -> unjudged / infra   (126/127/128+N: `sh` reporting that
//     interpreter vanished                 it could not execute, not a code defect)
//   pytest collected zero tests         -> unjudged / content (blocking, escalates at once: a
//     (exit 5)                              suite that ran nothing is the false green itself)
//   tool exited non-zero                -> fail               (a real verdict about this diff)
//   tool exited zero                    -> pass
//
// There is NO path from an absent tool, an unreadable output, or a bootstrap that never completed
// to `pass`. That is the non-negotiable this repo has been burned by (TEK-3691) and it is why the
// probe in step 5 exists at all rather than trusting the tool's own exit code: a missing tool exits
// 1, which is indistinguishable from "the tool found defects" by exit code alone.
//
// TWO THINGS THE CHECKOUT MUST NOT BE ABLE TO DO BY ACCIDENT OR BY A ONE-FILE EDIT, both closed in
// toolchain.ts and relied on here: shadow the toolchain (nothing runs `python -m` with the checkout
// on `sys.path[0]` -- not the tools, and not the bootstrap's own `venv`/`pip`), and win the
// bootstrap race (a sentinel written last, plus the per-venv memo below).
//
// WHAT THIS DOES NOT CLAIM. Gating a Python repo means running its toolchain on its code, so
// PR-authored content necessarily executes and some of it can reach the environment:
// `pip install -e` runs the project's own build backend and `setup.py` AS THE RUNNER USER, so a
// repo with a build backend can write into `<venv>/bin` whatever this file does; pytest imports
// `conftest.py` and autoloads plugins; ruff and mypy read `[tool.*]` config out of the tree (which
// is why `--force-exclude` is not passed and pytest's `addopts` is overridden -- see ./index.ts).
// None of that is removable without ceasing to gate the repo. So the guarantee here is deliberately
// narrower than "the checkout cannot lie": no ACCIDENT (a top-level `pytest.py`, a `pip/`
// directory) and no trivial edit silently shadows a tool, and NO GATE REPORTS A `pass` FOR A TOOL
// THAT FAILED TO START.
//
// The clearest thing that is NOT covered: `conftest.py`. A `pytest_collection_modifyitems` hook
// that marks every item skip makes the suite exit 0, and nothing in the gate layer sees it --
// `structure`'s false-green scan reads changed TEST FILES for disable spellings and
// `assertion-delta` counts assertions in the DIFF; neither inspects collection behaviour, and an
// earlier version of this comment wrongly named them as the mitigation. The only backstop is
// pytest's exit-5 zero-collection guard below, which fires when nothing is COLLECTED -- not when
// items are collected and then skipped.
//
// Anything stronger (a sandbox, a container, a network-isolated install) is a runner-level control,
// not a gate-level one, and belongs with the same decision that lets a coding agent run the repo's
// tests at all.

import { tmpdir } from 'node:os';
import path from 'node:path';

import { runCommand, type RunCommandResult } from '../exec.ts';
import { boundedCapture } from '../output-capture.ts';
import { readerAt, type StackProfile, type WorkspaceReader } from '../stack-profile.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';
import {
  declarationOf,
  detectPythonToolchain,
  pythonBootstrapCommand,
  pythonProfileOf,
  PYTHON_VENV_ROOT_ENV,
  shellQuote,
  venvBin,
  venvDirFor,
  type PythonTool,
} from './toolchain.ts';

export interface PythonToolGateSpec {
  // The gate id AND the check name it reports under. Deliberately names the TOOL (`python-ruff`,
  // not `python-lint`): the first question asked of a red Python check is "which tool said that",
  // and it also keeps these ids clear of the `python-lint`/`python-tests` command-gate names the
  // Invoices-Wizard runbook proposes, so a tenant that already hand-wrote those does not collide
  // with these (run-gate-stage skips a command spec whose id is already registered -- a silent
  // swallow this naming avoids rather than relies on).
  id: string;
  tool: PythonTool;
  // The console script pip installs into `<venv>/bin`. Invoked by ABSOLUTE PATH, never as
  // `python -m <module>` -- see toolchain.ts's "WHY CONSOLE SCRIPTS" note.
  command: string;
  // Arguments before the file list. `files` is the diff's changed, present Python files; `roots`
  // is the profile's declared source roots, used when the file list is over the argv cap.
  argsFor(input: { profile: StackProfile; files: readonly string[] }): string[];
  // True when the gate judges only the changed files, so an empty Python diff is an honest
  // `no-matching-files` skip rather than a whole-tree run -- the file-matcher reason, not the
  // route one: these gates match FILES, and main split that vocabulary in two (gates/types.ts).
  diffScoped: boolean;
  // Exit codes that mean "ran but reached no verdict" rather than "found a defect".
  // pytest's 5 is the one that matters: "no tests were collected".
  noVerdictExitCodes?: ReadonlyMap<number, string>;
}

export interface PythonToolGateDeps {
  // Injected so the unit tests drive every branch with no venv, no network and no Python.
  run?: (command: string, args: string[], cwd: string, timeoutMs: number) => Promise<RunCommandResult>;
  reader?: (workspaceRoot: string) => WorkspaceReader;
  // Where the venv is rooted. Defaults to the OS temp dir -- outside the checkout, deliberately.
  tmpRoot?: string;
  bootstrapTimeoutMs?: number;
  toolTimeoutMs?: number;
}

const DEFAULT_BOOTSTRAP_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TOOL_TIMEOUT_MS = 15 * 60 * 1000;

// Above this many changed Python files the gate stops passing a file list and judges the declared
// source roots instead. A file list is preferable (it scopes the verdict to THIS diff and cannot
// block a PR on inherited debt), but an unbounded one is an argv the shell may refuse -- and a gate
// that fails to spawn is worse than one that judges a wider tree and says so.
const MAX_FILE_ARGS = 500;

// `sh` reports "I could not execute that" in this band: 126 (found, not executable), 127 (not
// found), and 128+N (killed by signal N). None of them is a verdict about the code. Before this was
// classified, a venv that vanished between the probe and the run -- reachable when a sibling gate
// rebuilds it -- surfaced as a `fail`, handing the fix loop an infra fault to "fix" in the diff.
function isExecFailureExit(exitCode: number): boolean {
  return exitCode === 126 || exitCode === 127 || exitCode >= 128;
}

function skip(id: string, reason: 'no-config' | 'no-matching-files', finding: string): GateResult {
  return { id, status: 'skip', skipReason: reason, findings: [finding] };
}

function unjudged(id: string, reason: 'infra' | 'content', findings: (string | undefined)[]): GateResult {
  return { id, status: 'unjudged', unjudgedReason: reason, findings: findings.filter((f): f is string => !!f) };
}

// A changed file this gate may hand to a tool: a `.py` path that is inside the checkout and still
// present in it. Deleted files are dropped (ruff/mypy error on a missing path, and a deletion is
// not something a linter has an opinion about); `..` escapes and absolute paths are dropped because
// the changed-file list is host-supplied and the paths are PR-authored.
function judgeableFiles(ctx: GateContext, reader: WorkspaceReader): string[] {
  return ctx.changedFiles.filter(
    (file) => file.endsWith('.py') && !file.split('/').includes('..') && !file.startsWith('/') && reader.exists(file),
  );
}

// ONE bootstrap per venv path per process, shared by every gate that asks for it.
//
// This is what actually serialises the `Promise.all` in run-gates.ts: all three Python gates run
// concurrently in ONE Node process against ONE workspace, so they resolve to one venv path and
// therefore await one promise. The shell-level `mkdir` lock in `pythonBootstrapCommand` covers the
// case this map cannot see (two processes sharing a workspace); the sentinel covers the case
// neither can (a venv left behind by an earlier run). All three are needed, and the map is the one
// that matters for the reproduced defect.
//
// Keyed by venv path, so two checkouts on one self-hosted runner do not share an entry. A REJECTED
// bootstrap is not cached: a transient failure must be retryable by the next gate stage.
const bootstrapsInFlight = new Map<string, Promise<RunCommandResult>>();

function bootstrapOnce(
  venvDir: string,
  run: () => Promise<RunCommandResult>,
): Promise<RunCommandResult> {
  const existing = bootstrapsInFlight.get(venvDir);
  if (existing !== undefined) return existing;
  const started = run().finally(() => {
    // Dropped once settled: the sentinel is the durable proof, and holding the entry forever would
    // make a second gate STAGE in the same process reuse a result about a checkout that has since
    // been re-cloned.
    bootstrapsInFlight.delete(venvDir);
  });
  bootstrapsInFlight.set(venvDir, started);
  return started;
}

// Steps 1-3 of the gate, as one pure decision: is there a Python tree, did the repo declare this
// tool, and does this diff give it anything to judge? Extracted so the async body below is only
// about RUNNING things -- and so every "nothing to do" answer is visibly a `skip` with a reason.
interface PythonWork {
  profile: StackProfile;
  toolchain: ReturnType<typeof detectPythonToolchain>;
  declaration: ReturnType<typeof declarationOf>;
  files: string[];
  roots: string[];
  overCap: boolean;
  targets: string[];
}

function selectWork(
  spec: PythonToolGateSpec,
  ctx: GateContext,
  makeReader: (workspaceRoot: string) => WorkspaceReader,
): PythonWork | { skipped: GateResult } {
  // 1. Is there a Python tree at all? `stackProfiles` is optional by contract, and ABSENT means
  //    "detection did not run", not "nothing here" -- either way this gate has no ground to stand
  //    on and must not claim one.
  const profile = pythonProfileOf(ctx.stackProfiles);
  if (!profile) {
    const seen = (ctx.stackProfiles ?? []).map((p) => p.ecosystem).join(', ');
    return {
      skipped: skip(
        spec.id,
        'no-config',
        `${spec.id} did not run: no Python tree was detected in this checkout ` +
          `(${seen === '' ? 'stack detection reported nothing' : `detected: ${seen}`}). ` +
          `Nothing was asserted about ${spec.tool}.`,
      ),
    };
  }

  // 2. Did the repo DECLARE this tool? See toolchain.ts's header for why declaration is the opt-in
  //    and why a blanket default would be wrong.
  const reader = makeReader(ctx.workspaceRoot);
  const toolchain = detectPythonToolchain(reader, profile);
  const declaration = declarationOf(toolchain, spec.tool);
  if (!declaration.declared) {
    return {
      skipped: skip(
        spec.id,
        'no-config',
        `${spec.id} did not run: this repo does not declare ${spec.tool}. Looked in ` +
          `[${declaration.lookedIn.join(', ') || 'no Python manifest'}] for a ${spec.tool} config table, a ` +
          `standalone ${spec.tool} config file, or "${spec.tool}" in a dependency list, and found none. ` +
          `This is "not adopted", not "clean": add ${spec.tool} to the project's dev dependencies (or a ` +
          `[tool.${spec.tool}] table) and this gate starts enforcing with no other configuration.`,
      ),
    };
  }

  // 3. Diff scope, for the gates that have one.
  const files = judgeableFiles(ctx, reader);
  if (spec.diffScoped && files.length === 0) {
    return {
      skipped: skip(
        spec.id,
        'no-matching-files',
        `${spec.id} examined 0 of ${ctx.changedFiles.length} changed file(s): none of them is a Python ` +
          `file present in the checkout, so ${spec.tool} asserted nothing on this PR.`,
      ),
    };
  }

  // Over the argv cap the gate judges the declared source roots -- and PASSES THEM EXPLICITLY.
  // Passing no paths at all was a bug with two faces: ruff silently defaults to `.` and judges the
  // whole tree (so a 501-file PR blocks on every inherited violation), while mypy exits 2 with a
  // usage error and the gate reports a blocking `unjudged`.
  const overCap = spec.diffScoped && files.length > MAX_FILE_ARGS;
  const roots = profile.sourceRoots.length > 0 ? [...profile.sourceRoots] : ['.'];
  const targets = spec.diffScoped ? (overCap ? roots : files) : [];
  return { profile, toolchain, declaration, files, roots, overCap, targets };
}

export function createPythonToolGate(spec: PythonToolGateSpec, deps: PythonToolGateDeps = {}): Gate {
  const run =
    deps.run ??
    ((command, args, cwd, timeoutMs): Promise<RunCommandResult> => runCommand(command, args, cwd, { timeoutMs }));
  const makeReader = deps.reader ?? readerAt;
  const bootstrapTimeoutMs = deps.bootstrapTimeoutMs ?? DEFAULT_BOOTSTRAP_TIMEOUT_MS;
  const toolTimeoutMs = deps.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

  return {
    id: spec.id,
    async run(ctx: GateContext): Promise<GateResult> {
      // Steps 1-3: does this gate have anything to judge here at all? Every outcome is a `skip`,
      // never a pass -- see the table in this file's header.
      const selection = selectWork(spec, ctx, makeReader);
      if ('skipped' in selection) return selection.skipped;
      const { profile, toolchain, declaration, files, roots, overCap, targets } = selection;
      const args = spec.argsFor({ profile, files });

      // 4. Bootstrap. PEP 668 makes this mandatory, not an optimisation -- see toolchain.ts. Run
      //    at most once per venv path per process, which is what serialises the concurrent gates.
      const venvRoot = deps.tmpRoot ?? tmpRootDefault();
      const venvDir = venvDirFor(ctx.workspaceRoot, venvRoot);
      const bootstrap = pythonBootstrapCommand(
        profile,
        venvDir,
        path.resolve(ctx.workspaceRoot),
        toolchain.manifestFingerprint,
        toolchain.installExtras,
        toolchain.toolBackstop,
      );
      let bootstrapResult: RunCommandResult;
      try {
        // cwd = the VENV'S PARENT, deliberately NOT the checkout. The bootstrap runs `python3 -m
        // venv` and `python -m pip`, and `-m` puts the cwd at `sys.path[0]` -- so with the checkout
        // as cwd a committed top-level `pip/` or `venv/` package is imported in preference to the
        // real one and can write exit-0 shims straight into `<venv>/bin`, which the probe then
        // validates. Every path in the script is absolute so nothing depends on the cwd.
        bootstrapResult = await bootstrapOnce(venvDir, () =>
          run('sh', ['-c', bootstrap], path.dirname(venvDir), bootstrapTimeoutMs),
        );
      } catch (err) {
        return unjudged(spec.id, 'infra', [
          `${spec.id} reached no verdict: the Python environment bootstrap could not run ` +
            `(${err instanceof Error ? err.message : String(err)}). No ${spec.tool} result was produced, and ` +
            `an audit that never ran is not a clean one.`,
          `bootstrap: ${bootstrap}`,
        ]);
      }
      if (bootstrapResult.exitCode !== 0) {
        return unjudged(spec.id, 'infra', [
          `${spec.id} reached no verdict: building the project virtualenv at ${venvDir} exited ` +
            `${bootstrapResult.exitCode}, so ${spec.tool} was never run. This gate always builds its own ` +
            `venv -- for toolchain isolation, to avoid installing into a shared runner, and because on ` +
            `an externally-managed interpreter (PEP 668, i.e. most distro Pythons and typically a ` +
            `self-hosted runner) a bare \`pip install\` is refused outright. If the venv build itself ` +
            `fails, the interpreter or the project's declared dependencies are the fault, not this diff.`,
          `bootstrap: ${bootstrap}`,
          boundedCapture(bootstrapResult.stderr) || boundedCapture(bootstrapResult.stdout),
        ]);
      }

      // 5. Presence probe. A missing tool exits 1 -- the SAME code as "the tool found defects".
      //    Without this probe the two are indistinguishable, and the failure mode is a gate that
      //    reports a fixable defect for a missing tool. `[ -x ]` AND `--version`: the first proves
      //    the console script is there, the second proves it can actually start.
      const toolPath = venvBin(venvDir, spec.command);
      let probe: RunCommandResult;
      try {
        // Also outside the checkout: `--version` still imports the tool's own package, and there is
        // no reason for that import to see PR-authored directories.
        probe = await run(
          'sh',
          ['-c', `[ -x ${shellQuote(toolPath)} ] && ${shellQuote(toolPath)} --version`],
          path.dirname(venvDir),
          bootstrapTimeoutMs,
        );
      } catch (err) {
        return unjudged(spec.id, 'infra', [
          `${spec.id} reached no verdict: could not probe for ${spec.tool} in the project virtualenv ` +
            `(${err instanceof Error ? err.message : String(err)}).`,
        ]);
      }
      if (probe.exitCode !== 0) {
        return unjudged(spec.id, 'infra', [
          `${spec.id} reached no verdict: ${spec.tool} is declared by this repo (${declaration.evidence}) but ` +
            `is not installed at \`${toolPath}\` after a successful bootstrap ` +
            `(the \`[ -x ] && --version\` probe exited ${probe.exitCode}). A declared tool that is not there ` +
            `is reported as unjudged, never as a pass: no ${spec.tool} verdict exists for this diff.`,
          boundedCapture(probe.stderr) || boundedCapture(probe.stdout),
        ]);
      }

      // 6. The real run. Only the PR-authored file paths are quoted arguments; the tool path is a
      //    console script inside the venv, which is outside the checkout. `--` separates them so a
      //    committed `-x.py` is read as a path, not as an option.
      const quoted = targets.map(shellQuote);
      const line = [
        shellQuote(toolPath),
        ...args,
        ...(quoted.length > 0 ? ['--', ...quoted] : []),
      ].join(' ');
      let result: RunCommandResult;
      try {
        result = await run('sh', ['-c', line], ctx.workspaceRoot, toolTimeoutMs);
      } catch (err) {
        return unjudged(spec.id, 'infra', [
          `${spec.id} reached no verdict: \`${line}\` could not run to completion ` +
            `(${err instanceof Error ? err.message : String(err)}) -- a spawn failure, a timeout, or an ` +
            `output overrun. No ${spec.tool} verdict was produced.`,
        ]);
      }

      return classifyToolResult(spec, result, line, () => describeScope(spec, declaration.evidence, files, roots, overCap));
    },
  };
}

// Step 6's verdict, split out so the ordering of the four outcomes is readable in one screen -- and
// so it cannot drift: an exec failure OUTRANKS a `noVerdictExitCodes` entry, because 126/127/128+N
// are the shell's, not the tool's, and a tool that never started cannot have "collected no tests".
function classifyToolResult(
  spec: PythonToolGateSpec,
  result: RunCommandResult,
  line: string,
  passFinding: () => string,
): GateResult {
  if (isExecFailureExit(result.exitCode)) {
    return unjudged(spec.id, 'infra', [
      `${spec.id} reached no verdict: \`${line}\` exited ${result.exitCode}, which is the shell reporting ` +
        `that it could not execute the tool (126/127) or that the tool was killed by a signal (128+N), ` +
        `not a verdict about the code. The interpreter or the virtualenv went away between the probe and ` +
        `the run.`,
      boundedCapture(result.stderr) || boundedCapture(result.stdout),
    ]);
  }

  const noVerdict = spec.noVerdictExitCodes?.get(result.exitCode);
  if (noVerdict !== undefined) {
    return unjudged(spec.id, 'content', [
      `${spec.id} reached no verdict: ${noVerdict} (\`${line}\` exited ${result.exitCode}).`,
      boundedCapture(result.stdout) || boundedCapture(result.stderr),
    ]);
  }

  if (result.exitCode !== 0) {
    return {
      id: spec.id,
      status: 'fail',
      findings: [
        `\`${line}\` exited ${result.exitCode}`,
        // A linter prints its findings on STDOUT and its own failures on stderr, the inverse of the
        // command gate's assumption -- so stdout leads here and stderr is the fallback. Bounded
        // head-and-tail, so the fixer gets the first error AND the summary.
        boundedCapture(result.stdout) || boundedCapture(result.stderr),
      ].filter((detail) => detail !== ''),
    };
  }

  return { id: spec.id, status: 'pass', findings: [passFinding()] };
}

// A pass says exactly WHAT it judged. "found no problems" over an unstated scope is how a gate that
// examined nothing reads identical to one that examined everything.
function describeScope(
  spec: PythonToolGateSpec,
  evidence: string | undefined,
  files: readonly string[],
  roots: readonly string[],
  overCap: boolean,
): string {
  const scope = !spec.diffScoped
    ? 'the whole suite'
    : overCap
      ? `the declared source roots (${roots.join(', ')}) — the diff changed ${files.length} Python files, ` +
        `over this gate's ${MAX_FILE_ARGS}-file argv cap`
      : `${files.length} changed Python file(s)`;
  return `${spec.id} ran ${spec.tool} (declared by ${evidence}) over ${scope} and found no problems`;
}

// Where venvs are rooted when the caller does not say. Read at call time, not at module load, so
// an operator can point every venv at a big scratch volume (`AUTOPILOT_PYTHON_VENV_ROOT`) on a
// self-hosted runner whose /tmp is small, without a restart.
function tmpRootDefault(): string {
  return process.env[PYTHON_VENV_ROOT_ENV] ?? tmpdir();
}
