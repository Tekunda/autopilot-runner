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
import { readGateConfig } from './config.ts';
import type { Gate, GateContext, GateResult, SkipReason } from '../types.ts';

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

// Maps, NOT object literals. `SEVERITY_ALIASES['constructor']` on a literal
// returns Object's own constructor -- truthy, not a Severity -- and the advisory
// carrying it then ranks `undefined`, compares false against every threshold,
// and disappears from the findings. A blocking security gate must not have a
// lookup that answers questions nobody asked. (`__proto__` is the same hole;
// `.toLowerCase()` was only accidentally covering `toString`.)
const SEVERITY_ALIASES: ReadonlyMap<string, Severity> = new Map([
  // `info` is the fifth level npm and Yarn 1 both emit; it ranks below `low`.
  ['info', 'low'],
  ['low', 'low'],
  ['moderate', 'moderate'],
  ['high', 'high'],
  ['critical', 'critical'],
] as const);

const SEVERITY_RANK: ReadonlyMap<Severity, number> = new Map([
  ['low', 0],
  ['moderate', 1],
  ['high', 2],
  ['critical', 3],
] as const);

export interface DependencyAdvisory {
  packageName: string;
  severity: Severity;
  id: string;
  title: string;
}

// WHY an audit reached no verdict. It drives two decisions, so it is data on the
// outcome rather than prose inside `reason`:
//   'repo-shape'        -- decided BEFORE anything ran: unsupported/undetectable
//                          package manager, no lockfile, conflicting lockfiles.
//                          Deterministic (`content`), and the only class an
//                          operator may demote with `cve.blocking: false`,
//                          because it is a statement about the repo, not about a
//                          failed check.
//   'no-verdict'        -- the tool RAN and produced something unusable: an
//                          error document, an unreadable report, a severity that
//                          cannot be ranked, a bad `minSeverity`. Deterministic
//                          (`content`), never demotable.
//   'transient-failure' -- the tool could not run or could not reach the
//                          advisory registry (spawn error, timeout, ECONNREFUSED,
//                          5xx). A re-run may succeed, so this is `infra` and
//                          gets that lane's bounded retry. Never demotable.
export type InconclusiveCause = 'repo-shape' | 'no-verdict' | 'transient-failure';

// The audit's outcome. The three cases are the whole point of this type: an
// audit that could not be performed is structurally impossible to mistake for
// `{ kind: 'advisories', advisories: [] }` (a clean tree), and a tree with
// nothing to audit is a third thing again. `reason` is human-facing -- it lands
// in the gate's findings, so it must say what could not be determined AND what a
// human should do about it.
export type AuditOutcome =
  | { kind: 'advisories'; advisories: DependencyAdvisory[] }
  | { kind: 'not-applicable'; reason: string }
  | { kind: 'inconclusive'; cause: InconclusiveCause; reason: string };

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
  blocking: boolean;
}

const DEFAULT_CONFIG: CveGateConfig = { minSeverity: 'high', blocking: true };

const AUDIT_REGISTRY = 'https://registry.npmjs.org/';

function inconclusive(cause: InconclusiveCause, reason: string): AuditOutcome {
  return { kind: 'inconclusive', cause, reason };
}

// Registry/network/runtime faults, as they appear in npm's error document, in
// Yarn's `error` event, and in whatever a dying tool leaves on its streams.
// Matched against the tool's own diagnostic text, never against a whole report --
// an advisory TITLE could otherwise nominate itself as infra.
//
// A bare three-digit number is NOT a fault signal: `Unexpected token at line 523`
// and `exited with code 512` are not 5xx responses. The HTTP alternatives here
// each require a status word or a reason phrase next to the number; npm's own
// `E503` and `registry returned 503` forms are matched by their own branches.
const TRANSIENT_FAULT =
  /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ESOCKETTIMEDOUT|EAI_AGAIN|ENETUNREACH|ENOTFOUND|EHOSTUNREACH|EPIPE|EMFILE|ENFILE|ENOMEM|EAGAIN|EBUSY|socket hang up|request to \S+ failed|registry returned (5\d\d|429)|\bE(5\d\d|429)\b|(?:HTTP|status)\W{0,4}5\d\d|\b5\d\d (?:Service Unavailable|Bad Gateway|Gateway Time|Internal Server Error)|rate limit|SIGKILL|SIGTERM|\bKilled\b|heap out of memory|out of memory/i;

