// GitHub Action entry point for the thin runner — the only code that executes inside the
// customer's CI (AGENTS.md, "split plane"). action.yml invokes this twice per agent stage
// (once each for `mode: prepare` and `mode: finalize`), with the vendor's own coding-agent
// Action step (Claude Code or Codex) run as its own `uses:` step in between — see
// action.yml for the full step topology. Judgment stages use read-only access; coding stages
// use workspace write access and the deterministic branch contract.
//
// Reads inputs off the action's env, runs the requested phase via prepareStage()/
// finalizeCodingStage() (./prepare-stage.ts, ./finalize-stage.ts), and reports
// StatusTelemetry (once resolved) back through the action's outputs — never source, never
// a diff. action.yml carries no logic of its own; everything lives here so it can be
// tested.

import { appendFileSync, writeFileSync } from 'node:fs';

import type { CodingExecutor, VCSHost } from '../contracts/adapters.ts';
import type { ExecutionGrant, StatusTelemetry } from '../contracts/types.ts';
import {
  createCodingExecutor,
  createVCSHost,
  executorCredential,
  type CodingExecutorConfig,
  type VCSHostConfig,
} from './adapters.ts';
import type { GateRegistry } from '../gates/registry.ts';
import { GrantLedger } from '../control-plane/grant-ledger.ts';
import { finalizeCodingStage, finalizeJudgmentStage, type ActionOutcome } from './finalize-stage.ts';
import { createRunnerGateRegistry } from './gate-registry.ts';
import { CODING_STAGES, computeChangedFiles, DEFAULT_BASE_REF, prepareStage, type PreparedStage } from './prepare-stage.ts';
import { runGateStage, type GateTarget } from './run-gate-stage.ts';
import { runHeavyGateStage } from './serve-and-gate.ts';

export class ActionInputError extends Error {}

export type ActionInputs =
  | {
      mode: 'prepare';
      grant: ExecutionGrant;
      verifyKey: string;
      baseRef: string;
      codingExecutor: CodingExecutorConfig;
    }
  | {
      mode: 'finalize';
      grant: ExecutionGrant;
      verifyKey: string;
      baseRef: string;
      codingExecutor: CodingExecutorConfig;
      vcsHost: VCSHostConfig;
      actionOutcome: ActionOutcome;
    }
  // `gate` runs the fast deterministic gates against the PR checkout only. `heavy-gate` runs the
  // dedicated browser/server-capable stage (docs/ci-gate-refit-plan.md §5): it builds + serves the
  // site, threads the served base URL into the URL-bound gates, runs the heavy gates (SEO crawl,
  // Visual-QA), then tears the server down. Identical inputs -- action.yml provisions the extra
  // toolchain/browser only for `heavy-gate`. Kept as two single-literal variants (not one
  // `'gate' | 'heavy-gate'` member) so the discriminated-union narrowing in runActionEntry stays
  // clean.
  | {
      mode: 'gate';
      grant: ExecutionGrant;
      verifyKey: string;
      vcsHost: VCSHostConfig;
      target: GateTarget;
      // The tenant's executor config, forwarded so the heavy stage can derive the vision judge's
      // credential from it (the SAME one the reviewer/architect steps use). Optional: the fast
      // gate path never calls a model, and a malformed value must not break deterministic gates.
      codingExecutor?: CodingExecutorConfig;
    }
  | {
      mode: 'heavy-gate';
      grant: ExecutionGrant;
      verifyKey: string;
      vcsHost: VCSHostConfig;
      target: GateTarget;
      codingExecutor?: CodingExecutorConfig;
    };

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new ActionInputError(`missing required input "${name}"`);
  return value;
}

function requireJsonEnv<T>(env: NodeJS.ProcessEnv, name: string): T {
  const raw = requireEnv(env, name);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new ActionInputError(`input "${name}" is not valid JSON`);
  }
}

