// The vocabulary every dependency audit speaks, shared by the npm/Yarn auditor (./cve.ts) and
// the osv-scanner one (./osv-scanner.ts).
//
// It lives in its own module for one reason: BOTH auditors need it and cve.ts needs
// osv-scanner.ts, so leaving it in cve.ts would make the two import each other. A cycle would
// happen to work here (everything is a function or a Map read at call time), but "happens to
// work" is not a property a security gate's module graph should rely on, and check:layering
// forbids it outright.
//
// Nothing in here decides anything. The rules these types encode -- an audit that could not run
// is never a pass, a severity that cannot be ranked is REPORTED rather than dropped -- are
// documented on the declarations themselves, because that is where a reader meets them.

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

// Maps, NOT object literals. `SEVERITY_ALIASES['constructor']` on a literal
// returns Object's own constructor -- truthy, not a Severity -- and the advisory
// carrying it then ranks `undefined`, compares false against every threshold,
// and disappears from the findings. A blocking security gate must not have a
// lookup that answers questions nobody asked. (`__proto__` is the same hole;
// `.toLowerCase()` was only accidentally covering `toString`.)
export const SEVERITY_ALIASES: ReadonlyMap<string, Severity> = new Map([
  // `info` is the fifth level npm and Yarn 1 both emit; it ranks below `low`.
  ['info', 'low'],
  ['low', 'low'],
  ['moderate', 'moderate'],
  ['high', 'high'],
  ['critical', 'critical'],
] as const);

export const SEVERITY_RANK: ReadonlyMap<Severity, number> = new Map([
  ['low', 0],
  ['moderate', 1],
  ['high', 2],
  ['critical', 3],
] as const);

// The severity an advisory is REPORTED with. `'unknown'` is not a fifth level -- it is the
// absence of one, and it exists because osv-scanner's `max_severity` is legitimately empty for
// advisories that carry no CVSS score (many PYSEC records do). The two wrong answers were both
// tried on paper: ranking it below the threshold DROPS a real advisory, and calling the whole
// audit inconclusive WEDGES every Python tenant carrying one unscored record. So an advisory
// this gate cannot rank is always reported -- the same fail-safe direction the threshold filter
// already took for a rank it could not compute.
export type AdvisorySeverity = Severity | 'unknown';

export interface DependencyAdvisory {
  packageName: string;
  severity: AdvisorySeverity;
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
//   'tooling-missing'   -- the tool this tree needs IS NOT ON THIS RUNNER (osv-scanner was never
//                          provisioned, or its download failed). Deterministic (`content`): no
//                          retry installs a binary. Demotable like `repo-shape`, and for the same
//                          reason -- an operator may accept "we are not auditing this repo here",
//                          which is a statement about the environment they own, not about a check
//                          that broke.
//
//                          NOT a `skip`, though the first draft of this made it one. A skip is
//                          excused by the gate's own history (control-plane/promotion.ts: a prior
//                          real verdict suppresses `gate_never_fired`, and the id is re-added to
//                          the regression set), so a tenant that audited successfully once would
//                          have gone on reporting a benign-looking skip on every later PR while
//                          nothing was audited and nothing alarmed -- CVE gating switched off
//                          silently and indefinitely. Blocking-and-visible is the only reading of
//                          "a missing scanner is not a clean audit" that survives contact with the
//                          ledger. A tree with NOTHING to audit never reaches here: that is
//                          decided from the manifests, before the tool is needed.
export type InconclusiveCause = 'repo-shape' | 'no-verdict' | 'transient-failure' | 'tooling-missing';

// The audit's outcome. The three cases are the whole point of this type: an
// audit that could not be performed is structurally impossible to mistake for
// `{ kind: 'advisories', advisories: [] }` (a clean tree), and a tree with
// nothing to audit is a third thing again. `reason` is human-facing -- it lands
// in the gate's findings, so it must say what could not be determined AND what a
// human should do about it.
export type AuditOutcome =
  | { kind: 'advisories'; advisories: DependencyAdvisory[] }
  | { kind: 'not-applicable'; reason: string }
  | {
      kind: 'inconclusive';
      cause: InconclusiveCause;
      reason: string;
      // Set when this outcome concerns a dependency tree the gate COULD NOT AUDIT AT ALL before
      // osv-scanner existed -- a Python, Go, Rust, Ruby, Java or PHP repo, which used to end at
      // `not-applicable` and report nothing. It exists for the staged rollout: see
      // CveGateConfig.blocking. Absent on every tree npm or Yarn was already auditing, so nothing
      // that gated last release stops gating this one.
      newCoverage?: boolean;
    };

export function inconclusive(cause: InconclusiveCause, reason: string, newCoverage = false): AuditOutcome {
  return { kind: 'inconclusive', cause, reason, ...(newCoverage ? { newCoverage: true } : {}) };
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

export function classifyToolDiagnostic(text: string): InconclusiveCause {
  // A tool that printed NOTHING at all did not run: no report, no complaint, not
  // even a parse error to read. That is infrastructure (an OOM-killed child, a
  // wedged runner), not a verdict about the repo, so it takes the retry lane
  // rather than escalating a human who has nothing to look at.
  if (text.trim() === '') return 'transient-failure';
  return TRANSIENT_FAULT.test(text) ? 'transient-failure' : 'no-verdict';
}

// The one place a reported severity is turned into a comparable number. `'unknown'` is not in
// SEVERITY_RANK's key type, so this narrows before the lookup rather than casting past it --
// and it returns `undefined` for exactly the values the threshold filter must REPORT rather than
// compare (see AdvisorySeverity).
export function rankOf(severity: AdvisorySeverity): number | undefined {
  return severity === 'unknown' ? undefined : SEVERITY_RANK.get(severity);
}

// `typeof raw !== 'string'` first: a report carrying `"severity": null` (or a
// number, or an object) would otherwise throw out of `.toLowerCase()` and escape
// this file's three-state contract entirely, landing in runGates' generic catch
// as a bare `fail` with a raw JS message. Failing safe by luck is not failing
// safe by design.
export function rankableSeverity(raw: unknown): Severity | undefined {
  if (typeof raw !== 'string') return undefined;
  return SEVERITY_ALIASES.get(raw.toLowerCase());
}

export function unrankableSeverity(packageName: string, raw: unknown): AuditOutcome {
  const shown = typeof raw === 'string' ? `"${raw}"` : raw === undefined ? '(none)' : JSON.stringify(raw ?? null);
  return inconclusive(
    'no-verdict',
    `the audit reported severity ${shown} for \`${packageName}\`, which this gate cannot rank against its ` +
      'threshold, so the report cannot be judged.',
  );
}

export function preview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 300 ? `${collapsed.slice(0, 300)}...` : collapsed || '(no output)';
}