function classifyToolDiagnostic(text: string): InconclusiveCause {
  // A tool that printed NOTHING at all did not run: no report, no complaint, not
  // even a parse error to read. That is infrastructure (an OOM-killed child, a
  // wedged runner), not a verdict about the repo, so it takes the retry lane
  // rather than escalating a human who has nothing to look at.
  if (text.trim() === '') return 'transient-failure';
  return TRANSIENT_FAULT.test(text) ? 'transient-failure' : 'no-verdict';
}

// ---------------------------------------------------------------------------
// Which audit tool does this tree need?
// ---------------------------------------------------------------------------

export type AuditTool = 'npm' | 'yarn-classic';

export type AuditPlan =
  | { kind: 'run'; tool: AuditTool; command: string; args: string[] }
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
  return tool === 'npm'
    ? ['audit', '--json', `--registry=${AUDIT_REGISTRY}`, '--userconfig=/dev/null']
    : ['--no-default-rc', 'audit', '--json'];
}

function runPlan(tool: AuditTool): AuditPlan {
  return { kind: 'run', tool, command: tool === 'npm' ? 'npm' : 'yarn', args: auditArgsFor(tool) };
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
export function planDependencyAudit(readFile: ReadWorkspaceFile): AuditPlan {
  const packageJson = readFile('package.json');
  const hasNpmLock = NPM_LOCKFILES.some((name) => readFile(name) !== undefined);
  const yarnLock = readFile('yarn.lock');
  const hasPnpmLock = readFile('pnpm-lock.yaml') !== undefined;

  // Nothing to audit, as opposed to "could not audit": no Node manifest and no
  // lockfile at all (a Python/Go/Terraform/docs repo). `skip`/`no-config` keeps
  // it distinguishable from a pass without wedging a tenant that has no
  // JavaScript dependencies to have vulnerabilities in.
  if (packageJson === undefined && !hasNpmLock && yarnLock === undefined && !hasPnpmLock) {
    return {
      kind: 'not-applicable',
      reason:
        'no dependency audit to run: the PR checkout has no package.json and no npm/Yarn/pnpm lockfile, ' +
        'so there is no JavaScript dependency tree to audit.',
    };
  }

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

// Yarn 2+ deliberately unsupported rather than guessed: `yarn npm audit --json`
// emits a different document than the two formats parsed below, and this gate has
// no Berry tenant to verify a parser against. Reporting "could not determine"
// blocks (or, with `cve.blocking: false`, warns); guessing a parser would risk
// reading an unrecognised document as zero advisories, which is the bug this file
// was written to end.
function berryUnsupported(major: number): AuditPlan {
  return shapeProblem(
    `dependency audit not run: this repo uses Yarn ${major || '2+'} (Berry), whose \`yarn npm audit --json\` ` +
      'output this gate does not parse yet. It is reported as unjudged rather than passed, because an ' +
      'unparsed audit is not a clean audit. Set `cve.blocking: false` for this repo to demote it to a warning ' +
      'until a Berry parser exists.',
  );
}

function pnpmUnsupported(): AuditPlan {
  return shapeProblem(
    'dependency audit not run: this repo uses pnpm, which this gate does not support yet. It is reported ' +
      'as unjudged rather than passed, because an audit that never ran is not a clean audit. Set ' +
      '`cve.blocking: false` for this repo to demote it to a warning until pnpm is supported.',
  );
}

// `detectYarnMajor` (only reached when there is no `packageManager` pin, which
// planDependencyAudit consults first) and `readPackageManagerPin` moved to
// ../stack-profile.ts, imported above -- they were duplicated verbatim in
// runner/corepack-guard.ts, and the same two facts are what a Python/Salesforce
// tenant needs answered too. Their rules and their rationale travelled with them.

// ---------------------------------------------------------------------------
// Output parsing -- one parser per tool, both pure.
// ---------------------------------------------------------------------------

interface NpmAuditVia {
  title?: string;
  url?: string;
  severity?: unknown;
}

interface NpmAuditVulnerability {
  severity?: unknown;
  via?: (string | NpmAuditVia)[];
}

interface NpmAuditReport {
  // npm reports its own failures IN the JSON document, and puts the useful text
  // in different places depending on the fault: ENOLOCK fills `error.code` and
  // `error.summary`, while a registry failure leaves BOTH empty and puts the
  // cause in top-level `message` ("request to https://.../bulk failed, reason:
  // connect ECONNREFUSED"). Reading only `error.code` produced the useless
  // diagnostic "npm audit could not run (unknown)" on the most likely real-world
  // failure, so both are read.
  error?: { code?: unknown; summary?: unknown; detail?: unknown };
  message?: unknown;
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
}

// `npm audit --json` (npm 7+). Exit code is NOT consulted: npm exits non-zero
// both when it found vulnerabilities (report on stdout, a real verdict) and when
// it could not audit at all (error document on stdout, no verdict). Only the
// SHAPE of the document separates those two, which is the whole lesson of the
// ENOLOCK bug. A `via` entry that is a plain string names a transitive
// dependency, not an advisory, so it is skipped.
export function parseNpmAuditOutput(stdout: string, stderr = ''): AuditOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const text = `${stdout}\n${stderr}`;
    return inconclusive(
      classifyToolDiagnostic(text),
      '`npm audit --json` did not print a JSON report, so the dependency tree was never audited. ' +
        `Output began: ${preview(text)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return inconclusive('no-verdict', `\`npm audit --json\` printed a non-object JSON document: ${preview(stdout)}`);
  }

  const report = parsed as NpmAuditReport;
  const diagnostic = npmErrorDiagnostic(report, stdout);
  if (diagnostic !== undefined) {
    return inconclusive(
      classifyToolDiagnostic(diagnostic),
      `npm audit could not run (${diagnostic}), so the dependency tree was never audited. This is ` +
        'reported as unjudged, not passed.',
    );
  }

  const vulnerabilities = report.vulnerabilities;
  // PRESENT AND EMPTY is the clean case and must pass. ABSENT means npm printed
  // something that is not an npm 7+ audit report (an npm 6 `advisories` document,
  // a truncated write, a future schema) -- no verdict either way.
  if (typeof vulnerabilities !== 'object' || vulnerabilities === null || Array.isArray(vulnerabilities)) {
    return inconclusive(
      'no-verdict',
      '`npm audit --json` printed a document with no `vulnerabilities` key, so no audit result could be ' +
        `read from it: ${preview(stdout)}`,
    );
  }

  const advisories: DependencyAdvisory[] = [];
  for (const [packageName, vuln] of Object.entries(vulnerabilities)) {
    for (const via of vuln.via ?? []) {
      if (typeof via === 'string') continue;
      const raw = via.severity ?? vuln.severity;
      const severity = rankableSeverity(raw);
      if (!severity) return unrankableSeverity(packageName, raw);
      advisories.push({
        packageName,
        severity,
        id: typeof via.url === 'string' ? via.url : `${packageName}@${severity}`,
        title: typeof via.title === 'string' ? via.title : `${packageName} dependency vulnerability`,
      });
    }
  }
  return { kind: 'advisories', advisories };
}

