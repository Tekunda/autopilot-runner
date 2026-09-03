// `security-deps` / `cve` gate: dependency audit via deterministic tooling
// (the repo's OWN package manager), never the LLM, per AGENTS.md
// ("Deterministic control, LLM only for judgment"). The audit tool is injected
// as a DependencyAuditor so the gate's own logic (severity thresholding,
// formatting) is pure and testable without shelling out; the default factory
// wires up the real package-manager audit. See issue #77.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT: an audit that could not RUN must
// never be reportable as "clean". The first version of this gate ran
// `npm audit --json` unconditionally and did `report.vulnerabilities ?? {}`.
// On a Yarn tenant (Tekunda/Website: `yarn.lock`, no `package-lock.json`) npm
// exits non-zero and prints a perfectly VALID JSON error document --
//   {"error":{"code":"ENOLOCK","summary":"This command requires an existing lockfile.",...}}
// -- so `JSON.parse` succeeded, `?? {}` turned the missing `vulnerabilities`
// key into zero advisories, and the gate reported `pass` on every run while
// auditing nothing at all. A known high/critical CVE would have merged behind a
// green security check.
//
// Every rule below exists because SOME lookup miss, absent key, or unreadable
// document must not be able to mean "benign":
//
//   1. THREE outcomes, not two: advisories, nothing-to-audit, and COULD NOT
//      DETERMINE. `inconclusive` becomes `unjudged` -- a gate that ran and
//      reached no verdict, which run-gate-stage always treats as merge-blocking
//      and never as a pass (gates/types.ts). `not-applicable` (a tree with no
//      Node manifest AND no lockfile -- a Python or docs repo) becomes
//      `skip`/`no-config`, the type system's existing way to say "nothing to
//      do" while staying distinguishable from a pass in the promotion record.
//      Without that split, a blocking gate no tenant can disable would wedge
//      every non-Node repo forever.
//   2. `unjudgedReason` is classified, not assumed. A ROUTING or SHAPE problem
//      is deterministic -- re-reading the same tree yields the same non-report --
//      so it is `content` and escalates to a human at once. A spawn failure,
//      timeout, or registry/network fault MIGHT clear on a re-run, so it is
//      `infra` and earns the bounded gate-only retry that lane exists for.
//   3. Severity lookups go through a Map, never an object literal. An object
//      literal's `[key]` reaches Object.prototype, so a registry (or a crafted
//      advisory) answering `"severity":"constructor"` would return a truthy
//      function, sail past a truthiness check, and then rank as `undefined`,
//      which is `>= threshold`-false -- the advisory silently vanishes. Same
//      reason the threshold filter treats an unrankable severity as a FINDING
//      rather than as "below threshold".
//   4. "Absent" and "unreadable" are different facts. A file that cannot be READ
//      (EACCES, EISDIR, EMFILE) must never read as a file that is not THERE:
//      absence routes to `repo-shape`, the one class an operator may demote with
//      `cve.blocking:false`, so collapsing the two would let a chmod, a
//      committed directory, or a transient fd exhaustion turn a real audit into
//      a report-only warning on exactly the tenants that took the hatch.
//   5. The audited tree does not get to choose its own advisory source. See
//      auditArgsFor: `npm audit` is pinned to the public registry with the
//      user config neutralised, and `yarn` runs with `--no-default-rc`, because
//      a `.yarnrc` committed BY THE BRANCH BEING GATED can carry `yarn-path`
//      and make the security gate execute an arbitrary script out of the PR
//      (verified live: a two-line `.yarnrc` + script printed its payload from
//      inside `yarn audit`; `--no-default-rc` stops it).
//
// The distinction that must never blur: `vulnerabilities` PRESENT AND EMPTY
// (`{"vulnerabilities":{}}`, what a healthy npm repo prints) is CLEAN and must
// pass; `vulnerabilities` ABSENT is could-not-determine. Yarn 1's analogue is
// the `auditSummary` NDJSON line -- it is printed on a clean audit too, so its
// ABSENCE is the "this audit never completed" signal.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { runCommand } from '../exec.ts';
// The package-manager parsers this file used to keep privately (`detectYarnMajor`,
// `readPackageManagerPin`) now live in the ONE stack detector, which corepack-guard.ts reads
// too -- same functions, moved verbatim, so this gate's routing is unchanged.
import { detectYarnMajor, readPackageManagerPin } from '../stack-profile.ts';
// The vocabulary both auditors speak, and the osv-scanner half of the audit. Split out of this
// file so that cve.ts -> osv-scanner.ts -> audit-outcome.ts stays one-way: leaving the shared
// types here would have made this file and osv-scanner.ts import each other.
import {
  classifyToolDiagnostic,
  inconclusive,
  preview,
  rankOf,
  SEVERITY_RANK,
  type AuditOutcome,
  type InconclusiveCause,
  type Severity,
} from './audit-outcome.ts';
import { detectEmptyAuditedTree, parseNpmAuditOutput, parseYarnClassicAuditOutput } from './npm-yarn-audit.ts';
import { NON_JS_MANIFESTS, OSV_ARGS, parseOsvScannerOutput } from './osv-scanner.ts';
import { readGateConfig } from './config.ts';
import type { Gate, GateContext, GateResult, SkipReason } from '../types.ts';