// GitHub Actions exposes action inputs as `INPUT_<NAME>` env vars: uppercased, with
// hyphens preserved — so input "verify-key" becomes env "INPUT_VERIFY-KEY".
export function parseInputs(env: NodeJS.ProcessEnv = process.env): ActionInputs {
  const mode = requireEnv(env, 'INPUT_MODE');
  const grant = requireJsonEnv<ExecutionGrant>(env, 'INPUT_GRANT');
  const verifyKey = requireEnv(env, 'INPUT_VERIFY-KEY');

  if (mode === 'prepare') {
    return {
      mode,
      grant,
      verifyKey,
      baseRef: env['INPUT_BASE-REF'] || DEFAULT_BASE_REF,
      codingExecutor: requireJsonEnv<CodingExecutorConfig>(env, 'INPUT_CODING-EXECUTOR-CONFIG'),
    };
  }

  if (mode === 'finalize') {
    return {
      mode,
      grant,
      verifyKey,
      baseRef: env['INPUT_BASE-REF'] || DEFAULT_BASE_REF,
      codingExecutor: requireJsonEnv<CodingExecutorConfig>(env, 'INPUT_CODING-EXECUTOR-CONFIG'),
      vcsHost: requireJsonEnv<VCSHostConfig>(env, 'INPUT_VCS-HOST-CONFIG'),
      actionOutcome: { conclusion: requireEnv(env, 'INPUT_ACTION-CONCLUSION') },
    };
  }

  if (mode === 'gate' || mode === 'heavy-gate') {
    return {
      mode,
      grant,
      verifyKey,
      vcsHost: requireJsonEnv<VCSHostConfig>(env, 'INPUT_VCS-HOST-CONFIG'),
      target: requireJsonEnv<GateTarget>(env, 'INPUT_GATE-TARGET'),
      ...(env['INPUT_CODING-EXECUTOR-CONFIG']
        ? { codingExecutor: requireJsonEnv<CodingExecutorConfig>(env, 'INPUT_CODING-EXECUTOR-CONFIG') }
        : {}),
    };
  }

  throw new ActionInputError(
    `input "mode" must be "prepare", "finalize", "gate", or "heavy-gate", got "${mode}"`,
  );
}

export interface RunActionDeps {
  /** Override the CodingExecutor adapter; defaults to building one from inputs.codingExecutor. */
  codingExecutor?: CodingExecutor;
  /** Override the VCSHost adapter; defaults to building one from inputs.vcsHost (finalize/gate). */
  vcsHost?: VCSHost;
  /** Override the gate catalog; defaults to the runner's full registry (gate only). */
  gateRegistry?: GateRegistry;
  /** Override the grant consume ledger; defaults to this process's shared one. */
  grantLedger?: GrantLedger;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
}

// One consume ledger per runner process (Track G replay DETECTION): each Actions step
// process executes one grant's phase, so a second finalize of the same issued grant
// within this process is a replay and is flagged by the ledger. Cross-process replays --
// the actual threat, a captured grant re-dispatched into a fresh job -- are NOT caught
// here and are not refused anywhere: this ledger starts empty in every new process. See
// the grant-ledger.ts header for the open boundary.
const processGrantLedger = new GrantLedger();

export type ActionResult =
  | { mode: 'prepare'; prepared: PreparedStage }
  | { mode: 'finalize'; telemetry: StatusTelemetry }
  | { mode: 'gate'; telemetry: StatusTelemetry };

// Resolved telemetry, if this result has any yet -- a prepare handing off to the vendor
// Action step (kind: 'coding') doesn't, since the stage hasn't run yet.
function resolvedTelemetry(result: ActionResult): StatusTelemetry | undefined {
  if (result.mode === 'finalize' || result.mode === 'gate') return result.telemetry;
  return result.prepared.kind === 'resolved' ? result.prepared.telemetry : undefined;
}