// The text npm gave us about its own failure, or undefined when the document is
// not an error document at all. An `error` object present but entirely empty
// still means failure, so it falls back to the raw document rather than claiming
// "unknown".
function npmErrorDiagnostic(report: NpmAuditReport, stdout: string): string | undefined {
  const parts: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim() !== '') parts.push(value.trim());
  };
  push(report.error?.code);
  push(report.error?.summary);
  push(report.error?.detail);
  push(report.message);
  if (parts.length > 0) return parts.join(': ');
  if (report.error !== undefined && report.error !== null) return preview(stdout);
  return undefined;
}

interface YarnClassicAdvisory {
  id?: unknown;
  module_name?: unknown;
  severity?: unknown;
  title?: unknown;
  url?: unknown;
}

// Yarn 1 `yarn audit --json`: NDJSON, one JSON object per LINE, so
// `JSON.parse(stdout)` over the whole stream throws. Its exit code is a BITMASK
// of the severities it found (1 info | 2 low | 4 moderate | 8 high | 16 critical,
// summed), so a non-zero exit is not evidence of failure and a zero exit is not
// evidence the audit ran -- only the `auditSummary` line proves completion. Yarn
// prints that line on a clean audit too (verified against a real Yarn 1.22.22
// run), which is what makes its ABSENCE a usable could-not-determine signal.
//
// `stderr` matters: Yarn's JSON reporter writes its `warning` AND `error` events
// there, not to stdout, so the cause of a failed audit ("Error: connect
// ECONNREFUSED") is only ever on that stream. It is consulted only when stdout
// produced no summary -- a COMPLETED audit is not invalidated by a stray warning.
export function parseYarnClassicAuditOutput(stdout: string, stderr = ''): AuditOutcome {
  const advisories: DependencyAdvisory[] = [];
  let sawSummary = false;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      // Strict on purpose: a line we cannot read may BE an advisory (a truncated
      // stream, an interleaved writer). Skipping it would under-report, and
      // under-reporting a security audit is the failure mode of this whole file.
      return inconclusive(
        classifyToolDiagnostic(trimmed),
        `\`yarn audit --json\` printed a line that is not JSON, so its output could not be read in full: ${preview(trimmed)}`,
      );
    }
    // Same rule, same reason: `42`, `"text"` and `null` are readable JSON but not
    // events, so they are just as unreadable as a broken line. `continue` here
    // would be the under-reporting the branch above refuses.
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      return inconclusive(
        'no-verdict',
        `\`yarn audit --json\` printed a JSON line that is not an event object, so its output could not be ` +
          `read in full: ${preview(trimmed)}`,
      );
    }
    const { type, data } = event as { type?: unknown; data?: unknown };

    if (type === 'auditSummary') {
      sawSummary = true;
      continue;
    }
    if (type === 'error') return yarnErrorOutcome(data);
    if (type !== 'auditAdvisory') continue;

    const advisory = (data as { advisory?: YarnClassicAdvisory } | undefined)?.advisory;
    if (!advisory || typeof advisory !== 'object') {
      return inconclusive('no-verdict', '`yarn audit --json` printed an auditAdvisory line with no advisory payload.');
    }
    const packageName = typeof advisory.module_name === 'string' ? advisory.module_name : 'unknown package';
    const severity = rankableSeverity(advisory.severity);
    if (!severity) return unrankableSeverity(packageName, advisory.severity);
    advisories.push({
      packageName,
      severity,
      id:
        typeof advisory.url === 'string'
          ? advisory.url
          : advisory.id !== undefined
            ? `yarn-audit-${String(advisory.id)}`
            : `${packageName}@${severity}`,
      title: typeof advisory.title === 'string' ? advisory.title : `${packageName} dependency vulnerability`,
    });
  }

  if (!sawSummary) {
    const failure = firstYarnErrorEvent(stderr);
    if (failure !== undefined) return yarnErrorOutcome(failure);
    // Classified, not assumed -- the npm path already does this. A yarn run that
    // died on a proxy 503, an ETIMEDOUT, a plain-text node crash, or an OOM kill
    // leaves no JSON `error` event to find, and hard-coding `no-verdict` here gave
    // every one of those zero retries and an immediate human escalation.
    const diagnostics = `${stdout}\n${stderr}`;
    return inconclusive(
      classifyToolDiagnostic(diagnostics),
      '`yarn audit --json` printed no `auditSummary` line, so the audit did not complete and its result ' +
        `cannot be read as clean.${diagnostics.trim() ? ` Diagnostics: ${preview(diagnostics)}` : ''}`,
    );
  }
  return { kind: 'advisories', advisories };
}