// Re-exported so the audit vocabulary still has ONE public name for importers (tests, and any
// future caller): the split above is an internal layering fix, not an API change.
export {
  parseOsvScannerOutput,
  severityForCvssScore,
  NON_JS_MANIFESTS,
} from './osv-scanner.ts';
export { detectEmptyAuditedTree, parseNpmAuditOutput, parseYarnClassicAuditOutput } from './npm-yarn-audit.ts';
export type {
  AdvisorySeverity,
  AuditOutcome,
  DependencyAdvisory,
  InconclusiveCause,
  Severity,
} from './audit-outcome.ts';








export interface DependencyAuditor {
  // `cwd` is the tree to audit -- the customer's checked-out PR (ctx.workspaceRoot),
  // not the runner's own action directory. Falls back to process.cwd() when empty.
  audit(cwd?: string): Promise<AuditOutcome>;
}

export interface CveGateConfig {
  minSeverity: Severity;
  // The operator's escape hatch, and deliberately a narrow one. `cve` is a
  // generic gate: packs/registry.ts makes it unconditional, run-gate-stage
  // refuses to let a non-blocking flag rescue an `unjudged`, and fix-loop gives
  // it zero fix rounds -- so a repo shape this gate cannot audit (pnpm, Yarn
  // Berry, a monorepo whose lockfiles are not at the root) would otherwise be a
  // permanent, unrecoverable merge block on every PR forever. `false` demotes
  // ONLY the `repo-shape` class to a report-only `warn`. An audit that RAN and
  // failed, or one that could not reach the registry, is never demotable: the
  // operator can accept "we cannot audit this repo's shape", not "ignore that
  // the check broke".
  //
  // STAGED ROLLOUT, and the reason the default is not simply `true`. osv-scanner brought whole
  // ecosystems -- Python, Go, Rust, Ruby, Java, PHP -- under this gate for the first time. Those
  // repos previously got NO dependency verdict at all, so the new risk is not the audit, it is
  // the PROVISIONING: an egress policy that blocks the release host, or a runner arch nothing is
  // pinned for, would turn "no verdict" into "every PR blocked" for every one of those tenants at
  // once, on a path with no field evidence behind it yet.
  //
  // So for NEWLY COVERED trees only (AuditOutcome.newCoverage), an audit that could not run
  // defaults to a report-only `warn` -- the finding is published, nothing merges on a green check
  // that never ran, and nothing gates until someone has seen provisioning work. A tenant flips it
  // with one line, `cve.blocking: true`, once their own repo has produced a real osv-scanner
  // verdict. An EXPLICIT setting always wins in both directions; this default only applies when
  // the tenant has said nothing.
  //
  // Deliberately narrow: a tree npm or Yarn was already auditing (including the Yarn Berry and
  // pnpm shapes, which reported a blocking `unjudged` before osv-scanner existed) is NOT new
  // coverage and goes on blocking exactly as it did. Staging may not weaken a guarantee anyone
  // already had.
  blocking: boolean;
}

const DEFAULT_CONFIG: CveGateConfig = { minSeverity: 'high', blocking: true };

// Whether a tenant SAID anything about `cve.blocking`, as opposed to inheriting the default.
// readGateConfig is a spread over the defaults, so it cannot answer this -- and the staged
// rollout above turns entirely on the difference between "the tenant chose to block" and "nobody
// has decided yet".
function blockingWasSetExplicitly(config: Record<string, unknown>): boolean {
  const raw = config['cve'];
  return typeof raw === 'object' && raw !== null && typeof (raw as { blocking?: unknown }).blocking === 'boolean';
}

const AUDIT_REGISTRY = 'https://registry.npmjs.org/';




// ---------------------------------------------------------------------------
// Which audit tool does this tree need?
// ---------------------------------------------------------------------------

export type AuditTool = 'npm' | 'yarn-classic' | 'osv';

export type AuditPlan =
  | {
      kind: 'run';
      tool: AuditTool;
      command: string;
      args: string[];
      // Why THIS tree needed a tool the runner does not have, for the message the gate reports
      // when the binary will not spawn. Only the `osv` plans set it: npm and yarn are part of the
      // runner's Node image, so their absence is infrastructure and keeps the `transient-failure`
      // treatment. Set -> a spawn failure that says "not installed" (ENOENT/EACCES/EPERM) is
      // `tooling-missing`, which blocks and is demotable, rather than a retry-forever infra fault.
      missingTool?: string;
      // True when npm and Yarn could not have audited this tree AT ALL -- the non-JavaScript
      // routing. Rides through to the outcome so the staged rollout can tell brand-new coverage
      // apart from coverage that already gated (Yarn Berry and pnpm, which blocked before
      // osv-scanner existed and must go on blocking). See CveGateConfig.blocking.
      newCoverage?: boolean;
    }
  | { kind: 'not-applicable'; reason: string }
  | { kind: 'inconclusive'; cause: InconclusiveCause; reason: string };

