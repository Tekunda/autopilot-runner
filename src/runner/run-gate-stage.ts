// The thin runner's `gate` stage (issues #106, #129): verifies the signed grant, builds a
// GateContext runner-side (no control-plane assumption -- gates run runner-side now, see
// gates/types.ts), and runs exactly the gates named by the grant's signed `gateSpecs` -- a
// gate absent there never runs. Only deterministic `{kind:'generic'}` specs run today, via
// the runner's own bundled GateRegistry (./gate-registry.ts, commodity gates only); prompt
// gates are disabled under the current stopgap, so a `{kind:'prompt'}` spec (should one
// appear) is ignored. Which specs land in the grant at all is decided entirely server-side
// by issueGateGrant (control-plane/grant.ts) from the tenant's entitlement. Resolves
// entirely within this one call, the same way judgment-only stages resolve within
// prepareStage() -- there is no vendor coding-agent Action step and no finalize phase for a
// gate stage.

import type { VCSHost } from '../contracts/adapters.ts';
import type { CheckResult, CheckStatus, ExecutionGrant, GateSpec, StatusTelemetry } from '../contracts/types.ts';
import { verifyGrant, type KeyInput } from '../control-plane/grant-verify.ts';
import { createCommandGate } from '../gates/command/command-gate.ts';
import type { GateRegistry } from '../gates/registry.ts';
import type { GateContext, GateResult } from '../gates/types.ts';
import { registerPackGatesForSpecs } from './gate-registry.ts';
import { digestFor, grantId, rejectedTelemetry } from './prepare-stage.ts';

// Runner-side PR targeting for the gate run: which PR/diff to run the
// entitled gates against. Unlike `gateSpecs`, this is routing data, not
// authorization, so it never needs to be signed -- same as the CIRunner
// dispatch target not being part of the grant either. It IS bound to the
// grant at the one point where the grant makes a checkable claim about it:
// `prNumber` must match the PR the signed `ref` names (see grantPRNumber).
// `branch`/`baseRef`/`changedFiles` stay unbound -- the grant asserts nothing
// about them, and mismatching them needs Actions-write on the customer's own
// repo, which already outranks anything a gate report can do.
export interface GateTarget {
  prNumber: number;
  branch: string;
  baseRef: string;
  changedFiles: string[];
  config?: Record<string, unknown>;
}

export interface RunGateStageDeps {
  vcsHost: VCSHost;
  registry: GateRegistry;
  target: GateTarget;
  /**
   * The customer's checked-out PR tree (GITHUB_WORKSPACE) the gates scan --
   * runner-local environment, not part of the signed grant or the dispatched
   * target. Tree-scanning gates (cve's `npm audit`) must run here, not in the
   * runner's own action directory (process.cwd()). Defaults to process.cwd().
   */
  workspaceRoot?: string;
  /**
   * Runtime, runner-side config values merged ON TOP of each gate's signed/target config,
   * keyed by gate id. This is for facts the signed grant CANNOT carry because they only exist
   * at run time -- above all the base URL of the server the heavy stage just brought up
   * (serve-and-gate.ts injects `{ 'seo-site-crawl': { baseUrl }, 'visual-qa': { baseUrl } }`).
   * The served instance is the whole point of the heavy stage (docs/ci-gate-refit-plan.md §11),
   * so the overlay wins over any baseUrl a signed spec happened to carry.
   */
  configOverlay?: Record<string, Record<string, unknown>>;
  /**
   * Runner-side (unsigned) restriction: run ONLY the signed gate specs whose id is in this set,
   * and report ONLY their results. It can only NARROW the signed `gateSpecs` (a filter), never
   * add a gate, so it needs no signature. The heavy stage uses it to run the deterministic gates
   * ONCE and the URL-bound gates ONCE PER SITE from the same signed grant, without the per-call
   * `skip` results of the gates it isn't running colliding across calls. Absent -> every signed
   * spec runs and every result is reported, exactly as before.
   */
  onlyGateIds?: ReadonlySet<string>;
  /**
   * Appended to each reported check's `name` (e.g. ` (tekunda)`), so a per-site heavy run
   * publishes disambiguated `seo-site-crawl (tekunda)` / `(serpent)` checks -- the matrix-variant
   * shape Track F's required-check matcher (customer-checks.ts matchesRequired) already accepts.
   * Presentation only: the gate's own id, config and blocking verdict are unchanged. Absent ->
   * the bare gate id is the check name.
   */
  checkNameSuffix?: string;
  /** Public key used to verify the grant's signature. */
  verifyKey: KeyInput;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
}

