// osv-scanner: the non-JavaScript half of the `cve` gate.
//
// `npm audit` and `yarn audit` are the only tools ./cve.ts had, so every Python, Go, Rust, Ruby,
// Java, PHP and .NET tenant -- and every POLYGLOT repo, where npm audited half the tree and the
// gate reported a clean pass over the other half -- went unaudited. osv-scanner reads all of
// them, and npm/Yarn/pnpm too, from one pass over the checkout.
//
// This module is PURE PARSING plus the argv it is invoked with. It knows nothing about planning,
// spawning, thresholds or gate results -- ./cve.ts owns all of that, which is what keeps the
// dependency one-way (cve.ts -> osv-scanner.ts -> audit-outcome.ts) and every branch below
// testable from a string literal.
//
// THE RULE IT INHERITS: no verdict is never a pass. Every shape this file cannot read with
// certainty returns `inconclusive`, never `{ advisories: [] }`.

import {
  classifyToolDiagnostic,
  inconclusive,
  preview,
  type AdvisorySeverity,
  type AuditOutcome,
  type DependencyAdvisory,
} from './audit-outcome.ts';

//   osv : the advisory source is not repo-configurable at all (it is the OSV database, reached
//         through deps.dev), so there is no `--registry` analogue to pin. What the TREE can
//         still do is silence findings: an `osv-scanner.toml` committed by the branch under
//         review carries `[[IgnoredVulns]]`, and osv-scanner honours it by default -- a PR that
//         introduces a critical could ship the ignore rule for it in the same commit.
//         `--config /dev/null` overrides that file with an empty one, the direct analogue of
//         npm's `--userconfig=/dev/null`. `--no-call-analysis` is NOT belt and braces:
//         v2.5.1's `stableCallAnalysisStates` is `{go: true, rust: false, jar: false}`, so GO
//         CALL ANALYSIS IS ON BY DEFAULT and this flag actually turns something off. Call
//         analysis builds and inspects the audited tree's OWN code -- Rust's mode runs its build
//         scripts outright -- which a security gate must never do to the untrusted branch it is
//         judging. All three languages are named so a future default flip changes nothing here.
//         `--allow-no-lockfiles` is what makes "found nothing" a readable JSON document
//         (`"results": null`) instead of an empty stdout and exit 128 -- see
//         parseOsvScannerOutput for why that distinction is the whole audit. And `--all-vulns`
//         because the DEFAULT filter hides advisories osv-scanner judges "unimportant" (notably
//         distro-tagged OS packages): a gate whose entire thesis is that under-reporting is the
//         failure mode does not get to let the tool decide what is worth mentioning. The
//         "uncalled" half of that default is already handled by refusing call analysis.
export const OSV_ARGS = [
  'scan',
  'source',
  '--format',
  'json',
  '--recursive',
  '--config',
  '/dev/null',
  '--allow-no-lockfiles',
  '--all-vulns',
  '--no-call-analysis',
  'go',
  '--no-call-analysis',
  'rust',
  '--no-call-analysis',
  'jar',
  '.',
];


// The root manifests that prove a dependency tree npm and Yarn cannot read. Deliberately BROADER
// than gates/stack-profile.ts's ecosystems (node/python/salesforce): that detector answers "what
// toolchain is this repo", while this list answers "is there something here osv-scanner can audit
// that npm/Yarn cannot", and osv-scanner covers Go, Rust, Ruby, PHP, Java, .NET and Dart too.
// Root-level only, matching how the JS lockfiles are looked for -- a monorepo hiding its manifests
// under packages/* is the same unresolved case for both halves, and guessing at depth here would
// make a `--recursive` scan of a huge tree the default on repos that did not ask for it.
export const NON_JS_MANIFESTS = [
  'requirements.txt',
  'pyproject.toml',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'go.mod',
  'Cargo.lock',
  'Gemfile.lock',
  'composer.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'mix.lock',
  'pubspec.lock',
  'packages.lock.json',
];



interface OsvGroup {
  ids?: unknown;
  aliases?: unknown;
  max_severity?: unknown;
}

interface OsvVulnerability {
  id?: unknown;
  summary?: unknown;
}

interface OsvPackageResult {
  package?: { name?: unknown; version?: unknown; ecosystem?: unknown };
  groups?: unknown;
  vulnerabilities?: unknown;
}

interface OsvSourceResult {
  source?: { path?: unknown; type?: unknown };
  packages?: unknown;
}

