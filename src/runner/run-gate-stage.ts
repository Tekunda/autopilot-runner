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
import type {
  CheckResult,
  CheckStatus,
  ExecutionGrant,
  GateSpec,
  PackBundleGrant,
  StatusTelemetry,
} from '../contracts/types.ts';
import { verifyGrant, type GrantEnvironment, type KeyInput } from '../control-plane/grant-verify.ts';
import { createCommandGate } from '../gates/command/command-gate.ts';
import type { GateRegistry } from '../gates/registry.ts';
import { describeStack, detectStackAt, type StackProfile } from '../gates/stack-profile.ts';
import type { Gate, GateContext, GateResult } from '../gates/types.ts';
import { registerGatesForSpecs } from './gate-registry.ts';
import { loadPackBundleGates, PackBundleError } from './pack-bundle.ts';
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
/**
 * The workspace file gate mode writes its per-gate checks and findings to, for action.yml to
 * upload as the `gate-report` artifact -- the only channel a dispatched run's structured result
 * can travel back on, since GitHub exposes no API for its step outputs.
 *
 * Here rather than at the write site because there are TWO writers: action-entry's ordinary path
 * and its crash handler, which writes a degraded report so a runner that threw still says
 * something. A rename that reached only one of them would leave the other uploading an artifact
 * the adapter does not download. Sibling of FIX_REPORT_FILE (fix-verdict.ts) and
 * JUDGMENT_REPORT_FILE (judgment-report.ts), each owned by its own stage's module.
 */
export const GATE_REPORT_FILE = 'gate-report.json';

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
   * Runner-side (unsigned) narrowing of `target.changedFiles` for THIS call, for the heavy
   * stage's per-site run of the site-scoped deterministic gates: each site grades only the files
   * it owns (see serve-and-gate.ts filesForSite), so one brand's rules never judge the other
   * brand's content. Like `onlyGateIds` it can only SUBTRACT from what the run sees, so it needs
   * no signature -- and it is the same filesystem-derived, branch-untouchable list, just shorter.
   * Absent -> `target.changedFiles`, unchanged.
   */
  changedFilesOverride?: readonly string[];
  /**
   * Appended to each reported check's `name` (e.g. ` (marketing)`), so a per-site heavy run
   * publishes disambiguated `seo-site-crawl (marketing)` / `(docs)` checks -- the matrix-variant
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
  /**
   * Fetches + checksum-verifies + loads the deterministic PACK gates named by the grant's
   * signed `packBundle` (./pack-bundle.ts). Injectable for tests; defaults to the real
   * network path. It is called ONLY when a signed generic spec names a gate the runner's own
   * bundle cannot instantiate -- a grant with no pack gates never touches the network.
   */
  loadPackGates?: (spec: PackBundleGrant) => Promise<Gate[]>;
}