// Reads one workspace-relative file, or undefined when it does not exist /
// cannot be read. Presence is the signal for the lockfiles; contents are only
// needed for package.json and the Yarn lockfile header. Kept as an injected
// function (the corepack-guard convention) so planning stays pure and
// filesystem-free in tests.
export type ReadWorkspaceFile = (relativePath: string) => string | undefined;

const NPM_LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json'];


// Hardened invocations. The tree being audited is UNTRUSTED -- it is the PR under
// review -- so it must not get to choose where advisories come from, or what code
// the audit runs.
//   npm : `--registry` pins the advisory source (CLI beats a repo-committed
//         `.npmrc`, verified) and `--userconfig=/dev/null` drops the ambient user
//         config. Without them a `.npmrc` in the PR redirects the bulk-advisory
//         POST: an attacker-controlled registry can answer "no advisories" for a
//         tree full of CVEs, and it receives the tenant's entire resolved
//         dependency manifest on the way. (A project-level `@scope:registry` can
//         still steer scoped lookups; that needs a sandboxed copy of the tree to
//         close properly and is out of scope here.)
//   yarn: `--no-default-rc` is the important one. A `.yarnrc` committed by the
//         branch can set `yarn-path`, which makes the `yarn` binary DELEGATE to a
//         script from the repo -- verified live, arbitrary code execution inside
//         the security gate. `--no-default-rc` stops it. Yarn 1.22's audit
//         endpoint is not configurable (verified: a dead registry in `.yarnrc`,
//         in `.npmrc`, and via `--registry` all still returned real advisories),
//         so there is no registry flag to pin here.

function auditArgsFor(tool: AuditTool): string[] {
  if (tool === 'npm') return ['audit', '--json', `--registry=${AUDIT_REGISTRY}`, '--userconfig=/dev/null'];
  if (tool === 'osv') return [...OSV_ARGS];
  return ['--no-default-rc', 'audit', '--json'];
}

const AUDIT_COMMANDS: Readonly<Record<AuditTool, string>> = {
  npm: 'npm',
  'yarn-classic': 'yarn',
  osv: 'osv-scanner',
};

function runPlan(tool: AuditTool): AuditPlan {
  return { kind: 'run', tool, command: AUDIT_COMMANDS[tool], args: auditArgsFor(tool) };
}

// An osv-scanner plan, plus the phrase naming what this tree needed it for.
function osvPlan(missingTool: string, newCoverage = false): AuditPlan {
  return {
    ...(runPlan('osv') as Extract<AuditPlan, { kind: 'run' }>),
    missingTool,
    ...(newCoverage ? { newCoverage: true } : {}),
  };
}


function shapeProblem(reason: string): AuditPlan {
  return { kind: 'inconclusive', cause: 'repo-shape', reason };
}

// Pure routing. Mirrors what the pipeline this gate replaced did
// (Tekunda/Website scripts/security-deps-check.sh: npm when a sibling
// package-lock.json exists, otherwise yarn) and then goes further, because
// "yarn" is two incompatible tools:
//   - Yarn 1 classic: `yarn audit --json`, NDJSON (one JSON object per LINE).
//   - Yarn 2+ (Berry): `yarn audit` does not exist; it is `yarn npm audit`,
//     with a different output document again.
//
// The `packageManager` pin is consulted FIRST, for every manager -- it is what
// corepack activates, so it decides which binary actually runs whatever the
// lockfiles say. Deciding on lockfile presence alone let a stray, unmaintained
// `package-lock.json` in a Yarn repo re-point the audit at a tree nobody
// maintains: npm reads it, reports `"vulnerabilities":{}` (present and empty, so
// a legitimately CLEAN result), and the gate passes while the real Yarn tree
// carries criticals. Two lockfile families with no pin to break the tie is
// therefore inconclusive, not a coin flip.
//
// Every branch this function cannot identify returns `inconclusive` -- never a
// silent fall-through to npm, which is exactly how the ENOLOCK pass happened.
// The ecosystem question, answered once and separately from the routing that follows: does this
// tree carry JavaScript, and does it carry anything npm and Yarn cannot read? Split out of
// planDependencyAudit because the two decisions are independent -- which manifests EXIST, then
// which tool that implies -- and reading them interleaved is what made the routing hard to check.
interface TreeShape {
  packageJson: string | undefined;
  hasNpmLock: boolean;
  yarnLock: string | undefined;
  hasPnpmLock: boolean;
  hasJs: boolean;
  nonJs: string[];
}