// The CVSS v3.1 qualitative rating scale (the bands NVD itself publishes), mapped onto the four
// severity words this gate already ranks. osv-scanner's `max_severity` is the highest CVSS base
// score across the advisories it grouped together, as a decimal STRING ("8.6", "5.4").
//
// Two edges worth stating. A score of exactly 0.0 is CVSS "None", but an advisory that matched
// the installed version is still an advisory, so it lands in `low` -- the lowest thing this gate
// can rank -- rather than vanishing. And ANYTHING unreadable (empty string, absent key, a
// non-numeric or out-of-range value) is `unknown`, which the threshold filter always reports:
// see AdvisorySeverity for why that is the only safe direction.
export function severityForCvssScore(raw: unknown): AdvisorySeverity {
  if (typeof raw !== 'string' || raw.trim() === '') return 'unknown';
  const score = Number(raw.trim());
  if (!Number.isFinite(score) || score < 0 || score > 10) return 'unknown';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'moderate';
  return 'low';
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((entry) => typeof entry === 'string') ? (value as string[]) : undefined;
}

// `osv-scanner scan source --format json`. The document's own "did the audit happen" signal is
// the `results` key, and it has THREE readings that must never be collapsed -- the same lesson as
// npm's `vulnerabilities` present-and-empty vs absent, verified against osv-scanner 2.5.1:
//
//   "results": []    package sources WERE found and audited, and nothing matched. CLEAN. Passes.
//   "results": null  no package source was found at all (what `--allow-no-lockfiles` prints
//                    instead of exiting 128 with an empty stdout). NOTHING TO AUDIT, which is a
//                    `not-applicable` skip, never a pass.
//   absent / other   this is not an osv-scanner report -- a future schema, a truncated write, a
//                    usage error printed as JSON. NO VERDICT either way.
//
// Exit code is not consulted, for the same reason it is not consulted for npm: osv-scanner exits
// 1 both when it found vulnerabilities (a real verdict) and 128 when it found no source at all.
// Only the document's shape separates those.
//
// Advisories come from `groups`, not from `vulnerabilities`: osv-scanner has already deduplicated
// aliases there (one PYSEC + its GHSA are ONE group), and `max_severity` is the only place it
// publishes a comparable score. `vulnerabilities` is read solely for the human-readable summary.
// Each helper below answers ONE question and returns either its answer or the `inconclusive` that
// ends the parse. Splitting it up is not cosmetic: the single function this replaced branched
// thirty-seven ways, and a security parser whose job is to never mistake an unreadable document
// for a clean one has to be checkable by reading it.

// `null` (nothing to audit), an array (a real result set), or anything else (not an osv-scanner
// report). Returns the array, or the outcome that ends the parse.
function readResults(parsed: object, stdout: string): OsvSourceResult[] | AuditOutcome {
  const results = (parsed as { results?: unknown }).results;
  if (results === null) {
    return {
      kind: 'not-applicable',
      reason:
        'no dependency audit to run: osv-scanner found no package source in the PR checkout (no lockfile ' +
        'or manifest it recognises), so there is no dependency tree to audit.',
    };
  }
  if (!Array.isArray(results)) {
    return inconclusive(
      'no-verdict',
      '`osv-scanner` printed a document with no `results` array, so no audit result could be read from ' +
        `it: ${preview(stdout)}`,
    );
  }
  return results as OsvSourceResult[];
}

// id -> summary, for the finding text. Absent for most PYSEC records (their `summary` is ""),
// which is why the caller falls back to naming the aliases rather than pretending to a title.
function summariesOf(pkg: OsvPackageResult): Map<string, string> {
  const summaries = new Map<string, string>();
  if (!Array.isArray(pkg.vulnerabilities)) return summaries;
  for (const vuln of pkg.vulnerabilities as OsvVulnerability[]) {
    if (typeof vuln?.id === 'string' && typeof vuln.summary === 'string' && vuln.summary.trim() !== '') {
      summaries.set(vuln.id, vuln.summary.trim());
    }
  }
  return summaries;
}

// `groups` is `omitempty` in the OSV output schema, so an ABSENT key is legal and means "no
// advisory groups for this package". Hard-failing it would turn a legal document into a permanent
// merge block the day an upstream default changes. A `groups` key that is PRESENT and not an
// array is still an unreadable document, and advisories with no grouping to rank them still
// cannot be judged -- under-reporting is the failure mode this file exists to prevent, so both of
// those stay a no-verdict.
function readGroups(pkg: OsvPackageResult, stdout: string): OsvGroup[] | AuditOutcome {
  const rawGroups = pkg.groups ?? [];
  if (!Array.isArray(rawGroups)) {
    return inconclusive(
      'no-verdict',
      '`osv-scanner` reported a `groups` value that is not an array, so its findings could not be ' +
        `read: ${preview(stdout)}`,
    );
  }
  if (rawGroups.length === 0 && Array.isArray(pkg.vulnerabilities) && pkg.vulnerabilities.length > 0) {
    return inconclusive(
      'no-verdict',
      `\`osv-scanner\` reported vulnerabilities for \`${
        typeof pkg.package?.name === 'string' ? pkg.package.name : 'a package'
      }\` with no advisory groups, so they could not be ranked against the severity threshold: ${preview(stdout)}`,
    );
  }
  return rawGroups as OsvGroup[];
}