// GateStatus has a `skip` a CheckStatus has no room for; the closest honest mapping is `pending`
// -- a skipped gate was never evaluated, not passed. `pending` alone is ambiguous (a not-yet-run
// check is also pending), so toChecks tags each non-verdict with WHICH one it is: `skipped`
// (+ skipReason), `reportOnly` or `unjudged`. Those tags are what stop a gate that never judged
// from being banked as coverage, and they are what the publish hop turns into a conclusion that
// is not green (control-plane/subtask-pipeline.ts publishedStatusFor).
//
// A `warn` is a sub-blocking FINDING: the gate judged, and what it found is below its own
// blocking bar (assertion-delta's `enforce:false`, structure's integrity findings, a site crawl
// with only sub-blocking warnings). That is a real verdict, so it publishes `pass` -- reporting
// it as "never ran" would be its own lie, and would drop the gate out of the coverage baseline
// so its real disappearance could never regress. `noVerdict` marks the one producer that reached
// NO verdict at all (cve's staged rollout, where the audit could not run): that maps to `pending`
// + `reportOnly` and banks nothing.
//
// A `warn` is NOT how a report-only gate reports a REAL failure. A command gate used to rewrite
// its own `fail` into a `warn` when `blocking:false`, which landed here as a green `pass` under
// the title `unit-tests: pass -- \`yarn test\` exited 1` and was banked as coverage, suppressing
// `gate_never_fired` while a suite stayed red for days. Report-only degrades the BLOCKING-ness of
// a finding (nonBlockingIds, below), never its truth: the gate reports `fail`, and the check says
// fail.
//
// An `unjudged` gate RAN but reached no verdict AND still blocks -- it must NOT read as a pass,
// so it maps to `fail` and is tagged `unjudged:true` so the fix loop escalates it to a human
// instead of burning fix rounds no edit can resolve.
//
// Exported so a gate's own tests can assert the status that actually REACHES THE MERGE GATE, not
// just the internal GateStatus it returned. The two differ for exactly the case the tiered SEO
// gates depend on (a judged `warn` publishes a green `pass`), and a test that re-implemented this
// mapping locally would keep passing on the day the real one changed.
export function toCheckStatus(result: GateResult): CheckStatus {
  if (result.status === 'fail') return 'fail';
  if (result.status === 'unjudged') return 'fail';
  if (result.status === 'skip') return 'pending';
  if (result.status === 'warn') return result.noVerdict === true ? 'pending' : 'pass';
  return 'pass';
}

// `nonBlockingIds` is the gate ids whose FINDINGS do not block this stage. A `fail` from one of
// them is a real, judged failure that must still say so -- it is tagged `reportOnly` here, which
// makes the publish hop conclude it `neutral` rather than red, and keeps it out of the coverage
// record because a report-only gate banks no verdict that could excuse its own disappearance.
function toChecks(results: GateResult[], nameSuffix = '', nonBlockingIds: ReadonlySet<string> = new Set()): CheckResult[] {
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
    // excuses a skip on the gate's own history and must not excuse this one the same way. Two
    // populations, one flag, and both are things this gate DID rather than things it skipped: a
    // `warn` that reached no verdict at all (`noVerdict`), and a real `fail` from a gate whose
    // findings are configured not to block. Never `warn` alone -- a warn that judged is a real
    // verdict, and tagging it would drop a working gate out of the coverage baseline.
    ...((result.status === 'warn' && result.noVerdict === true) ||
    (result.status === 'fail' && nonBlockingIds.has(result.id))
      ? { reportOnly: true as const }
      : {}),
    ...(result.findings?.length ? { findings: result.findings } : {}),
    ...(result.detailsUrl ? { detailsUrl: result.detailsUrl } : {}),
  }));
}

// One gate's config entry, detached from the object the caller holds. Shallow, deliberately: it is
// the same depth of protection the copied `changedFiles` array gets, it costs nothing next to
// running a gate, and a deep clone would silently change the semantics of any non-plain value a
// tenant config carries. Non-objects (and arrays, which no gate config uses at the top level) pass
// through untouched.
function copyConfigValue(value: unknown): unknown {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...(value as object) } : value;
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

/** The id of the synthetic check a pack-bundle failure publishes. Stable, because a human
 *  reads it on the PR and the fix loop classifies on it. */
export const PACK_BUNDLE_GATE_ID = 'pack-bundle';

/** The id of the synthetic check a reserved-name collision publishes. Stable for the same reason
 *  PACK_BUNDLE_GATE_ID is: a human reads it on the PR and the fix loop classifies on it. */
export const GATE_SPEC_COLLISION_GATE_ID = 'gate-spec-collision';

/**
 * How a per-site heavy run disambiguates the check names it publishes (`seo-site-crawl (docs)`).
 *
 * Exported as the ONE formatter because two things have to agree on it, and a second spelling
 * would be a hole rather than a cosmetic drift: serve-and-gate.ts passes it as `checkNameSuffix`,
 * and reservedCheckNames below has to enumerate the names a run can publish in order to defend
 * them. Both derive from here.
 */