// GateStatus has a `skip` a CheckStatus has no room for; the closest honest
// mapping is `pending` -- a skipped gate was never evaluated, not passed. But a
// not-yet-run `pending` and a skip must stay distinguishable downstream, so toChecks
// also tags a skip `skipped:true` (+ skipReason) -- otherwise a gate that skips 100%
// of the time is banked as coverage exactly like a pass. A
// `warn` is a non-blocking gate's report-only failure: it must not fail the
// grant, so it maps to `pass` (its findings still ride through toChecks). An
// `unjudged` gate RAN but reached no verdict -- it must NOT read as a pass, so
// it maps to `fail` (and toChecks tags the check `unjudged:true` so the fix loop
// escalates it to a human instead of burning fix rounds no edit can resolve).
function toCheckStatus(status: GateResult['status']): CheckStatus {
  if (status === 'fail') return 'fail';
  if (status === 'unjudged') return 'fail';
  if (status === 'skip') return 'pending';
  return 'pass';
}

function toChecks(results: GateResult[], nameSuffix = ''): CheckResult[] {
  return results.map((result) => ({
    name: `${result.id}${nameSuffix}`,
    status: toCheckStatus(result.status),
    ...(result.status === 'unjudged'
      ? { unjudged: true as const, ...(result.unjudgedReason ? { unjudgedReason: result.unjudgedReason } : {}) }
      : {}),
    ...(result.status === 'skip'
      ? { skipped: true as const, ...(result.skipReason ? { skipReason: result.skipReason } : {}) }
      : {}),
    ...(result.findings?.length ? { findings: result.findings } : {}),
    ...(result.detailsUrl ? { detailsUrl: result.detailsUrl } : {}),
  }));
}

function isGenericSpec(spec: GateSpec): spec is Extract<GateSpec, { kind: 'generic' }> {
  return spec.kind === 'generic';
}

function isCommandSpec(spec: GateSpec): spec is Extract<GateSpec, { kind: 'command' }> {
  return spec.kind === 'command';
}

// A gate grant's signed `ref` IS the PR under gate (control-plane/subtask-pipeline.ts issues
// `ref: prUrl`, and the dispatcher derives the whole GateTarget from it -- adapters/
// github-actions/ci-runner.ts gateTarget). So the unsigned `gate-target` workflow input has
// exactly one claim on the grant to answer to: point at the same PR. Refuse otherwise, rather
// than gate one PR's diff and report the verdict against another's grant. Deliberately narrow:
// the pattern is the same `/pull/<n>` shape the control plane parses, and a grant whose ref
// names no PR makes no claim to check.
// (Rejecting here, not in verifyGrant: the target is runner-side input the signature never
// covers -- this is the seam where the two meet.)
function grantPRNumber(grant: ExecutionGrant): number | undefined {
  const match = grant.ref ? /\/pull\/(\d+)/.exec(grant.ref) : null;
  return match ? Number(match[1]) : undefined;
}

