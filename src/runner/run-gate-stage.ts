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
import { verifyGrant, type GrantEnvironment, type KeyInput } from '../control-plane/grant-verify.ts';
import { createCommandGate } from '../gates/command/command-gate.ts';
import type { GateRegistry } from '../gates/registry.ts';
import { describeStack, detectStackAt, type StackProfile } from '../gates/stack-profile.ts';
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
  /**
   * How to work out what toolchains the checkout holds (gates/stack-profile.ts). Injected only
   * so a test can drive a synthetic repo without a temp dir; production always uses the real
   * filesystem detector. It must never throw -- detection is diagnostic, and a crash here would
   * take down a gate stage before it writes gate-report.json.
   */
  stackDetector?: (workspaceRoot: string) => readonly StackProfile[];
  /** Public key(s) used to verify the grant's signature -- a list during a key rotation. */
  verifyKey: KeyInput | readonly KeyInput[];
  /**
   * The environment this run is executing in (repository slug, tenant), checked against the
   * grant's SIGNED tenantId/repoId. Threaded in as data by action-entry.ts so verification stays
   * a pure function. Absent -> unbound.
   */
  environment?: GrantEnvironment;
  /** Clock override for tests; defaults to the current time. */
  now?: Date;
}

// GateStatus has a `skip` a CheckStatus has no room for; the closest honest
// mapping is `pending` -- a skipped gate was never evaluated, not passed. But a
// not-yet-run `pending` and a skip must stay distinguishable downstream, so toChecks
// also tags a skip `skipped:true` (+ skipReason) -- otherwise a gate that skips 100%
// of the time is banked as coverage exactly like a pass. A
// A `warn` is a report-only failure that must not fail the grant -- but whether it
// publishes as a PASS depends on something `warn` alone does not say: did the gate
// judge? Four of the five producers did (a non-blocking command that exited non-zero,
// assertion-delta's `enforce:false`, structure's integrity findings, a site crawl that
// found only sub-blocking warnings) and keep mapping to `pass`, because they DID reach
// a verdict and publishing them as "never ran" would be its own lie -- one that also
// drops the gate out of the coverage baseline, so its real disappearance could never
// regress. The fifth, cve's staged rollout, reached NO VERDICT (the audit could not
// run at all) and says so with `noVerdict`: that one maps to `pending` and toChecks
// tags it `reportOnly:true`. It used to map to `pass` like the rest, which published a
// GREEN check and -- carrying no flag -- was banked downstream as a real verdict, so a
// tenant whose runner has no osv-scanner got a green `cve` on every PR while
// `gate_never_fired` stayed suppressed: the silent-off hole audit-outcome.ts rejected
// `skip` for, recreated with `warn` and one step worse, `pass` being greener than
// `pending`. See gates/types.ts for the producer-by-producer list. An `unjudged` gate
// RAN but reached no verdict AND still blocks -- it must NOT read as a pass, so it maps
// to `fail` (and toChecks tags the check `unjudged:true` so the fix loop escalates it
// to a human instead of burning fix rounds no edit can resolve).
function toCheckStatus(result: GateResult): CheckStatus {
  if (result.status === 'fail') return 'fail';
  if (result.status === 'unjudged') return 'fail';
  if (result.status === 'skip') return 'pending';
  if (result.status === 'warn') return result.noVerdict === true ? 'pending' : 'pass';
  return 'pass';
}