export function siteCheckNameSuffix(siteName: string): string {
  return ` (${siteName})`;
}

/**
 * Every check name a signed or synthetic gate can publish under this grant: the namespace a
 * tenant-authored command gate may not enter.
 *
 * NAMES, not gate ids, because a check's NAME is its identity everywhere downstream: the durable
 * per-gate record is keyed on it (`recordedGateChecks`, control-plane/subtask-pipeline.ts) and the
 * promotion's coverage aggregation keeps the first record banked under it. A gate id is only half
 * of that namespace -- `toChecks` publishes `<id>` on the once-only lanes and `<id><suffix>` on the
 * per-site ones -- so the whole namespace is what has to be reserved, and both halves are derived
 * here from one formatter rather than restated.
 *
 * The two synthetic ids are in the set for the sharpest version of the same reason: a report a
 * tenant-authored string could publish under reports nothing.
 */
export function reservedCheckNames(genericIds: Iterable<string>, siteNames: Iterable<string>): Set<string> {
  const suffixes = ['', ...[...siteNames].map(siteCheckNameSuffix)];
  const names = new Set<string>();
  for (const id of [...genericIds, PACK_BUNDLE_GATE_ID, GATE_SPEC_COLLISION_GATE_ID]) {
    for (const suffix of suffixes) names.add(`${id}${suffix}`);
  }
  return names;
}

// Which bundle failures a bare re-run could plausibly clear, and which are settled facts.
//
// The distinction decides what the control plane DOES with the failure, so it is not
// cosmetic. `infra` buys exactly one gate-only retry and then an honest INFRA block
// (fix-loop.ts isInfraUnjudgedOnly) -- right for a host that 502'd or a token that aged out,
// since a re-issued grant carries a freshly minted one. Everything else is left reason-less
// (`content`), which makes it a non-revertable finding worth ZERO fix rounds and sends it
// straight to a human -- right for a checksum mismatch, a malformed bundle, or a missing
// credential, none of which any number of AI fix rounds can address.
const TRANSIENT_BUNDLE_FAILURES: ReadonlySet<string> = new Set([
  'unreachable',
  'http-status',
  'token-expired',
  // A release host that redirects nowhere, in a loop, or off https is misconfigured or mid-
  // incident: the same infra lane, and equally beyond any fix round.
  'bad-redirect',
]);