function yarnErrorOutcome(data: unknown): AuditOutcome {
  const text = typeof data === 'string' ? data : JSON.stringify(data ?? null);
  return inconclusive(
    classifyToolDiagnostic(text),
    `yarn audit reported an error instead of a result (${preview(text)}), so the dependency tree was never audited.`,
  );
}

function firstYarnErrorEvent(stderr: string): unknown {
  for (const line of stderr.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof event === 'object' && event !== null && (event as { type?: unknown }).type === 'error') {
      return (event as { data?: unknown }).data;
    }
  }
  return undefined;
}

// npm audits the LOCKFILE's virtual tree, so a lockfile that resolves to nothing
// (`{"packages":{}}` -- what one interrupted or hand-edited `npm install` leaves
// behind) produces a legitimately clean `"vulnerabilities":{}` for a manifest full
// of criticals. Nothing in the report shape says "this is wrong"; the count does.
// Verified against real npm 11 output: the stale tree reports
// `metadata.dependencies.total: 0` while the healthy one reports 1. Paired with
// "the manifest declares dependencies", that is unambiguous -- a repo with no
// declared dependencies legitimately audits an empty tree and is left alone.
// Returns the reason to report, or undefined when the report is trustworthy.
export function detectEmptyAuditedTree(stdout: string, packageJsonRaw: string | undefined): string | undefined {
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const total = (report as { metadata?: { dependencies?: { total?: unknown } } })?.metadata?.dependencies?.total;
  if (total !== 0) return undefined;
  const declared = declaredDependencyCount(packageJsonRaw);
  if (declared === 0) return undefined;
  return (
    `dependency audit not trusted: npm audited an EMPTY dependency tree (\`metadata.dependencies.total\` is 0) ` +
    `while package.json declares ${declared} dependenc${declared === 1 ? 'y' : 'ies'}. The lockfile does not ` +
    'describe the tree this repo installs, so its clean result means nothing. Regenerate the lockfile.'
  );
}