function toChecks(results: GateResult[], nameSuffix = ''): CheckResult[] {
  return results.map((result) => ({
    name: `${result.id}${nameSuffix}`,
    // A per-site suffix makes `name` differ from the gate's bare id; keep the base id so the
    // never-run/no-baseline ledger can match it against the enabled-gate set (which is keyed by
    // bare id). Omitted when unsuffixed -- `name` already IS the base id.
    ...(nameSuffix ? { baseId: result.id } : {}),
    status: toCheckStatus(result),
    ...(result.status === 'unjudged'
      ? { unjudged: true as const, ...(result.unjudgedReason ? { unjudgedReason: result.unjudgedReason } : {}) }
      : {}),
    ...(result.status === 'skip'
      ? { skipped: true as const, ...(result.skipReason ? { skipReason: result.skipReason } : {}) }
      : {}),
    // Kept separate from `skipped`: this gate RAN, it just banked nothing. The promotion ledger
    // excuses a skip on the gate's own history and must not excuse this one the same way.
    // Keyed on `noVerdict`, NEVER on `warn` alone -- a warn that judged is a real verdict and
    // tagging it here would drop a working gate out of the coverage baseline and alarm on it.
    ...(result.status === 'warn' && result.noVerdict === true ? { reportOnly: true as const } : {}),
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
  const verification = verifyGrant(grant, deps.verifyKey, deps.now ?? new Date(), deps.environment);
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

  // Detect the checkout's toolchains ONCE, here, where workspaceRoot is already in hand, and
  // hand the answer to every gate on the context -- so no gate has to re-derive it, and two
  // gates can no longer disagree about what repo they are looking at. Filesystem-derived like
  // `changedFiles`, so it is assembled runner-side and is NOT part of the signed grant.
  // Wrapped: detection is DIAGNOSTIC. It may not decide a verdict and it may not take down a
  // stage, so a detector that somehow throws degrades to "not detected" (an absent field),
  // which every gate must already handle.
  let stackProfiles: readonly StackProfile[] = [];
  try {
    stackProfiles = (deps.stackDetector ?? detectStackAt)(workspaceRoot);
  } catch {
    stackProfiles = [];
  }

  const ctx: GateContext = {
    repoId: grant.repoId,
    prNumber: deps.target.prNumber,
    branch: deps.target.branch,
    baseRef: deps.target.baseRef,
    changedFiles: deps.target.changedFiles,
    workspaceRoot,
    vcsHost: deps.vcsHost,
    config,
    ...(stackProfiles.length > 0 ? { stackProfiles } : {}),
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
  // A REPORT MISSING A GATE MUST NOT BE GREEN. `[].every(...)` is `true`, so a stage that
  // produced nothing at all resolved `result: 'pass'` with `checks: []` -- and the same hole is
  // there per-gate: the registry only iterates gates it HAS, so a signed spec id that resolves
  // to no registered gate is never run, never reported, and never noticed. That is the live
  // shape whenever the control plane is ahead of the deployed runner (a new pack gate issued
  // before the runner that can execute it has shipped), which is exactly when it matters.
  // gate-catalog-completeness.test.ts guards it at build time for THIS repo's catalog; this
  // guards it at run time, for the deployed pair.
  //
  // Checked per id rather than on `results.length === 0`, because a total wipeout is the rare
  // case: one unresolvable id among five that ran leaves a green stage over a gate nobody knows
  // did not run.
  const missing = enabledIds.filter((id) => !results.some((result) => result.id === id));
  for (const id of missing) {
    process.stdout.write(`[gate] ${id}: NOT RUN -- no registered gate resolved this signed spec id\n`);
  }
  const ok =
    missing.length === 0 &&
    results.every((result) =>
      result.status === 'unjudged' ? false : result.status !== 'fail' || nonBlockingIds.has(result.id),
    );

  // Make the run's log self-describing: a legitimate gate failure must be legible in
  // Actions logs, not byte-identical to a crash (the 75-file diff that failed `risk`
  // for an hour with nothing in the log saying why).
  const stack = describeStack(stackProfiles);
  // Logged BEFORE the verdicts: "which repo did these gates think they were looking at" is the
  // first question asked of a surprising gate result, and it is unanswerable after the fact
  // from a gate report that only carries statuses.
  for (const line of stack) {
    process.stdout.write(`[stack] ${line}\n`);
  }
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
    // Rendered lines, not the raw profiles: the gate report is read by people (and pasted into
    // tickets), and "node: yarn-classic (pinned yarn@1.22.22) — detected from package.json,
    // yarn.lock" is legible where a nested JSON blob is not. Carries no verdict -- it is the
    // context a verdict was reached in. Omitted entirely when nothing was detected.
    ...(stack.length > 0 ? { stack } : {}),
    logDigest: digestFor(grant.repoId, grant.ticketId, grant.stage, String(specs.length)),
  };
}