// One deduplicated advisory group -> one reported advisory. osv-scanner has already collapsed
// aliases here (one PYSEC and its GHSA are ONE group), and `max_severity` is the only place it
// publishes a comparable score.
function advisoryForGroup(
  group: OsvGroup,
  packageName: string,
  summaries: Map<string, string>,
): DependencyAdvisory | AuditOutcome {
  const ids = asStringArray(group?.ids);
  if (!ids || ids.length === 0) {
    return inconclusive(
      'no-verdict',
      `\`osv-scanner\` reported an advisory group for \`${packageName}\` with no ids, so it could not be ` +
        'attributed to a vulnerability.',
    );
  }
  const aliases = asStringArray(group.aliases) ?? [];
  const title =
    ids.map((id) => summaries.get(id)).find((summary) => summary !== undefined) ??
    // No summary anywhere in the record. Name what IS known -- the aliases, which is where the
    // CVE id lives -- rather than inventing a description of a vulnerability nobody here has read.
    (aliases.length > 0 ? `advisory aliases: ${aliases.join(', ')}` : `${packageName} dependency vulnerability`);
  return { packageName, severity: severityForCvssScore(group.max_severity), id: ids[0]!, title };
}

function isOutcome(value: unknown): value is AuditOutcome {
  return typeof value === 'object' && value !== null && 'kind' in value;
}

// Every advisory one package contributes, or the outcome that ends the parse.
function advisoriesForPackage(pkg: OsvPackageResult, stdout: string): DependencyAdvisory[] | AuditOutcome {
  if (typeof pkg !== 'object' || pkg === null) {
    return inconclusive('no-verdict', `\`osv-scanner\` printed a \`packages\` entry that is not an object: ${preview(stdout)}`);
  }
  const groups = readGroups(pkg, stdout);
  if (isOutcome(groups)) return groups;

  const packageName = typeof pkg.package?.name === 'string' ? pkg.package.name : 'unknown package';
  const summaries = summariesOf(pkg);
  const advisories: DependencyAdvisory[] = [];
  for (const group of groups) {
    const advisory = advisoryForGroup(group, packageName, summaries);
    if (isOutcome(advisory)) return advisory;
    advisories.push(advisory);
  }
  return advisories;
}

// Every advisory one scanned SOURCE (one lockfile/manifest) contributes.
function advisoriesForSource(entry: OsvSourceResult, stdout: string): DependencyAdvisory[] | AuditOutcome {
  if (typeof entry !== 'object' || entry === null) {
    return inconclusive('no-verdict', `\`osv-scanner\` printed a \`results\` entry that is not an object: ${preview(stdout)}`);
  }
  // A source with no `packages` array is not something this parser recognises. Skipping it would
  // under-report, which for a security audit is the one direction that must never be guessed at.
  if (!Array.isArray(entry.packages)) {
    return inconclusive(
      'no-verdict',
      `\`osv-scanner\` reported a source with no \`packages\` array, so its findings could not be read: ${preview(stdout)}`,
    );
  }
  const advisories: DependencyAdvisory[] = [];
  for (const pkg of entry.packages as OsvPackageResult[]) {
    const found = advisoriesForPackage(pkg, stdout);
    if (isOutcome(found)) return found;
    advisories.push(...found);
  }
  return advisories;
}

export function parseOsvScannerOutput(stdout: string, stderr = ''): AuditOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    const text = `${stdout}\n${stderr}`;
    return inconclusive(
      classifyToolDiagnostic(text),
      '`osv-scanner scan source --format json` did not print a JSON report, so the dependency tree was ' +
        `never audited. Output began: ${preview(text)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return inconclusive('no-verdict', `\`osv-scanner\` printed a non-object JSON document: ${preview(stdout)}`);
  }

  const results = readResults(parsed, stdout);
  if (isOutcome(results)) return results;

  const advisories: DependencyAdvisory[] = [];
  for (const entry of results) {
    const found = advisoriesForSource(entry, stdout);
    if (isOutcome(found)) return found;
    advisories.push(...found);
  }
  return { kind: 'advisories', advisories };
}