// Verify the grant and run the requested phase. Adapter construction is injectable so
// tests can run against fakes instead of live credentials.
export async function runActionEntry(inputs: ActionInputs, deps: RunActionDeps = {}): Promise<ActionResult> {
  if (inputs.mode === 'gate' || inputs.mode === 'heavy-gate') {
    const vcsHost = deps.vcsHost ?? createVCSHost(inputs.vcsHost);
    const registry = deps.gateRegistry ?? createRunnerGateRegistry();
    const stageDeps = {
      vcsHost,
      registry,
      target: inputs.target,
      workspaceRoot: workspaceRoot(),
      verifyKey: inputs.verifyKey,
      now: deps.now,
    };
    // The heavy stage wraps the same gate execution with build/serve/teardown around it, so a
    // URL-bound gate (SEO crawl, Visual-QA) runs against the freshly served local instance.
    const telemetry =
      inputs.mode === 'heavy-gate'
        ? await runHeavyGateStage(inputs.grant, {
            ...stageDeps,
            ...(inputs.codingExecutor
              ? { executorCredential: executorCredential(inputs.codingExecutor) }
              : {}),
          })
        : await runGateStage(inputs.grant, stageDeps);
    return { mode: 'gate', telemetry };
  }

  const codingExecutor = deps.codingExecutor ?? createCodingExecutor(inputs.codingExecutor);

  if (inputs.mode === 'prepare') {
    const prepared = await prepareStage(inputs.grant, {
      codingExecutor,
      baseRef: inputs.baseRef,
      verifyKey: inputs.verifyKey,
      executorProvider: inputs.codingExecutor.provider,
      ...('model' in inputs.codingExecutor && inputs.codingExecutor.model
        ? { configuredModel: inputs.codingExecutor.model }
        : {}),
      now: deps.now,
    });
    return { mode: 'prepare', prepared };
  }

  const telemetry = CODING_STAGES.has(inputs.grant.stage)
    ? await finalizeCodingStage(inputs.grant, inputs.actionOutcome, {
        codingExecutor,
        vcsHost: deps.vcsHost ?? createVCSHost(inputs.vcsHost),
        baseRef: inputs.baseRef,
        verifyKey: inputs.verifyKey,
        grantLedger: deps.grantLedger ?? processGrantLedger,
        now: deps.now,
      })
    : finalizeJudgmentStage(inputs.grant, inputs.actionOutcome, {
        verifyKey: inputs.verifyKey,
        grantLedger: deps.grantLedger ?? processGrantLedger,
        now: deps.now,
      });
  return { mode: 'finalize', telemetry };
}

export type OutputWriter = (name: string, value: string) => void;

// GitHub Actions' file-based output protocol: append `name<<EOF\nvalue\nEOF\n` to the
// file at $GITHUB_OUTPUT. A no-op outside an Actions runner (e.g. local invocation).
export function defaultWriteOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  appendFileSync(file, `${name}<<EOF\n${value}\nEOF\n`);
}