// Makes sure every gate id this call is about to run has an executable Gate behind it,
// fetching the private pack bundle if that is what's missing. Returns `undefined` when
// everything resolved, or a GateResult describing the failure when the stage must fail.
//
// The deterministic pack gates (SEO crawl/changed-file, docs coverage, the security regex
// review) ride in the grant as ordinary `{kind:'generic'}` specs, but the runner does not carry
// their code: it is licensed IP and runner-dist/ is published to a PUBLIC repo (see
// ./pack-bundle.ts). So an id the runner's own registry cannot resolve is fetched from the
// private bundle the SIGNED grant points at, checksum-verified against the SIGNED digest,
// and only then registered -- and only for ids the signed gateSpecs already named.
//
// WHY A REAL CHECK AND NOT rejectedTelemetry. rejectedTelemetry carries `checks: []`, and on
// the MULTI-SITE heavy path (serve-and-gate.ts runPerSiteHeavyGates) one grant is split across
// several runGateStage calls whose checks are concatenated. A bundle failure on the url-bound
// call would contribute nothing while the deterministic call contributed passes -- so the
// aggregate is `fail` carrying only PASSING checks. Control-plane side that is the worst shape
// there is: `failedWithoutChecks` is false, `isInfraUnjudgedOnly` is false (it requires a
// failed check), and `maxFixRoundsFor([], cap)` returns the FULL budget -- so the pipeline
// spends every fix round on a contentless prompt, each followed by a whole heavy re-run, then
// blocks the subtask with "fix loop exhausted": a reason that is a lie about a gate that never
// ran. That is the trap action-entry.ts's crashTelemetry was written to escape, and this is
// the same remedy -- publish a real, honestly-classified check.
async function resolvePackGates(
  grant: ExecutionGrant,
  deps: RunGateStageDeps,
  genericSpecs: Extract<GateSpec, { kind: 'generic' }>[],
  enabledIds: string[],
): Promise<GateResult | undefined> {
  const unresolved = (): string[] => enabledIds.filter((id) => !deps.registry.get(id));
  if (unresolved().length === 0) return undefined;

  const failure = (finding: string, transient = false): GateResult => ({
    id: PACK_BUNDLE_GATE_ID,
    status: 'unjudged',
    ...(transient ? { unjudgedReason: 'infra' as const } : {}),
    findings: [finding],
  });

  if (!grant.packBundle) {
    return failure(
      `gate stage cannot run: the grant's signed gateSpecs name ${unresolved().join(', ')}, which the runner ` +
        'cannot execute and which no signed packBundle was provided to supply',
    );
  }

  let gates: Gate[];
  try {
    gates = await (deps.loadPackGates ?? loadPackBundleGates)(grant.packBundle);
  } catch (err) {
    // The message is built by pack-bundle.ts and is credential-free by construction; it is
    // reproduced verbatim into the check's findings, which is what reaches an operator.
    const code = err instanceof PackBundleError ? err.code : 'error';
    const message = err instanceof Error ? err.message : String(err);
    return failure(`pack bundle ${code}: ${message}`, TRANSIENT_BUNDLE_FAILURES.has(code));
  }

  // Register only what the SIGNED specs named. A bundle that ships extra gates cannot
  // introduce one the tenant isn't entitled to.
  registerGatesForSpecs(deps.registry, gates, genericSpecs.map((spec) => spec.id));

  const stillMissing = unresolved();
  if (stillMissing.length > 0) {
    return failure(`gate stage cannot run: the pack bundle did not supply ${stillMissing.join(', ')}`);
  }
  return undefined;
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

  // A `{kind:'generic'}` spec and a `{kind:'command'}` spec are not equally trusted, though one
  // signature covers both. A generic spec names OUR code -- the runner's bundled catalog, or a pack
  // gate fetched and checksum-verified against the signed digest. A command spec carries a shell
  // line from the tenant's own PackConfig.commandGates, which the control plane signs without
  // reading. The signature establishes who SENT the grant, never who authored the string.
  //
  // THE INVARIANT: a signed gate's published check name belongs to the signed gate. A command spec
  // that lands on one is refused -- it does not run, it is not registered, and it never reports.
  // It may neither speak as a signed gate nor silence one.
  //
  // Reserved by NAME, not by gate id, because a check's name is its identity everywhere downstream
  // (see reservedCheckNames) and the per-site lanes publish suffixed names. Site names come from
  // the SIGNED `grant.sites`, so the reserved set is not tenant-shaped at run time.
  //
  // Refused rather than silently dropped: preferring the signed gate WITHOUT saying so is the same
  // failure mirrored -- a command gate could be deleted by naming it after a signed one, and the
  // stage would read as a clean pass. The refusal publishes its own blocking `unjudged` check
  // below, and the signed gate still runs, so the report carries both the trusted verdict and the
  // fact that something stood on its name.
  //
  // Detected on the SPECS, not on "is this name already in the registry". The registry cannot tell
  // a bundled gate from a command gate an earlier call registered over the same registry (the heavy
  // stage makes several), and it covers nothing extra: generic gates are unconditional in
  // enabledGateSpecs, so an id naming a bundled gate always arrives with a generic spec beside it.
  const reserved = reservedCheckNames(
    genericSpecs.map((spec) => spec.id),
    (grant.sites ?? []).map((site) => site.name),
  );
  // Deduped: two command specs may name the SAME reserved check, and the report says the name is
  // taken once, not once per entry that tried.
  const displacedNames = [...new Set(commandSpecs.map((spec) => spec.id).filter((id) => reserved.has(id)))];

  // A generic spec's signed `config` is authorization-adjacent policy (severity thresholds,
  // forbidden-path lists, ...) -- it overrides the runner-supplied, unsigned
  // GateTarget.config for that same gate id, never the other way around.
  //
  // Each per-gate entry is COPIED, not aliased. The heavy stage calls runGateStage several times
  // with the same `deps.target` and the same signed `grant`, so assigning `spec.config` itself
  // would hand every lane -- and every site within a lane -- the same mutable object, and a gate
  // that edits its own config (a normaliser filling a default in place) would leak that edit into
  // the next lane's run. Only the site-scoped lane was accidentally safe, because its overlay
  // always spreads. One shallow copy per gate, matching the guarantee `changedFiles` gets below.
  const config: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(deps.target.config ?? {})) config[id] = copyConfigValue(value);
  for (const spec of genericSpecs) {
    if (spec.config !== undefined) config[spec.id] = copyConfigValue(spec.config);
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
    // COPIED, always -- not just on the override path, and for the same reason the per-gate config
    // entries above are: the heavy stage calls runGateStage several times with the SAME
    // `deps.target`, so handing the array itself to a gate lets one gate's mutation shorten the
    // next lane's (or the next site's) list. A fresh array per call costs nothing next to running
    // a gate.
    changedFiles: [...(deps.changedFilesOverride ?? deps.target.changedFiles)],
    workspaceRoot,
    vcsHost: deps.vcsHost,
    config,
    ...(stackProfiles.length > 0 ? { stackProfiles } : {}),
  };

  // Command gates aren't in the runner's static bundle -- they are declared per tenant and
  // arrive as signed `{kind:'command'}` specs. Build a createCommandGate instance for each
  // and register it (dynamically named) so the registry runs it exactly like a generic gate,
  // scoped to the PR checkout.
  // Guard against a duplicate register: the heavy stage calls runGateStage more than once with
  // the SAME registry (deterministic gates once, URL-bound gates once per site), so a command
  // gate already built on a prior call must not be re-registered (GateRegistry.register throws).
  for (const spec of commandSpecs) {
    // A signed or synthetic check owns this name (see the invariant above): the command never
    // runs, so it is never registered under a name it may not answer to.
    if (reserved.has(spec.id)) continue;
    if (deps.registry.get(spec.id)) continue;
    deps.registry.register(
      createCommandGate(
        {
          name: spec.id,
          run: spec.run,
          ...(spec.blocking !== undefined ? { blocking: spec.blocking } : {}),
          // Changed-path scope, honoured against ctx.changedFiles inside the gate: a scoped gate
          // whose patterns this diff misses SKIPS rather than running. Dropping it here would
          // make a signed scope a silent no-op, which is the shape onBase already is.
          ...(spec.paths ? { paths: spec.paths } : {}),
        },
        workspaceRoot,
      ),
    );
  }

  // `onlyGateIds` narrows the signed set to the gates THIS call runs (the heavy stage's per-site
  // split). It never widens: an id absent from the signed specs still can't run.
  const runnable = (id: string): boolean => !deps.onlyGateIds || deps.onlyGateIds.has(id);
  //
  // A REFUSED command spec (displacedNames) is not enabled: it is not going to run, so counting it
  // here would make the stage demand a gate for a name nothing will ever supply -- resolvePackGates
  // would read it as a signed id waiting on the bundle and fail the stage with a bundle diagnosis,
  // and the `missing` backstop would report it as NOT RUN. Both would be describing the refusal in
  // the wrong words, and both would drown the collision check that describes it in the right ones.
  const enabledIds = [
    ...genericSpecs.map((spec) => spec.id),
    ...commandSpecs.map((spec) => spec.id).filter((id) => !reserved.has(id)),
  ].filter(runnable);

  // Resolve every enabled id to an executable Gate BEFORE running anything, fetching the
  // private pack bundle when that is what an id is waiting on.
  //
  // An unresolved id cannot reach a green stage either way -- the `missing` check below is the
  // backstop that fails the stage for any enabled id that produced no result. This runs first
  // because the backstop can only say "NOT RUN"; only here do we still know WHY (bundle
  // unreachable, digest mismatch, token expired), and that reason is what decides whether the
  // control plane retries or sends it to a human. So the value added here is the diagnosis and
  // the fetch, not the refusal.
  const packBundleFailure = await resolvePackGates(grant, deps, genericSpecs, enabledIds);
  if (packBundleFailure) {
    // The signed note rides along on the failure's own check rather than being dropped: "the
    // bundle would not load" and "the bundle you are pinned to is not the current one" are
    // different facts, and the second is often the explanation of the first. Appended, so the
    // failure's own diagnosis stays the first thing read, and the status is untouched.
    const withNote = grant.packBundle?.note
      ? { ...packBundleFailure, findings: [...(packBundleFailure.findings ?? []), grant.packBundle.note] }
      : packBundleFailure;
    // Say it in the job log too. The check's findings are what an operator reads on the PR, but
    // a stage that resolved nothing must not be silent in the Actions log either -- the same
    // reason the per-gate lines further down exist.
    for (const finding of withNote.findings ?? []) {
      process.stdout.write(`[gate] ${PACK_BUNDLE_GATE_ID}: ${finding}\n`);
    }
    return {
      grantId: grantId(grant),
      result: 'fail',
      checks: toChecks([withNote], deps.checkNameSuffix),
      logDigest: digestFor(grant.repoId, grant.ticketId, grant.stage, PACK_BUNDLE_GATE_ID),
    };
  }

  const genericReport = await deps.registry.run(enabledIds, ctx);

  // When `onlyGateIds` restricts the call, drop the `skip` results the registry emits for every
  // OTHER registered gate -- otherwise each per-site call would republish the deterministic gates'
  // checks (and the sites' checks would collide across calls). Absent -> report every result.
  const gateResults = deps.onlyGateIds
    ? genericReport.results.filter((result) => deps.onlyGateIds!.has(result.id))
    : genericReport.results;

  // The refused command specs, reported. `unjudged` with NO `unjudgedReason`, deliberately: the
  // gate the tenant declared reached no verdict (it was never allowed to run), which must never
  // read as a pass, and a reason-less unjudged is the non-revertable classification -- worth zero
  // fix rounds and escalated straight to a human, which is right for a config fault no edit to
  // the PR's own diff can clear.
  //
  // Narrowed to `runnable` and suffixed like every other check, so the heavy stage's per-lane and
  // per-site calls publish this once, under a unique name, on the one lane the colliding name
  // belongs to -- the same treatment the pack-bundle failure gets.
  //
  // ONE-TIME COVERAGE ALARM, on the promotion AFTER a collision is fixed. This check is published
  // only while a collision exists, so `gate:gate-spec-collision` enters promotionCoverageSet on the
  // promotion where one fires and is absent from the next -- which the coverage diff reads as a
  // regression. It is notifier-only and self-heals once that promotion stores the new baseline, and
  // it fires on the GOOD news (somebody fixed the config), so it is an expected alarm rather than a
  // real one. Same class as the `baseId` flip documented in adapters/github-actions/ci-runner.ts.
  const collidedHere = displacedNames.filter(runnable);
  const collisionResults: GateResult[] =
    collidedHere.length === 0
      ? []
      : [
          {
            id: GATE_SPEC_COLLISION_GATE_ID,
            status: 'unjudged',
            findings: collidedHere.map(
              (id) =>
                `a command gate spec claims the reserved check name "${id}". That name belongs to a signed ` +
                'gate, which keeps it and its own check; the command gate was REFUSED and did not run. ' +
                'Rename the command gate in the repo\'s gate configuration.',
            ),
          },
        ];
  // The signed pack-bundle note, published beside the verdicts and NEVER as one.
  //
  // `warn` + `noVerdict` is this file's own shape for "it ran and banked nothing": toCheckStatus
  // maps it to `pending`, toChecks tags it `reportOnly`, and the `ok` computation below cannot key
  // on it. NOT `pass`. A pass is equally unable to change the stage's outcome, but it is BANKED --
  // recordedGateChecks stores it, executionCoverageResults maps it to a real result, and
  // promotionCoverageSet writes `gate:pack-bundle` into the tenant's coverage baseline. The next
  // revision that carries no note (a rollback, or a deployment that stamps no expected digest)
  // would then drop that id and trip `coverage_regression` naming a gate that never gated
  // anything. An annotation must not enter the coverage record at all.
  //
  // The note says how the bundle this run was pinned to relates to the one the control plane's own
  // build produces, a comparison the runner structurally cannot make for itself: it holds bytes and
  // a signed digest that agree, and no notion of "current". So this is annotation carried in, not
  // judgment reached here, and no branch below may key a verdict on it.
  //
  // Published on the SAME id a bundle FAILURE publishes under, deliberately: one name for one
  // subject, so a human reading the PR finds the bundle's story in one place. The two cannot
  // collide, because a failure returns from this function long before here.
  //
  // ONCE PER GRANT, on the unsuffixed lane only. serve-and-gate.ts's runPerSiteHeavyGates splits
  // one grant across up to 1 + 2N calls of this function, and the note is a property of the GRANT
  // rather than of any lane -- so publishing it from every call would emit N+1 copies of one
  // sentence, two of which would share a name (`pack-bundle (<site>)`, from the site-scoped loop
  // and the url-bound one). That is the exact collision the reserved-name check above exists to
  // prevent, so the note gets the same treatment: one lane, one name.
  const bundleNote = deps.checkNameSuffix ? undefined : grant.packBundle?.note;
  const noteResults: GateResult[] = bundleNote
    ? [{ id: PACK_BUNDLE_GATE_ID, status: 'warn', noVerdict: true, findings: [bundleNote] }]
    : [];
  const results = [...gateResults, ...collisionResults, ...noteResults];
  // Report-only gates (`blocking:false`, from PackConfig.gateConfig[id] for a generic gate or
  // PackConfig.commandGates for a command one) still publish their per-gate check with its honest
  // `fail`, but that fail is excluded from the stage's blocking verdict -- advisory, not
  // merge-blocking. ONE set covering BOTH spec kinds, deliberately: command gates used to rewrite
  // their own verdict to `warn` instead, which published green over a red command.
  const nonBlockingIds = new Set(
    specs.filter((spec) => spec.kind !== 'prompt' && spec.blocking === false).map((spec) => spec.id),
  );
  // An `unjudged` gate ALWAYS blocks -- report-only (`blocking:false`) can excuse a *finding*
  // fail (the gate judged and reported a defect it's non-blocking about), but NEVER a gate that
  // reached no verdict at all. A green stage on a gate that never ran is worse than no gate
  // (the false-green post-mortem), so nonBlockingIds cannot rescue it.
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
    checks: toChecks(results, deps.checkNameSuffix, nonBlockingIds),
    // Rendered lines, not the raw profiles: the gate report is read by people (and pasted into
    // tickets), and "node: yarn-classic (pinned yarn@1.22.22) — detected from package.json,
    // yarn.lock" is legible where a nested JSON blob is not. Carries no verdict -- it is the
    // context a verdict was reached in. Omitted entirely when nothing was detected.
    ...(stack.length > 0 ? { stack } : {}),
    logDigest: digestFor(grant.repoId, grant.ticketId, grant.stage, String(specs.length)),
  };
}
