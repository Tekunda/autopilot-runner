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

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

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
import { parseVerifyKeys, verifyGrant, type GrantEnvironment } from '../control-plane/grant-verify.ts';
import { finalizeCodingStage, finalizeJudgmentStage, type ActionOutcome } from './finalize-stage.ts';
import { FIX_REPORT_FILE } from './fix-verdict.ts';
import { classifyProviderRejection } from './provider-rejection.ts';
import { createRunnerGateRegistry } from './gate-registry.ts';
import { CODING_STAGES, computeChangedFiles, DEFAULT_BASE_REF, prepareStage, rejectedTelemetry, type PreparedStage } from './prepare-stage.ts';
import { isDirectlyExecuted } from './entrypoint.ts';
import { claimRejection, resolveClaimSha, tryClaimGrant, type ClaimEmitter } from './replay-claim.ts';
import { runGateStage, type GateTarget } from './run-gate-stage.ts';
import { runHeavyGateStage } from './serve-and-gate.ts';

export class ActionInputError extends Error {}

// Fields every mode carries. `verifyKey` is the raw `verify-key` input, which may hold SEVERAL
// concatenated PEM blocks during a signing-key rotation (grant-verify.ts parseVerifyKeys).
// `environment` is what the grant is BOUND to: read from the Actions env here, in the one place
// that touches process.env, and threaded down as data so every verification stays pure.
interface CommonInputs {
  grant: ExecutionGrant;
  verifyKey: string;
  environment?: GrantEnvironment;
}

export type ActionInputs =
  | (CommonInputs & {
      mode: 'prepare';
      baseRef: string;
      codingExecutor: CodingExecutorConfig;
      // The VCS host config for the durable replay claim placed before the vendor step. Optional:
      // absent -> no claim (the run proceeds unchanged, without replay prevention).
      vcsHost?: VCSHostConfig;
    })
  | (CommonInputs & {
      mode: 'finalize';
      baseRef: string;
      codingExecutor: CodingExecutorConfig;
      vcsHost: VCSHostConfig;
      actionOutcome: ActionOutcome;
      // The checkout's HEAD before the vendor agent ran, captured by action.yml right after the
      // checkout step. The `fix` stage's evasion scan diffs against it; it cannot be recovered
      // here, because by finalize time the branch it would be derived from already carries the
      // fix's own commit. Optional so a direct/test invocation without it still runs (the scan
      // then reports that it could not run, which is the fail-safe direction).
      preAgentSha?: string;
      // Path to the vendor step's own execution log ($RUNNER_TEMP/claude-execution-output.json,
      // published as claude-code-action's `execution_file` output -- set on the FAILING path too).
      // It is the only place the real result object exists; the conclusion string alone cannot
      // tell a provider rejection from a fixer that ran and failed. Optional: an unset/unreadable
      // path classifies nothing and finalize behaves exactly as it did before.
      executionFile?: string;
    })
  // `gate` runs the fast deterministic gates against the PR checkout only. `heavy-gate` runs the
  // dedicated browser/server-capable stage (docs/ci-gate-refit-plan.md §5): it builds + serves the
  // site, threads the served base URL into the URL-bound gates, runs the heavy gates (SEO crawl,
  // Visual-QA), then tears the server down. Identical inputs -- action.yml provisions the extra
  // toolchain/browser only for `heavy-gate`. Kept as two single-literal variants (not one
  // `'gate' | 'heavy-gate'` member) so the discriminated-union narrowing in runActionEntry stays
  // clean.
  | (CommonInputs & {
      mode: 'gate';
      vcsHost: VCSHostConfig;
      target: GateTarget;
      // The tenant's executor config, forwarded so the heavy stage can derive the vision judge's
      // credential from it (the SAME one the reviewer/architect steps use). Optional: the fast
      // gate path never calls a model, and a malformed value must not break deterministic gates.
      codingExecutor?: CodingExecutorConfig;
    })
  | (CommonInputs & {
      mode: 'heavy-gate';
      vcsHost: VCSHostConfig;
      target: GateTarget;
      codingExecutor?: CodingExecutorConfig;
    });

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

// What the grant is checked against: the repository this workflow is actually running in, and
// (when the tenant workflow declares one) the tenant it belongs to. GITHUB_REPOSITORY is set by
// the Actions runner itself and is not forgeable from the dispatch inputs an attacker controls,
// which is exactly why it is the right thing to compare the SIGNED repoId to.
//
// THIS is the only function in the runner that reads the environment for verification. Everything
// downstream receives a GrantEnvironment value, so verifyGrant stays pure and every binding case
// is testable without mutating process.env.
//
// AUTOPILOT_TENANT_ID is optional and belongs to the tenant's own workflow; absent, the tenant
// binding is carried implicitly by the per-tenant signing key instead
// (control-plane/tenant-signing-key.ts).
export function runnerEnvironment(env: NodeJS.ProcessEnv = process.env): GrantEnvironment | undefined {
  const repository = env.GITHUB_REPOSITORY?.trim();
  const tenantId = env.AUTOPILOT_TENANT_ID?.trim();
  if (!repository && !tenantId) return undefined; // not in Actions (local/test) -- unbound, as before
  return { ...(repository ? { repository } : {}), ...(tenantId ? { tenantId } : {}) };
}