function readTreeShape(readFile: ReadWorkspaceFile): TreeShape {
  const packageJson = readFile('package.json');
  const hasNpmLock = NPM_LOCKFILES.some((name) => readFile(name) !== undefined);
  const yarnLock = readFile('yarn.lock');
  const hasPnpmLock = readFile('pnpm-lock.yaml') !== undefined;
  return {
    packageJson,
    hasNpmLock,
    yarnLock,
    hasPnpmLock,
    hasJs: packageJson !== undefined || hasNpmLock || yarnLock !== undefined || hasPnpmLock,
    nonJs: NON_JS_MANIFESTS.filter((name) => readFile(name) !== undefined),
  };
}

export function planDependencyAudit(readFile: ReadWorkspaceFile): AuditPlan {
  const { packageJson, hasNpmLock, yarnLock, hasPnpmLock, hasJs, nonJs } = readTreeShape(readFile);

  // NOTHING TO AUDIT, and knowing that does NOT require the scanner. This is decided from the
  // manifests alone so that a docs/Terraform repo with no dependency tree of any kind stays the
  // benign skip it has always been even on a runner where osv-scanner is missing -- the tool is
  // only ever needed once there is something for it to read.
  if (!hasJs && nonJs.length === 0) {
    return {
      kind: 'not-applicable',
      reason:
        'no dependency audit to run: the PR checkout has no package.json, no npm/Yarn/pnpm lockfile, and no ' +
        `manifest for any other ecosystem this gate audits (looked for ${NON_JS_MANIFESTS.join(', ')}), ` +
        'so there is no dependency tree to audit.',
    };
  }

  // A NON-JAVASCRIPT TREE IS PRESENT -- with or without JavaScript beside it. `npm audit` and
  // `yarn audit` are the only two tools above, so this used to split two ways and get both wrong:
  // a pure Python/Go/Rust repo returned `not-applicable` (the gate the product page describes as
  // running "on every diff" ran on none of them), and a POLYGLOT repo -- a Python service with a
  // JS front end, the common shape -- routed to `npm audit`, audited half its dependencies, and
  // reported a clean pass over the unaudited half with no skip and no note.
  //
  // osv-scanner reads every one of these ecosystems AND npm/Yarn/pnpm from one pass over the
  // tree, so the whole repo goes to it. That trades npm's richer `via` chains for covering the
  // dependencies that were not being looked at, which is not a close call.
  if (nonJs.length > 0) {
    return osvPlan(
      `this repo carries ${nonJs.join(', ')}, which npm and Yarn cannot audit, so auditing it`,
      true,
    );
  }

  return planJsAudit(readFile, packageJson, hasNpmLock, yarnLock, hasPnpmLock);
}

// PURE JAVASCRIPT, so npm/Yarn's richer advisories are worth routing to. Unchanged from before
// osv-scanner existed except that Berry and pnpm now have somewhere to go.
function planJsAudit(
  readFile: ReadWorkspaceFile,
  packageJson: string | undefined,
  hasNpmLock: boolean,
  yarnLock: string | undefined,
  hasPnpmLock: boolean,
): AuditPlan {
  const pin = readPackageManagerPin(packageJson);
  if (pin) return planFromPin(pin, hasNpmLock, yarnLock !== undefined);

  const present = [
    hasNpmLock ? NPM_LOCKFILES.join('/') : undefined,
    yarnLock !== undefined ? 'yarn.lock' : undefined,
    hasPnpmLock ? 'pnpm-lock.yaml' : undefined,
  ].filter((name): name is string => name !== undefined);

  if (present.length > 1) {
    return shapeProblem(
      `dependency audit not run: the repo root carries lockfiles for more than one package manager ` +
        `(${present.join(', ')}) and has no \`packageManager\` pin to break the tie. Auditing the wrong one ` +
        'reports a clean tree that nobody installs from. Pin the manager (e.g. "packageManager": ' +
        '"yarn@1.22.22") or delete the stale lockfile.',
    );
  }

  if (hasNpmLock) return runPlan('npm');

  if (yarnLock !== undefined) {
    const major = detectYarnMajor(readFile('.yarnrc.yml') !== undefined, yarnLock);
    if (major === 1) return runPlan('yarn-classic');
    if (major === undefined) {
      return shapeProblem(
        'dependency audit not run: the repo has a `yarn.lock` but its Yarn major version could not be ' +
          'determined (no `packageManager` pin in package.json, no `.yarnrc.yml`, and no `yarn lockfile v1` ' +
          'header). Yarn 1 and Yarn 2+ need different audit commands, so no audit was attempted. Pin the ' +
          'manager (e.g. "packageManager": "yarn@1.22.22") so the gate can route.',
      );
    }
    return berryUnsupported(major);
  }

  if (hasPnpmLock) return pnpmUnsupported();

  // A Node manifest with no lockfile: there is a dependency tree here, but no
  // RESOLVED one to audit, so this is genuinely "could not determine" rather than
  // "nothing to do" -- including the monorepo whose lockfiles live under
  // `packages/*` rather than at the root.
  return shapeProblem(
    'dependency audit not run: the PR checkout has a package.json but no lockfile at the repo root ' +
      '(looked for package-lock.json, npm-shrinkwrap.json, yarn.lock, pnpm-lock.yaml). Without a lockfile ' +
      'there is no resolved dependency tree to audit, so no result -- clean or otherwise -- can be claimed. ' +
      'Set `cve.blocking: false` for this repo if it is audited elsewhere.',
  );
}