// Verify the grant, run exactly the gates named by its signed `gateSpecs`, and report the
// resulting checks as StatusTelemetry -- only results/checks cross back, never source or
// diffs (AGENTS.md, "split plane").
export async function runGateStage(grant: ExecutionGrant, deps: RunGateStageDeps): Promise<StatusTelemetry> {
  const verification = verifyGrant(grant, deps.verifyKey, deps.now ?? new Date());
  if (!verification.ok) {
    return rejectedTelemetry(grant, verification.reason);
  }
  if (grant.stage !== 'gate') {
    return rejectedTelemetry(grant, `runGateStage called with a "${grant.stage}" grant, expected "gate"`);
  }

  const claimedPR = grantPRNumber(grant);
  if (claimedPR !== undefined && claimedPR !== deps.target.prNumber) {
    return rejectedTelemetry(
      grant,
      `gate target PR #${deps.target.prNumber} does not match the grant's PR #${claimedPR}`,
    );
  }

  const specs = grant.gateSpecs ?? [];
  const genericSpecs = specs.filter(isGenericSpec);
  const commandSpecs = specs.filter(isCommandSpec);

  // A generic spec's signed `config` is authorization-adjacent policy (severity thresholds,
  // forbidden-path lists, ...) -- it overrides the runner-supplied, unsigned
  // GateTarget.config for that same gate id, never the other way around.
  const config: Record<string, unknown> = { ...(deps.target.config ?? {}) };
  for (const spec of genericSpecs) {
    if (spec.config !== undefined) config[spec.id] = spec.config;
  }

  // Runtime overlay wins over the signed config for the same gate id: a served baseUrl only
  // exists after the heavy stage brings the server up, so it can never ride in the signed
  // grant -- it is merged here, on top of whatever policy the spec carried.
  for (const [id, overlay] of Object.entries(deps.configOverlay ?? {})) {
    const existing = (config[id] as Record<string, unknown> | undefined) ?? {};
    config[id] = { ...existing, ...overlay };
  }

  const workspaceRoot = deps.workspaceRoot ?? process.cwd();

  const ctx: GateContext = {
    repoId: grant.repoId,
    prNumber: deps.target.prNumber,
    branch: deps.target.branch,
    baseRef: deps.target.baseRef,
    changedFiles: deps.target.changedFiles,
    workspaceRoot,
    vcsHost: deps.vcsHost,
    config,
  };

  // Deterministic pack gates (SEO crawl/changed-file, docs, security regex) ride in the grant
  // as ordinary `{kind:'generic'}` specs (packs/registry.ts enabledGateSpecs). The runner's
  // static registry holds only the always-on generic gates, so register the pack gate for any
  // grant-named id here -- only then does its spec resolve to an executable Gate. Their signed
  // config (e.g. `seo-site-crawl`) already reached `config` above via the generic loop.
  registerPackGatesForSpecs(deps.registry, genericSpecs.map((spec) => spec.id));

  // Command gates aren't in the runner's static bundle -- they are declared per tenant and
  // arrive as signed `{kind:'command'}` specs. Build a createCommandGate instance for each
  // and register it (dynamically named) so the registry runs it exactly like a generic gate,
  // scoped to the PR checkout.
  // Guard against a duplicate register: the heavy stage calls runGateStage more than once with
  // the SAME registry (deterministic gates once, URL-bound gates once per site), so a command
  // gate already built on a prior call must not be re-registered (GateRegistry.register throws).
  for (const spec of commandSpecs) {
    if (deps.registry.get(spec.id)) continue;
    deps.registry.register(
      createCommandGate({ name: spec.id, run: spec.run, ...(spec.blocking !== undefined ? { blocking: spec.blocking } : {}) }, workspaceRoot),
    );
  }

  // `onlyGateIds` narrows the signed set to the gates THIS call runs (the heavy stage's per-site
  // split). It never widens: an id absent from the signed specs still can't run.
  const runnable = (id: string): boolean => !deps.onlyGateIds || deps.onlyGateIds.has(id);
  const enabledIds = [...genericSpecs.map((spec) => spec.id), ...commandSpecs.map((spec) => spec.id)].filter(runnable);
  const genericReport = await deps.registry.run(enabledIds, ctx);

  // When `onlyGateIds` restricts the call, drop the `skip` results the registry emits for every
  // OTHER registered gate -- otherwise each per-site call would republish the deterministic gates'
  // checks (and the sites' checks would collide across calls). Absent -> report every result.
  const results = deps.onlyGateIds
    ? genericReport.results.filter((result) => deps.onlyGateIds!.has(result.id))
    : genericReport.results;
  // Report-only generic gates (`blocking:false`, from PackConfig.gateConfig[id]) still publish
  // their per-gate check (toChecks below is unchanged), but their `fail` is excluded from the
  // stage's blocking verdict -- advisory, not merge-blocking. Command gates already degrade
  // fail->warn inside createCommandGate; this is the generic-gate equivalent, applied here
  // because the runner keeps the gate's honest `fail` status in the check it publishes.
  const nonBlockingIds = new Set(
    genericSpecs.filter((spec) => spec.blocking === false).map((spec) => spec.id),
  );
  // An `unjudged` gate ALWAYS blocks -- report-only (`blocking:false`) can excuse a *finding*
  // fail (the gate judged and reported a defect it's non-blocking about), but NEVER a gate that
  // reached no verdict at all. A green stage on a gate that never ran is worse than no gate
  // (post-mortem TEK-3691), so nonBlockingIds cannot rescue it.
  const ok = results.every((result) =>
    result.status === 'unjudged' ? false : result.status !== 'fail' || nonBlockingIds.has(result.id),
  );

  // Make the run's log self-describing: a legitimate gate failure must be legible in
  // Actions logs, not byte-identical to a crash (the 75-file diff that failed `risk`
  // for an hour with nothing in the log saying why).
  for (const result of results) {
    process.stdout.write(`[gate] ${result.id}: ${result.status}\n`);
    for (const finding of result.findings ?? []) {
      process.stdout.write(`  ${finding}\n`);
    }
  }

  return {
    grantId: grantId(grant),
    result: ok ? 'pass' : 'fail',
    checks: toChecks(results, deps.checkNameSuffix),
    logDigest: digestFor(grant.repoId, grant.ticketId, grant.stage, String(specs.length)),
  };
}