// GitHub Actions exposes action inputs as `INPUT_<NAME>` env vars: uppercased, with
// hyphens preserved — so input "verify-key" becomes env "INPUT_VERIFY-KEY".
export function parseInputs(env: NodeJS.ProcessEnv = process.env): ActionInputs {
  const mode = requireEnv(env, 'INPUT_MODE');
  const grant = requireJsonEnv<ExecutionGrant>(env, 'INPUT_GRANT');
  const verifyKey = requireEnv(env, 'INPUT_VERIFY-KEY');
  const environment = runnerEnvironment(env);
  const common = { grant, verifyKey, ...(environment ? { environment } : {}) };

  if (mode === 'prepare') {
    return {
      ...common,
      mode,
      baseRef: env['INPUT_BASE-REF'] || DEFAULT_BASE_REF,
      codingExecutor: requireJsonEnv<CodingExecutorConfig>(env, 'INPUT_CODING-EXECUTOR-CONFIG'),
      ...(env['INPUT_VCS-HOST-CONFIG']
        ? { vcsHost: requireJsonEnv<VCSHostConfig>(env, 'INPUT_VCS-HOST-CONFIG') }
        : {}),
    };
  }

  if (mode === 'finalize') {
    return {
      ...common,
      mode,
      baseRef: env['INPUT_BASE-REF'] || DEFAULT_BASE_REF,
      codingExecutor: requireJsonEnv<CodingExecutorConfig>(env, 'INPUT_CODING-EXECUTOR-CONFIG'),
      vcsHost: requireJsonEnv<VCSHostConfig>(env, 'INPUT_VCS-HOST-CONFIG'),
      actionOutcome: { conclusion: requireEnv(env, 'INPUT_ACTION-CONCLUSION') },
      ...(env['INPUT_PRE-AGENT-SHA'] ? { preAgentSha: env['INPUT_PRE-AGENT-SHA'] } : {}),
      ...(env['INPUT_EXECUTION-FILE'] ? { executionFile: env['INPUT_EXECUTION-FILE'] } : {}),
    };
  }

  if (mode === 'gate' || mode === 'heavy-gate') {
    return {
      ...common,
      mode,
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
  /** Observability seam for the replay-claim attempt; defaults to replay-claim's own emitter. */
  emitClaimEvent?: ClaimEmitter;
  /**
   * Read + classify the vendor's execution log at a path (finalize only). Injectable so tests
   * exercise the wiring without a file on disk; defaults to defaultReadExecutionLog.
   */
  readExecutionLog?: (path: string) => string | undefined;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
}

// Read the vendor step's execution log off disk and classify it. A missing, unreadable or
// unparseable file is NOT an error here: it means "nothing can be said about why the vendor
// failed", which is exactly the state finalize was in before this input existed. Swallowing the
// read is therefore the correct behaviour and not a hidden failure -- the alternative, throwing,
// would turn a cosmetic missing-file into a runner crash on a stage that already failed.
export function defaultReadExecutionLog(path: string): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
  return classifyProviderRejection(raw);
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
  // One `verify-key` input, one or more keys: a rotation puts both PEM blocks in the tenant's
  // secret and every grant signed by either half keeps verifying (grant-verify.ts parseVerifyKeys).
  const verifyKey = parseVerifyKeys(inputs.verifyKey);
  const environment = inputs.environment;

  if (inputs.mode === 'gate' || inputs.mode === 'heavy-gate') {
    const vcsHost = deps.vcsHost ?? createVCSHost(inputs.vcsHost);
    // Durable replay claim for the gate stage: verify the signature, then atomically claim the
    // grant before running (and publishing) any gate. A replayed gate grant re-dispatched into a
    // fresh job would otherwise re-publish a stale verdict; the claim rejects it here. runGateStage
    // verifies again harmlessly. Fail-open on any non-definitive claim outcome (see replay-claim.ts).
    const gateVerification = verifyGrant(inputs.grant, verifyKey, deps.now ?? new Date(), environment);
    if (gateVerification.ok) {
      const sha = await resolveClaimSha(inputs.grant, vcsHost, inputs.target.branch || inputs.target.baseRef);
      const claim = await tryClaimGrant(inputs.grant, vcsHost, sha, deps.emitClaimEvent);
      if (claim.status !== 'claimed' && claim.status !== 'unavailable') {
        return { mode: 'gate', telemetry: rejectedTelemetry(inputs.grant, claimRejection(claim)) };
      }
    }
    const registry = deps.gateRegistry ?? createRunnerGateRegistry();
    const stageDeps = {
      vcsHost,
      registry,
      target: inputs.target,
      workspaceRoot: workspaceRoot(),
      verifyKey,
      ...(environment ? { environment } : {}),
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
      verifyKey,
      ...(environment ? { environment } : {}),
      executorProvider: inputs.codingExecutor.provider,
      ...('model' in inputs.codingExecutor && inputs.codingExecutor.model
        ? { configuredModel: inputs.codingExecutor.model }
        : {}),
      // The replay claim runs only when the runner supplied a VCS host (action.yml passes it to
      // the prepare step); a test or install without one proceeds unclaimed.
      ...(deps.vcsHost ?? inputs.vcsHost ? { vcsHost: deps.vcsHost ?? createVCSHost(inputs.vcsHost!) } : {}),
      ...(deps.emitClaimEvent ? { emitClaimEvent: deps.emitClaimEvent } : {}),
      now: deps.now,
    });
    return { mode: 'prepare', prepared };
  }

  // Read ONCE, before either branch: the vendor's own result object is what separates "the
  // provider refused the request" from "the agent ran and failed", and the conclusion string
  // action.yml passes cannot express that difference. Any read/parse problem yields undefined and
  // finalize behaves exactly as it did before -- an unreadable log must never invent a rejection.
  const providerRejection = inputs.executionFile
    ? (deps.readExecutionLog ?? defaultReadExecutionLog)(inputs.executionFile)
    : undefined;

  const telemetry = CODING_STAGES.has(inputs.grant.stage)
    ? await finalizeCodingStage(inputs.grant, inputs.actionOutcome, {
        codingExecutor,
        vcsHost: deps.vcsHost ?? createVCSHost(inputs.vcsHost),
        baseRef: inputs.baseRef,
        verifyKey,
        ...(environment ? { environment } : {}),
        grantLedger: deps.grantLedger ?? processGrantLedger,
        // The customer tree, not the action copy: the finalize step runs with
        // working-directory ${{ github.action_path }}, which has no .git and none of the
        // fixer's edits. Same reason gate mode roots its git at GITHUB_WORKSPACE.
        workspaceRoot: workspaceRoot(),
        ...(inputs.preAgentSha ? { preAgentSha: inputs.preAgentSha } : {}),
        ...(providerRejection ? { providerRejection } : {}),
        now: deps.now,
      })
    : finalizeJudgmentStage(inputs.grant, inputs.actionOutcome, {
        verifyKey,
        ...(environment ? { environment } : {}),
        grantLedger: deps.grantLedger ?? processGrantLedger,
        ...(providerRejection ? { providerRejection } : {}),
        now: deps.now,
      });
  return { mode: 'finalize', telemetry };
}