function planFromPin(pin: string, hasNpmLock: boolean, hasYarnLock: boolean): AuditPlan {
  const parsed = /^([^@\s]+)@(\d+)(?:[.\d]*)?/.exec(pin.trim());
  const manager = parsed?.[1];
  const major = parsed ? Number(parsed[2]) : undefined;

  if (manager === 'npm') {
    if (hasNpmLock) return runPlan('npm');
    return shapeProblem(
      `dependency audit not run: package.json pins \`${pin}\` but the repo root has no package-lock.json ` +
        'or npm-shrinkwrap.json, so npm has no resolved tree to audit.',
    );
  }
  if (manager === 'yarn') {
    if (major !== 1) return berryUnsupported(major ?? 0);
    if (hasYarnLock) return runPlan('yarn-classic');
    return shapeProblem(
      `dependency audit not run: package.json pins \`${pin}\` but the repo root has no yarn.lock, so ` +
        'Yarn has no resolved tree to audit.',
    );
  }
  if (manager === 'pnpm') return pnpmUnsupported();
  return shapeProblem(
    `dependency audit not run: package.json pins \`${pin}\`, a package manager this gate does not support ` +
      'yet. It is reported as unjudged rather than passed, because an audit that never ran is not a clean audit.',
  );
}

// Yarn 2+ (Berry) and pnpm: BOTH were un-auditable here, because `yarn npm audit --json` and
// `pnpm audit --json` each emit a document this file has no verified parser for, and guessing one
// risks reading an unrecognised document as zero advisories -- the bug this file was written to
// end. osv-scanner reads `yarn.lock` v2+ and `pnpm-lock.yaml` directly, so it audits both without
// anyone guessing a format.
//
// The fallback is the OLD behaviour verbatim, not a skip: these trees ARE JavaScript, npm/Yarn 1
// demonstrably cannot read them, and if osv-scanner is missing too then nothing audited them.
// Downgrading that to a skip because we added a scanner would take away a guarantee the tenant
// already had.
function berryUnsupported(major: number): AuditPlan {
  return osvPlan(
    `this repo uses Yarn ${major || '2+'} (Berry), whose \`yarn npm audit --json\` output this gate does not ` +
      'parse, so auditing it',
  );
}

function pnpmUnsupported(): AuditPlan {
  return osvPlan('this repo uses pnpm, whose audit output this gate does not parse, so auditing it');
}

// `detectYarnMajor` (only reached when there is no `packageManager` pin, which
// planDependencyAudit consults first) and `readPackageManagerPin` moved to
// ../stack-profile.ts, imported above -- they were duplicated verbatim in
// runner/corepack-guard.ts, and the same two facts are what a Python/Salesforce
// tenant needs answered too. Their rules and their rationale travelled with them.

export function parseAuditOutput(tool: AuditTool, stdout: string, stderr = ''): AuditOutcome {
  if (tool === 'npm') return parseNpmAuditOutput(stdout, stderr);
  if (tool === 'osv') return parseOsvScannerOutput(stdout, stderr);
  return parseYarnClassicAuditOutput(stdout, stderr);
}




// ---------------------------------------------------------------------------
// The real auditor.
// ---------------------------------------------------------------------------

export interface AuditCommandOutput {
  stdout: string;
  stderr: string;
  // THE ONLY SIGNAL osv-scanner GIVES that part of its scan failed. Verified against v2.5.1:
  // `pkg/osvscanner/scan.go` logs a plugin/extractor/enricher whose status is not `Succeeded`
  // and CARRIES ON (`criticalError` is set only for a path named explicitly on the command
  // line, which this gate never does -- it passes `.`), `vulnerability_result.go` initialises
  // `Results` non-nil so the document still prints a perfectly well-formed `"results": []`, and
  // `cmd/.../run.go` then returns 127 because `logHandler.HasErrored()`. Read the document
  // alone and a scan that never reached the OSV database -- or that silently dropped the one
  // manifest carrying the vulnerable tree -- is indistinguishable from a clean repo.
  //
  // Required, not optional-with-a-default: a fake that forgets it would default to 0, and 0 is
  // exactly the value that means "clean". The compiler asking every caller is the point.
  exitCode: number;
}