// Report the phase's outcome through action outputs — never through logs, and never
// anything beyond the StatusTelemetry shape (no source, no diff; see AGENTS.md).
//
// `resolved`/`prompt` let action.yml decide, from the prepare step's outputs alone,
// whether to run the selected vendor Action step and the finalize step at all. A rejected
// grant resolves telemetry in prepare and skips both.
export function reportResult(result: ActionResult, writeOutput: OutputWriter = defaultWriteOutput): void {
  if (result.mode === 'prepare' && result.prepared.kind !== 'resolved') {
    writeOutput('resolved', 'false');
    writeOutput('stage-kind', result.prepared.kind);
    writeOutput('prompt', result.prepared.prompt);
    writeOutput('base-ref', result.prepared.baseRef);
    // The stage's resolved model/effort for the vendor Action step (action.yml) --
    // this is where the grant's signed modelTier stops being a label and actually
    // selects a model.
    if (result.prepared.model) writeOutput('model', result.prepared.model);
    if (result.prepared.effort) writeOutput('effort', result.prepared.effort);
    if (result.prepared.kind === 'coding') writeOutput('branch-name', result.prepared.branchName);
    // The grant's signed MCP access, materialized by prepare: the `--mcp-config` file path
    // and the mcp tool names action.yml appends to the vendor step's --allowedTools. Emitted
    // for every agent stage kind; absent when the grant authorized no MCP.
    if (result.prepared.mcpConfigPath) writeOutput('mcp-config-path', result.prepared.mcpConfigPath);
    if (result.prepared.mcpAllowedTools?.length) writeOutput('mcp-allowed-tools', result.prepared.mcpAllowedTools.join(','));
    // The grant's signed Claude Code plugin access: the marketplace URLs and plugin refs
    // action.yml passes as claude-code-action's `plugin_marketplaces`/`plugins` inputs
    // (newline-separated). Emitted for every agent stage kind; absent when unconfigured.
    if (result.prepared.pluginMarketplaces?.length) writeOutput('plugin-marketplaces', result.prepared.pluginMarketplaces.join('\n'));
    if (result.prepared.plugins?.length) writeOutput('plugins', result.prepared.plugins.join('\n'));
    // The grant's signed debug.showFullOutput toggle: tells action.yml to pass
    // claude-code-action's own `show_full_output` input. Emitted only when true --
    // claude-code-action already defaults it to 'false'.
    if (result.prepared.debugFullOutput) writeOutput('show-full-output', 'true');
    return;
  }

  const telemetry = resolvedTelemetry(result);
  if (!telemetry) return; // unreachable: excluded by the guard above
  writeOutput('resolved', 'true');
  writeOutput('telemetry', JSON.stringify(telemetry));
  writeOutput('result', telemetry.result);
}

// A non-'pass' outcome fails the action step so the run's own conclusion reflects it —
// the control plane's CIRunner adapter polls that conclusion to build a StageResult
// (see adapters/github-actions/ci-runner.ts). A prepare that hands off to the vendor
// Action step isn't itself a stage outcome yet, so it always succeeds.
export function exitCodeFor(result: ActionResult): number {
  const telemetry = resolvedTelemetry(result);
  if (!telemetry) return 0;
  return telemetry.result === 'pass' ? 0 : 1;
}

// Gate mode's git and its gate-report write must be rooted at GITHUB_WORKSPACE -- the
// checked-out customer repo -- never process.cwd(): the "Run gates" step runs with
// working-directory ${{ github.action_path }}, the downloaded action copy, which has no .git.
export function workspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.GITHUB_WORKSPACE ?? '.';
}

async function main(): Promise<void> {
  let inputs: ActionInputs;
  try {
    inputs = parseInputs();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`autopilot thin runner: ${message}\n`);
    process.exitCode = 1;
    return;
  }

  // Gate mode (fast or heavy): compute the changed-file scope from this checkout. The dispatch
  // input carries only prNumber/branch/baseRef routing data, so a large PR's changed paths
  // (~12KB) never ride through it -- the list is computed where the tree lives.
  if (inputs.mode === 'gate' || inputs.mode === 'heavy-gate') {
    inputs = {
      ...inputs,
      target: { ...inputs.target, changedFiles: await computeChangedFiles(inputs.target.baseRef, workspaceRoot()) },
    };
  }

  const result = await runActionEntry(inputs);

  // Gate mode's structured record of what the gates actually said (per-gate checks incl.
  // findings), written into the checked-out tree for upload as an artifact. GitHub exposes
  // no API for step outputs of a dispatched run, so this file is the only channel that
  // carries the real gate results back -- the same one the architect's plan.json uses.
  if ((inputs.mode === 'gate' || inputs.mode === 'heavy-gate') && result.mode === 'gate') {
    writeFileSync(`${workspaceRoot()}/gate-report.json`, JSON.stringify(result.telemetry));
  }

  reportResult(result);
  process.exitCode = exitCodeFor(result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
