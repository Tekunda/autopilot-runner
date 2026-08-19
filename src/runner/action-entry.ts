// GitHub Action entry point for the thin runner — the only code that executes inside the
// customer's CI (AGENTS.md, "split plane"). action.yml invokes this twice per coding stage
// (once each for `mode: prepare` and `mode: finalize`), with the vendor's own coding-agent
// Action step (e.g. claude-code-action) run as its own `uses:` step in between — see
// action.yml for the full step topology. Judgment-only stages resolve entirely within the
// prepare call; finalize never runs for them.
//
// Reads inputs off the action's env, runs the requested phase via prepareStage()/
// finalizeCodingStage() (./prepare-stage.ts, ./finalize-stage.ts), and reports
// StatusTelemetry (once resolved) back through the action's outputs — never source, never
// a diff. action.yml carries no logic of its own; everything lives here so it can be
// tested.

import { appendFileSync } from 'node:fs';

import type { AgentModel, CodingExecutor, VCSHost } from '../contracts/adapters.ts';
import type { ExecutionGrant, StatusTelemetry } from '../contracts/types.ts';
import {
  createAgentModel,
  createCodingExecutor,
  createVCSHost,
  type AgentModelConfig,
  type CodingExecutorConfig,
  type VCSHostConfig,
} from './adapters.ts';
import type { GateRegistry } from '../gates/registry.ts';
import { finalizeCodingStage, type ActionOutcome } from './finalize-stage.ts';
import { createRunnerGateRegistry } from './gate-registry.ts';
import { prepareStage, type PreparedStage } from './prepare-stage.ts';
import { runGateStage, type GateTarget } from './run-gate-stage.ts';

export class ActionInputError extends Error {}

export type ActionInputs =
  | {
      mode: 'prepare';
      grant: ExecutionGrant;
      verifyKey: string;
      agentModel: AgentModelConfig;
      codingExecutor: CodingExecutorConfig;
    }
  | {
      mode: 'finalize';
      grant: ExecutionGrant;
      verifyKey: string;
      codingExecutor: CodingExecutorConfig;
      vcsHost: VCSHostConfig;
      actionOutcome: ActionOutcome;
    }
  | {
      mode: 'gate';
      grant: ExecutionGrant;
      verifyKey: string;
      vcsHost: VCSHostConfig;
      /** Runs any `{kind:'prompt'}` gate specs (licensed pack gates) -- see ./prompt-gate.ts. */
      agentModel: AgentModelConfig;
      target: GateTarget;
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
      agentModel: requireJsonEnv<AgentModelConfig>(env, 'INPUT_AGENT-MODEL-CONFIG'),
      codingExecutor: requireJsonEnv<CodingExecutorConfig>(env, 'INPUT_CODING-EXECUTOR-CONFIG'),
    };
  }

  if (mode === 'finalize') {
    return {
      mode,
      grant,
      verifyKey,
      codingExecutor: requireJsonEnv<CodingExecutorConfig>(env, 'INPUT_CODING-EXECUTOR-CONFIG'),
      vcsHost: requireJsonEnv<VCSHostConfig>(env, 'INPUT_VCS-HOST-CONFIG'),
      actionOutcome: { conclusion: requireEnv(env, 'INPUT_ACTION-CONCLUSION') },
    };
  }

  if (mode === 'gate') {
    return {
      mode,
      grant,
      verifyKey,
      vcsHost: requireJsonEnv<VCSHostConfig>(env, 'INPUT_VCS-HOST-CONFIG'),
      agentModel: requireJsonEnv<AgentModelConfig>(env, 'INPUT_AGENT-MODEL-CONFIG'),
      target: requireJsonEnv<GateTarget>(env, 'INPUT_GATE-TARGET'),
    };
  }

  throw new ActionInputError(`input "mode" must be "prepare", "finalize", or "gate", got "${mode}"`);
}

export interface RunActionDeps {
  /** Override the AgentModel adapter; defaults to building one from inputs.agentModel (prepare and gate modes). */
  agentModel?: AgentModel;
  /** Override the CodingExecutor adapter; defaults to building one from inputs.codingExecutor. */
  codingExecutor?: CodingExecutor;
  /** Override the VCSHost adapter; defaults to building one from inputs.vcsHost (finalize/gate). */
  vcsHost?: VCSHost;
  /** Override the gate catalog; defaults to the runner's full registry (gate only). */
  gateRegistry?: GateRegistry;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
}

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
  if (inputs.mode === 'gate') {
    const vcsHost = deps.vcsHost ?? createVCSHost(inputs.vcsHost);
    const registry = deps.gateRegistry ?? createRunnerGateRegistry();
    const agentModel = deps.agentModel ?? createAgentModel(inputs.agentModel);
    const telemetry = await runGateStage(inputs.grant, {
      vcsHost,
      registry,
      agentModel,
      target: inputs.target,
      verifyKey: inputs.verifyKey,
      now: deps.now,
    });
    return { mode: 'gate', telemetry };
  }

  const codingExecutor = deps.codingExecutor ?? createCodingExecutor(inputs.codingExecutor);

  if (inputs.mode === 'prepare') {
    const agentModel = deps.agentModel ?? createAgentModel(inputs.agentModel);
    const prepared = await prepareStage(inputs.grant, {
      agentModel,
      codingExecutor,
      verifyKey: inputs.verifyKey,
      now: deps.now,
    });
    return { mode: 'prepare', prepared };
  }

  const vcsHost = deps.vcsHost ?? createVCSHost(inputs.vcsHost);
  const telemetry = await finalizeCodingStage(inputs.grant, inputs.actionOutcome, {
    codingExecutor,
    vcsHost,
    verifyKey: inputs.verifyKey,
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
// whether to run the vendor coding-agent Action step and the finalize step at all —
// judgment-only stages (and a rejected grant) resolve telemetry in prepare and skip both.
export function reportResult(result: ActionResult, writeOutput: OutputWriter = defaultWriteOutput): void {
  if (result.mode === 'prepare' && result.prepared.kind === 'coding') {
    writeOutput('resolved', 'false');
    writeOutput('prompt', result.prepared.prompt);
    writeOutput('base-ref', result.prepared.baseRef);
    writeOutput('branch-name', result.prepared.branchName);
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

  const result = await runActionEntry(inputs);
  reportResult(result);
  process.exitCode = exitCodeFor(result);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