// The crash-catch's own reported telemetry: a REAL CheckResult, never the empty `checks: []`
// rejectedTelemetry() carries. Two things go wrong with an empty array: (1) ci-runner's
// mapCompletedRun treats an empty-but-PRESENT `checks` array from the gate-report artifact as
// authoritative (`Array.isArray` -> truthy) and REPLACES its own job-name fallback checks with
// it, discarding even the job-name check's detailsUrl into raw job logs; (2)
// maxFixRoundsFor([], cap) sees no FAILED check to classify, so it returns the FULL configured
// budget -- the fix loop would dispatch every fix round with a contentless prompt against a crash
// no code edit can diagnose, before ever escalating. A single `runner-crash` check with
// `unjudged:true` and NO `unjudgedReason` fixes both: reason-less means `content` (fix-loop.ts's
// isContentUnjudged), so isNonRevertableFinding gives it 0 fix rounds and it goes straight to a
// human, while the real crash message rides through to the escalation text instead of vanishing.
// The absent reason is load-bearing: an `infra` one would buy this crash a retry budget instead.
export function crashTelemetry(grant: ExecutionGrant, err: unknown): StatusTelemetry {
  const message = err instanceof Error ? err.message : String(err);
  return {
    ...rejectedTelemetry(grant, message),
    checks: [{ name: 'runner-crash', status: 'fail', unjudged: true, findings: [message] }],
  };
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
    // The least-privilege, signed-grant-derived tool allow-list (with MCP tools already
    // appended): action.yml passes it verbatim to the vendor step's --allowedTools instead
    // of a template-side stage-kind ternary a later edit could silently widen.
    writeOutput('allowed-tools', result.prepared.allowedTools);
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
    // The grant's signed committer identity (Autopilot's own bot), emitted only on the coding
    // kind: action.yml drives the vendor `bot_name`/`bot_id` and the "Commit and push" step's
    // git identity from these so no pushed commit is authored claude[bot]. Absent -> action.yml
    // falls back to its non-claude github-actions[bot] default.
    if (result.prepared.kind === 'coding' && result.prepared.committerName) writeOutput('committer-name', result.prepared.committerName);
    if (result.prepared.kind === 'coding' && result.prepared.committerEmail) writeOutput('committer-email', result.prepared.committerEmail);
    return;
  }

  const telemetry = resolvedTelemetry(result);
  if (!telemetry) return; // unreachable: excluded by the guard above
  writeOutput('resolved', 'true');
  // A heavy gate's telemetry carries every finding (~45KB), and emitting it here would
  // balloon the Actions `steps` context past GitHub's template object-size limit, failing
  // the run at the tail with "Maximum object size exceeded" even though the gate passed.
  // Gate findings already travel back via the gate-report.json artifact (written in main
  // before this call), which is the only channel the control plane reads; the run
  // conclusion carries pass/fail. So skip the bulky `telemetry` output for gate results.
  if (result.mode !== 'gate') writeOutput('telemetry', JSON.stringify(telemetry));
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

  // Defense-in-depth (independent of serve-and-gate.ts's own per-site catch): ANY unexpected
  // throw out of runActionEntry must still land as reported telemetry, not an unhandled
  // rejection that silently vanishes with zero logs and no gate-report.json -- the exact crash
  // this whole fix removes at the source. Mirrors the parseInputs catch above: log to stderr,
  // fail the step, and (for gate modes) still write a degraded gate-report.json -- via
  // crashTelemetry, NOT rejectedTelemetry, so the report carries a real check the fix loop can
  // act on (see crashTelemetry) rather than an empty array that discards the fallback checks and
  // burns the whole fix-round budget on a crash no edit can diagnose.
  let result: ActionResult;
  try {
    // Gate mode (fast or heavy): compute the changed-file scope from this checkout. The dispatch
    // input carries only prNumber/branch/baseRef routing data, so a large PR's changed paths
    // (~12KB) never ride through it -- the list is computed where the tree lives.
    //
    // INSIDE the crash-catch, deliberately. This shells out to git, and it used to sit above the
    // try: a checkout whose base ref could not be resolved (a shallow/empty tree, a deleted base
    // branch) threw an unhandled rejection here -- raw stack trace, no gate-report.json, and the
    // control plane left with nothing but a job conclusion. Found by the release acceptance test
    // (src/packaging/runner-release.test.ts), which asserts that a fresh clone of the published
    // runner fails CLEANLY rather than merely failing.
    if (inputs.mode === 'gate' || inputs.mode === 'heavy-gate') {
      inputs = {
        ...inputs,
        target: { ...inputs.target, changedFiles: await computeChangedFiles(inputs.target.baseRef, workspaceRoot()) },
      };
    }
    result = await runActionEntry(inputs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`autopilot thin runner: ${message}\n`);
    if (inputs.mode === 'gate' || inputs.mode === 'heavy-gate') {
      writeFileSync(`${workspaceRoot()}/gate-report.json`, JSON.stringify(crashTelemetry(inputs.grant, err)));
    }
    process.exitCode = 1;
    return;
  }

  // Gate mode's structured record of what the gates actually said (per-gate checks incl.
  // findings), written into the checked-out tree for upload as an artifact. GitHub exposes
  // no API for step outputs of a dispatched run, so this file is the only channel that
  // carries the real gate results back -- the same one the architect's plan.json uses.
  if ((inputs.mode === 'gate' || inputs.mode === 'heavy-gate') && result.mode === 'gate') {
    writeFileSync(`${workspaceRoot()}/gate-report.json`, JSON.stringify(result.telemetry));
  }

  // Same artifact channel, for the `fix` stage's own verdict on the round it just ran (disputed
  // findings, encoding evasions). A dispatched run's step outputs are unreadable through the API,
  // so this file is the only way that verdict reaches the control plane -- without it a disputed
  // or evaded round is indistinguishable from an ordinary one and just gets re-gated. Written
  // AFTER action.yml's commit-and-push step, so it is never committed to the customer's branch.
  if (inputs.mode === 'finalize' && inputs.grant.stage === 'fix' && result.mode === 'finalize') {
    writeFileSync(`${workspaceRoot()}/${FIX_REPORT_FILE}`, JSON.stringify(result.telemetry));
  }

  reportResult(result);
  process.exitCode = exitCodeFor(result);
}

if (isDirectlyExecuted(import.meta.url)) {
  void main();
}