export type RunAuditCommand = (command: string, args: string[]) => Promise<AuditCommandOutput>;

// The whole audit as a pure-ish function over its two effects (reading the tree,
// running the tool), so the ROUTING is unit-testable without a filesystem or a
// package manager. Every failure path returns `inconclusive` or
// `not-applicable`: a tool that cannot spawn, times out, or blows its output
// budget has produced no verdict, and this gate has exactly one rule -- no
// verdict is never a pass.
export async function runDependencyAudit(
  readFile: ReadWorkspaceFile,
  run: RunAuditCommand,
): Promise<AuditOutcome> {
  // Planning READS THE TREE, so it can fail like any other IO. This function
  // documents that every failure path returns an outcome, so a throwing reader
  // must not escape it as a raw exception. It is `transient-failure` for the same
  // reason an unreadable lockfile is (see createDependencyAuditor): a tree we
  // could not inspect is not a tree we may describe as un-auditable, which is the
  // one class `cve.blocking:false` demotes.
  let plan: AuditPlan;
  try {
    plan = planDependencyAudit(readFile);
  } catch (error) {
    return inconclusive(
      'transient-failure',
      `the PR checkout could not be inspected (${errorText(error)}), so no dependency audit was attempted.`,
    );
  }
  if (plan.kind === 'not-applicable') return { kind: 'not-applicable', reason: plan.reason };
  if (plan.kind === 'inconclusive') return inconclusive(plan.cause, plan.reason);

  const invocation = `${plan.command} ${plan.args.join(' ')}`;
  let output: AuditCommandOutput;
  try {
    output = await run(plan.command, plan.args);
  } catch (error) {
    // THE BINARY IS NOT USABLE, which is a statement about the RUNNER rather than a transient
    // fault: no retry installs osv-scanner, so `transient-failure` would burn the bounded retry
    // budget and then escalate a human to a message about a timeout that never happened.
    //
    // ENOENT is the obvious spelling, but not the only one. A `noexec`-mounted RUNNER_TEMP, a
    // chmod that did not take, or a restrictive umask all surface as EACCES/EPERM -- the file is
    // there and cannot be run, which is the SAME fact for every purpose this gate has. Matching
    // ENOENT alone sent those down the infra lane, where they become a merge-blocking `unjudged`
    // on every PR of every non-JavaScript repo with no retry that can ever clear it.
    // Only the plans that name a `missingTool` take this branch, so npm/yarn are untouched.
    const missing = missingToolOutcome(plan, error);
    if (missing) return missing;
    // Spawn failure, timeout, or a maxBuffer overrun -- the tool never delivered
    // a report. A re-run may well succeed (a wedged runner, a slow registry), so
    // this is the `infra` lane's bounded retry, not an instant escalation.
    return inconclusive(
      'transient-failure',
      `\`${invocation}\` could not be run (${errorText(error)}), so no dependency audit result exists for this PR.`,
    );
  }
  // osv-scanner's exit code is the ONLY place a partially-failed scan is reported -- see
  // AuditCommandOutput.exitCode. 0 (clean) and 1 (vulnerabilities found) are its two verdicts;
  // ANY other code means something in the pipeline errored, and the JSON it printed alongside
  // describes only the part that worked. Reading that document would report a clean audit of a
  // tree whose vulnerable half silently failed to extract.
  //
  // The cause is classified from the diagnostics rather than assumed, the same way every other
  // could-not-determine in this file is: a blip reaching the OSV database is `transient-failure`
  // and earns the bounded retry, while a deterministic extractor error is `no-verdict` and goes
  // straight to a human. npm and Yarn are deliberately NOT judged this way -- npm exits 1 when it
  // finds anything and Yarn 1 exits a bitmask of the severities it found, so for those two only
  // the document shape can decide.
  const partial = partialScanOutcome(plan, output, invocation);
  if (partial) return partial;

  try {
    const outcome = parseAuditOutput(plan.tool, output.stdout, output.stderr);
    if (outcome.kind === 'advisories' && plan.tool === 'npm') {
      const stale = detectEmptyAuditedTree(output.stdout, readFile('package.json'));
      if (stale !== undefined) return inconclusive('repo-shape', stale);
    }
    return outcome;
  } catch (error) {
    // Defence in depth: a parser that throws must still leave through the
    // three-state contract, not as an unhandled rejection that some outer catch
    // renders as an opaque failure.
    return inconclusive('no-verdict', `\`${invocation}\` output could not be parsed (${errorText(error)}).`);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// THE BINARY IS NOT USABLE, which is a statement about the RUNNER rather than a transient fault:
// no retry installs osv-scanner, so `transient-failure` would burn the bounded retry budget and
// then escalate a human to a message about a timeout that never happened.
//
// ENOENT is the obvious spelling, but not the only one. A `noexec`-mounted RUNNER_TEMP, a chmod
// that did not take, or a restrictive umask all surface as EACCES/EPERM -- the file is there and
// cannot be run, which is the SAME fact for every purpose this gate has. Matching ENOENT alone
// sent those down the infra lane, where they become a merge-blocking `unjudged` on every PR of
// every non-JavaScript repo with no retry that can ever clear it.
//
// Returns undefined for every other spawn failure, so npm and Yarn -- part of the runner's Node
// image, and therefore genuinely infrastructure when absent -- keep their old treatment exactly.
function missingToolOutcome(
  plan: Extract<AuditPlan, { kind: 'run' }>,
  error: unknown,
): AuditOutcome | undefined {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (!plan.missingTool || (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM')) return undefined;
  return inconclusive(
    'tooling-missing',
    `dependency audit not run: ${plan.missingTool} needs \`${plan.command}\`, which this runner cannot ` +
      `execute (${errorText(error)}). It is reported as unjudged rather than passed, because a scanner ` +
      'that never ran is not a clean audit -- see the "Provision dependency scanner" step in action.yml.',
    plan.newCoverage === true,
  );
}

// osv-scanner's exit code is the ONLY place a PARTIALLY-failed scan is reported -- see
// AuditCommandOutput.exitCode. 0 (clean) and 1 (vulnerabilities found) are its two verdicts; any
// other code means something in the pipeline errored, and the JSON it printed alongside describes
// only the part that worked. Reading that document would report a clean audit of a tree whose
// vulnerable half silently failed to extract.
//
// The cause is classified from the diagnostics rather than assumed, the same way every other
// could-not-determine in this file is. npm and Yarn are deliberately NOT judged this way -- npm
// exits 1 when it finds anything and Yarn 1 exits a bitmask of the severities it found, so for
// those two only the document shape can decide.
function partialScanOutcome(
  plan: Extract<AuditPlan, { kind: 'run' }>,
  output: AuditCommandOutput,
  invocation: string,
): AuditOutcome | undefined {
  if (plan.tool !== 'osv' || output.exitCode === 0 || output.exitCode === 1) return undefined;
  const diagnostics = `${output.stdout}\n${output.stderr}`;
  return inconclusive(
    classifyToolDiagnostic(diagnostics),
    `\`${invocation}\` exited ${output.exitCode}: part of the scan failed, so the results it printed ` +
      `describe only the part that succeeded and cannot be read as a clean audit.` +
      `${diagnostics.trim() ? ` Diagnostics: ${preview(diagnostics)}` : ''}`,
    plan.newCoverage === true,
  );
}

export function createDependencyAuditor(): DependencyAuditor {
  return {
    async audit(cwd?: string) {
      const root = cwd || process.cwd();
      return runDependencyAudit(
        (relativePath) => {
          try {
            return readFileSync(path.join(root, relativePath), 'utf8');
          } catch (error) {
            // ONLY "it is not there" may read as absent. Collapsing EACCES,
            // EISDIR, EMFILE or EIO into `undefined` makes the planner announce
            // "no lockfile at the repo root" about a lockfile that is RIGHT
            // THERE -- a `repo-shape` verdict, which is the one class
            // `cve.blocking:false` demotes to a warning. A tenant that took the
            // escape hatch would then merge unaudited on a transient EMFILE, or
            // on a PR that commits a DIRECTORY named package-lock.json. Rethrow:
            // runDependencyAudit turns it into a transient-failure, which is
            // never demotable.
            if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return undefined;
            throw error;
          }
        },
        // A non-zero exit is expected from BOTH tools on a healthy run (npm exits
        // 1 when it finds anything; Yarn 1 exits a severity bitmask), so
        // runCommand's recovered exit code is deliberately ignored and only the
        // document shape decides. stderr is captured too: Yarn's JSON reporter
        // puts its error events there.
        async (command, args) => {
          // osv-scanner inlines a full OSV record per advisory -- every affected version string,
          // every range -- so one package with two advisory groups already prints ~20 KB. The
          // shared 10 MB default is reached by a few hundred vulnerable packages, and an overrun
          // rejects with no numeric exit code, which classifies `transient-failure` -> a
          // MERGE-BLOCKING unjudged that a retry can never clear, because the overrun is
          // deterministic. A bigger budget for the one tool whose output scales with the finding
          // count, not for the audits that print a summary.
          // Both budgets are raised for osv-scanner alone, for the same reason: an overrun
          // REJECTS with no numeric exit code, which classifies `transient-failure` -> a
          // merge-blocking `unjudged` that the retry lane can never clear, because the overrun is
          // deterministic. Output scales with the finding count (each OSV record inlines every
          // affected version, so one package with two advisory groups is already ~20 KB), and
          // wall time scales with tree size, since `--recursive` walks the whole checkout and
          // resolves transitive manifests over the network. The npm/Yarn audits print a summary
          // and talk to one endpoint, so they keep the shared defaults.
          const opts =
            command === AUDIT_COMMANDS.osv
              ? { maxBuffer: 128 * 1024 * 1024, timeoutMs: 25 * 60 * 1000 }
              : {};
          const { stdout, stderr, exitCode } = await runCommand(command, args, root, opts);
          return { stdout, stderr, exitCode };
        },
      );
    },
  };
}

export function createCveGate(auditor: DependencyAuditor = createDependencyAuditor()): Gate {
  return {
    id: 'cve',
    async run(ctx: GateContext): Promise<GateResult> {
      const config = readGateConfig(ctx.config, 'cve', DEFAULT_CONFIG);

      // readGateConfig is a bare spread with no validation, so `minSeverity` is
      // whatever the tenant typed. An unrecognised value used to rank as
      // `undefined`, and `3 >= undefined` is false -- a one-character typo
      // ("High", "severe") silently disabled the whole gate while it kept
      // reporting pass. A threshold nobody can rank is a could-not-determine.
      const threshold = SEVERITY_RANK.get(config.minSeverity);
      if (threshold === undefined) {
        return unjudgedResult(
          'content',
          `cve gate misconfigured: \`minSeverity\` is ${JSON.stringify(config.minSeverity)}, which is not one of ` +
            `${[...SEVERITY_RANK.keys()].join(', ')}. No advisory can be ranked against it, so nothing was judged.`,
        );
      }

      const outcome = await auditor.audit(ctx.workspaceRoot);

      // Nothing to audit is a `skip` with a reason, never a pass: `no-config`
      // keeps a perpetual skip visible to the promotion record instead of
      // banking it as coverage.
      if (outcome.kind === 'not-applicable') {
        return { id: 'cve', status: 'skip', skipReason: 'no-config' satisfies SkipReason, findings: [outcome.reason] };
      }


      if (outcome.kind === 'inconclusive') {
        // The operator's escape hatch, and only for the two classes that are statements about
        // the ENVIRONMENT rather than about a check that broke -- `repo-shape` (this repo's
        // dependency layout cannot be audited) and `tooling-missing` (this runner has no scanner
        // for it). See CveGateConfig.blocking. A report-only `warn` still carries the finding into
        // the PR comment; it just does not wedge the tenant.
        // Newly covered trees are report-only until a tenant has evidence provisioning works --
        // see CveGateConfig.blocking. An explicit `cve.blocking` always wins, in both directions.
        const reportOnly =
          config.blocking === false ||
          (outcome.newCoverage === true && !blockingWasSetExplicitly(ctx.config));
        if ((outcome.cause === 'repo-shape' || outcome.cause === 'tooling-missing') && reportOnly) {
          return {
            id: 'cve',
            status: 'warn',
            findings: [
              `${outcome.reason} ${
                config.blocking === false
                  ? '(report-only: `cve.blocking` is false for this repo)'
                  : '(report-only: this repo\'s dependency tree is newly covered by this gate, so an audit that ' +
                    'cannot run reports rather than blocks until provisioning is proven here. Set ' +
                    '`cve.blocking: true` for this repo once one osv-scanner run has produced a real verdict.)'
              }`,
            ],
          };
        }
        // `infra` earns the bounded gate-only retry; everything else escalates at once.
        // `tooling-missing` is deliberately `content`: no number of re-runs installs a binary, so
        // spending the retry budget on it only delays telling a human that provisioning is broken.
        return unjudgedResult(outcome.cause === 'transient-failure' ? 'infra' : 'content', outcome.reason);
      }

      const findings = outcome.advisories
        // `rank === undefined` must NEVER read as "below threshold". The npm/Yarn parsers reject
        // an unrankable severity outright, so for those a value reaching here slipped through
        // some future path; osv-scanner reaches it legitimately, with `'unknown'` for an advisory
        // whose OSV record carries no CVSS score. Either way the safe direction for a security
        // finding this gate cannot rank is to REPORT it, not drop it.
        .filter((advisory) => {
          const rank = rankOf(advisory.severity);
          return rank === undefined || rank >= threshold;
        })
        .map((advisory) => `${advisory.id}: ${advisory.packageName} (${advisory.severity}) — ${advisory.title}`);

      return {
        id: 'cve',
        status: findings.length > 0 ? 'fail' : 'pass',
        ...(findings.length ? { findings } : {}),
      };
    },
  };
}

// An audit that reached no verdict is `unjudged`, never `pass` and never a silent
// `skip`: aggregation blocks the merge on it, and the reason routes what happens
// next -- `infra` earns a bounded gate-only retry, `content` goes straight to a
// human (fix-loop.ts). Either way `cve` is non-revertable there, so no fixer is
// ever handed code it cannot change.
function unjudgedResult(unjudgedReason: 'infra' | 'content', reason: string): GateResult {
  return { id: 'cve', status: 'unjudged', unjudgedReason, findings: [reason] };
}
