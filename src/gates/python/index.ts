// The default Python gate set. Registered unconditionally alongside the generic gates
// (gates/generic/index.ts), so `enabledGateSpecs` signs one `{kind:'generic'}` spec per gate for
// every tenant and the runner can execute it. Each gate then decides at run time, from the
// checkout, whether it has anything to judge -- see ./tool-gate.ts for the full outcome table and
// why "generic gate + run-time self-selection" is the only shape that can deliver the acceptance
// bar ("a pyproject.toml repo gets the Python gate set with zero hand configuration").
//
// WHAT IS DELIBERATELY NOT HERE: a Python DEPENDENCY AUDIT. `cve` owns that, and now routes a
// `pyproject.toml` tree through `osv-scanner` (provisioned by action.yml, pinned by version and
// SHA-256, verified, cached, re-verified on a cache hit). A `pip-audit` gate here would be a SECOND
// scanner with a second provisioning story and a second advisory source to keep honest, on the one
// gate class whose whole recorded history is about audits that silently audited nothing. One
// scanner, provisioned once -- so a Python tenant's dependency coverage arrives through `cve` with
// nothing to configure and nothing duplicated here.

import type { Gate } from '../types.ts';
import { createPythonToolGate, type PythonToolGateDeps } from './tool-gate.ts';

// ruff's own convention: 0 clean, 1 violations found, 2 ruff itself failed (unreadable config,
// bad argument). Only 1 is a verdict about the code.
const RUFF_NO_VERDICT = new Map<number, string>([
  [2, 'ruff itself failed to run (an unreadable configuration or a rejected argument), so it never judged the code'],
]);

// mypy: 0 clean, 1 type errors, 2 a fatal/usage error (a missing file, an unreadable config).
const MYPY_NO_VERDICT = new Map<number, string>([
  [2, 'mypy exited with a fatal or usage error, so no type-checking verdict was produced'],
]);

// pytest's documented exit codes. Only 1 ("tests were collected and run, some failed") is a
// verdict about the code. 5 is the one that matters most here: a suite that collected ZERO tests
// exits 5, and reading that as a pass is the exact false-green this gate layer exists to ban.
const PYTEST_NO_VERDICT = new Map<number, string>([
  [2, 'the test run was interrupted before it finished, so the suite reached no verdict'],
  [3, 'pytest hit an internal error, so the suite reached no verdict'],
  [4, 'pytest was invoked incorrectly (a usage error), so no tests ran'],
  [5, 'pytest collected NO tests at all — a suite that ran nothing is not a suite that passed'],
]);

export function pythonGates(deps: PythonToolGateDeps = {}): Gate[] {
  return [
    createPythonToolGate(
      {
        id: 'python-ruff',
        tool: 'ruff',
        command: 'ruff',
        // Diff-scoped. A whole-tree `ruff check .` on a repo whose own CI runs it advisory
        // (`ruff check . || true`, which is exactly what the live Python tenant does) would
        // block every PR on inherited lint debt the diff did not create -- a gate nobody can
        // clear gets demoted to `blocking:false` within a day and then enforces nothing. Judging
        // the files the PR actually touched is a verdict the author can act on.
        // NO `--force-exclude`. That flag makes ruff honour the checkout's `[tool.ruff] exclude` /
        // `extend-exclude` EVEN FOR EXPLICITLY PASSED PATHS -- it exists for pre-commit, which
        // passes every staged file. `pyproject.toml` is PR-authored and no gate reviews it, so a
        // diff adding `extend-exclude = ["<pkg>"]` would get
        // "ran ruff over 3 changed Python file(s) and found no problems": a green check over an
        // unlinted tree. Without the flag, a path this gate names explicitly is always checked.
        argsFor: () => ['check', '--output-format=concise'],
        diffScoped: true,
        noVerdictExitCodes: RUFF_NO_VERDICT,
      },
      deps,
    ),
    createPythonToolGate(
      {
        id: 'python-mypy',
        tool: 'mypy',
        command: 'mypy',
        // `--follow-imports=silent` type-checks the changed files IN CONTEXT (imports are still
        // analysed, so a call with the wrong signature is caught) while suppressing errors
        // reported against the unchanged modules they import -- the standard incremental-CI
        // recipe, and the same anti-inherited-debt argument as ruff above.
        argsFor: () => ['--follow-imports=silent'],
        diffScoped: true,
        noVerdictExitCodes: MYPY_NO_VERDICT,
      },
      deps,
    ),
    createPythonToolGate(
      {
        id: 'python-pytest',
        tool: 'pytest',
        command: 'pytest',
        // NOT diff-scoped: a test suite is not a per-file judgement, and running only the tests a
        // PR happened to touch is how a change breaks every other test and still merges green.
        // The project's own `[tool.pytest.ini_options].testpaths` already scopes collection.
        // `--override-ini=addopts=` discards the project's own `addopts`, which is PR-authored:
        // `addopts = "--collect-only"` (or `-k nothing`, or `--co`) exits 0 having run no tests at
        // all, and exit 0 is a pass. The exit-5 guard below only catches ZERO COLLECTION, not
        // "collected and deliberately did not run". The cost is that the project's own flags
        // are dropped: strictness the suite asked for is lost, and a hung test is caught by this
        // gate's own 15-minute timeout as `unjudged`/`infra` rather than by a timeout plugin.
        // Losing strictness is a weaker check; honouring an attacker-chosen flag is no check at
        // all.
        argsFor: () => ['--override-ini=addopts=', '-q'],
        diffScoped: false,
        noVerdictExitCodes: PYTEST_NO_VERDICT,
      },
      deps,
    ),
  ];
}