function declaredDependencyCount(packageJsonRaw: string | undefined): number {
  if (!packageJsonRaw) return 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageJsonRaw);
  } catch {
    return 0;
  }
  if (typeof parsed !== 'object' || parsed === null) return 0;
  const manifest = parsed as Record<string, unknown>;
  let count = 0;
  // EVERY field npm installs into the tree it audits, `peerDependencies`
  // included -- npm 7+ installs peers, and a real npm 11 report for a
  // peers-only manifest shows `dependencies.peer: 1` on a healthy lockfile and
  // `0` on a stale one, which is exactly the staleness signal this guard exists
  // to read. Omitting the field made the guard no-op for a peers-only manifest,
  // so a stale lockfile hiding a CRITICAL advisory scored `declared === 0` and
  // was trusted. A missing entry here is a false PASS, not a false alarm.
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    const block = manifest[field];
    if (typeof block === 'object' && block !== null && !Array.isArray(block)) count += Object.keys(block).length;
  }
  return count;
}

export function parseAuditOutput(tool: AuditTool, stdout: string, stderr = ''): AuditOutcome {
  return tool === 'npm' ? parseNpmAuditOutput(stdout, stderr) : parseYarnClassicAuditOutput(stdout, stderr);
}

// `typeof raw !== 'string'` first: a report carrying `"severity": null` (or a
// number, or an object) would otherwise throw out of `.toLowerCase()` and escape
// this file's three-state contract entirely, landing in runGates' generic catch
// as a bare `fail` with a raw JS message. Failing safe by luck is not failing
// safe by design.
function rankableSeverity(raw: unknown): Severity | undefined {
  if (typeof raw !== 'string') return undefined;
  return SEVERITY_ALIASES.get(raw.toLowerCase());
}

function unrankableSeverity(packageName: string, raw: unknown): AuditOutcome {
  const shown = typeof raw === 'string' ? `"${raw}"` : raw === undefined ? '(none)' : JSON.stringify(raw ?? null);
  return inconclusive(
    'no-verdict',
    `the audit reported severity ${shown} for \`${packageName}\`, which this gate cannot rank against its ` +
      'threshold, so the report cannot be judged.',
  );
}

function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}...` : collapsed || '(no output)';
}

// ---------------------------------------------------------------------------
// The real auditor.
// ---------------------------------------------------------------------------

export interface AuditCommandOutput {
  stdout: string;
  stderr: string;
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
    // Spawn failure, timeout, or a maxBuffer overrun -- the tool never delivered
    // a report. A re-run may well succeed (a wedged runner, a slow registry), so
    // this is the `infra` lane's bounded retry, not an instant escalation.
    return inconclusive(
      'transient-failure',
      `\`${invocation}\` could not be run (${errorText(error)}), so no dependency audit result exists for this PR.`,
    );
  }
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
          const { stdout, stderr } = await runCommand(command, args, root);
          return { stdout, stderr };
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
        // The operator's one escape hatch, and only for the repo-shape class --
        // see CveGateConfig.blocking. A report-only `warn` still carries the
        // finding into the PR comment; it just does not wedge the tenant.
        if (outcome.cause === 'repo-shape' && config.blocking === false) {
          return {
            id: 'cve',
            status: 'warn',
            findings: [`${outcome.reason} (report-only: \`cve.blocking\` is false for this repo)`],
          };
        }
        return unjudgedResult(outcome.cause === 'transient-failure' ? 'infra' : 'content', outcome.reason);
      }

      const findings = outcome.advisories
        // `rank === undefined` must NEVER read as "below threshold". Parsing
        // already rejects an unrankable severity, so reaching this branch means a
        // value slipped through some future path -- and the safe direction for a
        // security finding it cannot rank is to REPORT it, not drop it.
        .filter((advisory) => {
          const rank = SEVERITY_RANK.get(advisory.severity);
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
