// The npm and Yarn 1 audit parsers -- the JavaScript half of the `cve` gate, and the half whose
// bugs wrote this gate's rules.
//
// THE FAILURE THIS FILE EXISTS TO PREVENT: an audit that could not RUN must never be reportable
// as "clean". The first version ran `npm audit --json` unconditionally and did
// `report.vulnerabilities ?? {}`. On a Yarn tenant (`yarn.lock`, no `package-lock.json`)
// npm exits non-zero and prints a perfectly VALID JSON error document --
//   {"error":{"code":"ENOLOCK","summary":"This command requires an existing lockfile.",...}}
// -- so `JSON.parse` succeeded, `?? {}` turned the missing `vulnerabilities` key into zero
// advisories, and the gate reported `pass` on every run while auditing nothing at all. A known
// high/critical CVE would have merged behind a green security check.
//
// The distinction that must never blur: `vulnerabilities` PRESENT AND EMPTY (`{"vulnerabilities":
// {}}`, what a healthy npm repo prints) is CLEAN and must pass; `vulnerabilities` ABSENT is
// could-not-determine. Yarn 1's analogue is the `auditSummary` NDJSON line -- it is printed on a
// clean audit too, so its ABSENCE is the "this audit never completed" signal.
//
// Pure parsing only: planning, spawning and thresholds live in ./cve.ts, which keeps the
// dependency one-way (cve.ts -> this -> audit-outcome.ts) and every branch here testable from a
// string literal.

import {
  classifyToolDiagnostic,
  inconclusive,
  preview,
  rankableSeverity,
  unrankableSeverity,
  type AuditOutcome,
  type DependencyAdvisory,
} from './audit-outcome.ts';

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
