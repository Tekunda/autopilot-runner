// The pluggable Gate framework: the QA layer runs a configurable set of gates
// against a stage/PR and collects results. Framework only — no specific gates
// here; packs add gates via GateRegistry.register, entitlement decides which
// run (later). See AGENTS.md and issue #72.
//
// GateContext carries no CIRunner: gates run runner-side (issue #106), and
// the runner never dispatches CIRunner on itself (issue #67's recursive
// plane-conflation bug) -- it only needs VCSHost, which it already holds for
// the coding-stage finalize phase.

import type { VCSHost } from '../contracts/adapters.ts';
import type { StackProfile } from './stack-profile.ts';

// `warn` is a report-only failure: the gate's check did not pass, but it must NOT
// fail the grant. Aggregation treats it like a pass FOR THE VERDICT while still
// carrying its findings -- see runGates and run-gate-stage's `ok`.
//
// "Does not fail the grant" and "publishes as a pass" are two different statements,
// and `warn` alone does not decide the second: that is what `noVerdict` (below) is
// for. A `warn` that JUDGED publishes a green `pass`; a `warn` that reached no
// verdict publishes `pending` + `reportOnly` and banks no coverage. Conflating the
// two is a live defect in both directions -- a non-verdict banked as a pass hides a
// gate that never ran, and a real verdict published as a non-verdict hides a gate
// that did. THE FIVE PRODUCERS, and which they mean:
//
//   JUDGED (publishes `pass`, banks coverage, stamps a real verdict):
//     - command/command-gate.ts        a `blocking:false` command that exited non-zero
//     - generic/assertion-delta.ts     weakened assertions found, `enforce:false`
//     - generic/structure.ts           repo-integrity findings
//     - packs/seo/site-crawl.ts        the crawl ran and found only sub-blocking warnings
//
//   NO VERDICT (must set `noVerdict`; publishes `pending` + `reportOnly`, banks nothing):
//     - generic/cve.ts                 an audit that COULD NOT RUN (no osv-scanner on this
//                                      runner, an unreadable dependency layout) on a repo whose
//                                      coverage is new, so it reports instead of blocking
//
// A new `warn` producer MUST decide which it is, and MUST NOT rely on the default to
// be the safe answer -- it is not. The default (no flag) is "judged" for one reason
// only: it is what the four producers that already existed mean, so the flag could be
// added without changing any of their behaviour.
//
// Be aware which way that cuts. Omitting the flag on a producer that reached NO verdict
// is the DANGEROUS mistake -- it publishes green and banks a real verdict for work that
// never happened, which is the silent-off hole this flag exists to close. Setting it on
// a producer that DID judge is the milder one: a working gate reads as "never ran",
// banks no coverage, and alarms `gate_never_fired`. Neither is acceptable, and the
// default protects you from neither. What protects you is that each producer's own
// test pins its answer -- `assert.equal('noVerdict' in result, false)` in
// structure.test.ts, assertion-delta.test.ts, command-gate.test.ts and
// site-crawl.test.ts, and `assert.equal(result.noVerdict, true)` in cve-osv.test.ts.
// All five, because a default cannot decide this for you.
//
// `unjudged` is the gate that EXECUTED but reached no verdict (e.g. the vision
// judge stayed rate-limited past its retry budget). It is distinct from `warn`,
// which is a report-only *finding*: an unjudged *gate* never counts as a pass,
// even when the gate is non-blocking -- a gate that reports success when it never
// judged is worse than no gate. Aggregation maps it to a merge-blocking `fail`,
// and `unjudgedReason` then decides what happens next: `infra` (the judge could
// not RUN, e.g. a 429 past its backoff) is retried as an infra fault on a bounded
// budget, anything else escalates to a human at once -- see toCheckStatus and the
// fix loop's non-revertable classification.
export type GateStatus = 'pass' | 'fail' | 'skip' | 'warn' | 'unjudged';

export interface GateContext {
  repoId: string;
  prNumber: number;
  branch: string;
  baseRef: string;
  changedFiles: string[];
  // The customer PR checkout the gates run against (GITHUB_WORKSPACE), NOT the
  // runner's own action directory. Deterministic tree-scanning gates (cve's
  // `npm audit`) must audit this, never process.cwd().
  workspaceRoot: string;
  vcsHost: VCSHost;
  config: Record<string, unknown>;
  // What toolchains the checkout at `workspaceRoot` actually contains -- Node (and which
  // package manager), Python (and which dependency manager), Salesforce -- detected ONCE per
  // gate stage by gates/stack-profile.ts's detectStack, so twenty gates stop each guessing
  // privately. Like `changedFiles`, this is a FILESYSTEM-DERIVED FACT assembled runner-side,
  // NOT a policy decision: it deliberately does not ride in the signed ExecutionGrant, because
  // nothing server-side can see the checkout to sign a claim about it.
  //
  // Optional, and a gate must behave correctly when it is absent (an older caller, or a test
  // that builds a context by hand) -- absent means "not detected", never "nothing here".
  // Ordered by the fixed detector order, which is deterministic but is NOT a ranking; a
  // polyglot repo (a Salesforce org with an LWC front end) legitimately carries more than one.
  stackProfiles?: readonly StackProfile[];
}

// Why a gate returned `skip` -- a first-class "never ran" outcome, the complement of `unjudged`
// ("ran, reached no verdict"). A skip must stay distinguishable from a pass all the way to the
// promotion record: a gate that skips 100% of the time is banked as coverage only if its skip is
// indistinguishable from a pass (the exact hole that let a perpetual-skip `layout-rules` be flipped
// to blocking though it never produced a verdict). The reason drives escalation: `no-config`/
// `disabled` are benign (the gate has nothing to do), while a gate WITH rules that skips every time
// (`no-matching-route`/`no-baseurl`/`unjudgeable-language`) is a diagnosable misconfiguration worth
// surfacing, so those are suspicious rather than benign.
//
// `invalid-config` CARRIES A STRONGER CLAIM THAN THE REST, and a producer must earn it: the gate's
// declared config parsed to nothing, so the gate cannot run on THIS promotion or any later one
// until a human edits the config. The control plane reads that permanence (control-plane/
// gate-verdict-ledger.ts classifies it `config-invalid`) and will say so to an operator even for a
// gate with a long verdict history, because history is not evidence a gate with unusable config
// still gates. So `invalid-config` may only be returned from a decision made on CONFIG ALONE.
// A skip that depends on the DIFF -- "this PR's files happen to be ones I can't judge" -- is not
// permanent, recurs whenever the diff swings back, and must use a diff-scoped reason instead
// (`no-matching-route`, `unjudgeable-language`). Overloading `invalid-config` for a diff-conditional
// skip makes the control plane assert a config fault that is not there, on every such PR.
export type SkipReason =
  | 'no-baseurl'
  // The diff maps to no RENDERABLE ROUTE this gate could point a browser at. Strictly about
  // routes, not files -- a file matcher that selects nothing is `no-matching-files` below.
  // `structure` and `test-policy` used to borrow this one for their file matchers, which left
  // the vocabulary with one name for two different questions.
  | 'no-matching-route'
  // The diff DID select files for this gate, but they are all in a language/format the gate's
  // checker has no patterns for, so it asserted nothing on this PR. Diff-scoped, NOT a config
  // verdict: the same config judges the next diff fine (see `invalid-config` above). Non-benign,
  // so it still stays out of the coverage record and still raises `gate_never_fired` for a gate
  // that NEVER produces a verdict.
  | 'unjudgeable-language'
  // The gate's file matcher selected NOTHING out of the files it was pointed at -- this PR's diff
  // for the diff-scoped gates, the configured content tree for the whole-tree sweep
  // (`seo-monitor`) -- so no test file, locale file, content page or scannable source file was
  // ever opened and the gate asserted nothing. Diff-scoped,
  // exactly like `no-matching-route` -- the next diff may well select files -- and it exists
  // because the alternative every one of those gates used to take was `status:'pass'`: a gate that
  // looked at zero files and banked a green check. A PR touching only `README.md` would collect
  // passes from `assertion-delta`, `security-review`, `i18n-completeness`, `internal-links`,
  // `cover-title`, `external-links`, `cannibalization` and `docs-api-coverage` without one of them
  // having judged a single line. The coverage record then reads eight enforcing gates where there
  // were none. Non-benign for the same reason `no-matching-route` is: a gate whose matcher never
  // matches on ANY promotion is a misconfigured matcher (wrong `contentDir`, wrong
  // `testFileExtensions`), and only the perpetual case alarms -- a gate with real verdicts behind
  // it is excused (see gate-verdict-ledger's SKIP_CLASSES).
  | 'no-matching-files'
  | 'no-config'
  | 'invalid-config'
  | 'disabled'
  | 'infra';

// The fields every result carries, whatever its status. `GateResult` itself is a UNION over
// `status` (below) so that `noVerdict` is structurally impossible anywhere it would be ignored.
interface GateResultFields {
  id: string;
  // Set on `status:'skip'` to explain WHY the gate never ran. Round-trips through the gate report
  // artifact (ci-runner parseGateReport) so the promotion record can tell a benign skip from a
  // suspicious perpetual one.
  skipReason?: SkipReason;
  // Set on `status:'unjudged'` to say WHY the gate reached no verdict. 'infra': the judge could
  // not RUN (the vision model stayed rate-limited/429 past its backoff -- transient infra); a
  // re-run may succeed, so downstream grants one gate-only retry before escalating. 'content':
  // the judge RAN but reached no verdict about the page; a re-run won't help, so escalate now.
  // Absent -> treated as 'content'. It NEVER makes an unjudged pass -- it only routes escalation.
  unjudgedReason?: 'infra' | 'content';
  findings?: string[];
  detailsUrl?: string;
}

// `noVerdict` is a DISCRIMINATED property, not a free-floating flag: it is meaningful only on a
// `warn`, and on anything else it would be silently dropped by run-gate-stage (which keys on
// `status === 'warn' && noVerdict === true`). Silently-dropped flags are how a gate author comes
// to believe they declared something they did not, so the type refuses the combination outright
// instead: `{ status: 'pass', noVerdict: true }` is a compile error, not a no-op.
export type GateResult =
  | (GateResultFields & {
      status: 'warn';
      // Set to say this warn reached NO VERDICT -- the gate ran but judged nothing, and is demoted
      // to reporting rather than blocking (cve.ts's staged rollout for a newly-covered repo whose
      // audit could not run). The sibling of `unjudged`, which is the same fact for a gate that
      // still BLOCKS; this one does not, which is exactly why it needs a flag: without one it is
      // indistinguishable from the four `warn`s that DID judge, and downstream either banks a
      // non-verdict as coverage or reports a real verdict as if the gate never ran.
      //
      // Absent (the default) means the warn JUDGED -- see the GateStatus comment above for which
      // producer is which. run-gate-stage maps this to CheckResult.reportOnly; the two names
      // differ because they state different things: `noVerdict` is what the GATE did,
      // `reportOnly` is how the CHECK is published and banked.
      noVerdict?: true;
    })
  | (GateResultFields & { status: Exclude<GateStatus, 'warn'>; noVerdict?: never });

export interface Gate {
  id: string;
  run(ctx: GateContext): Promise<GateResult>;
  // The JIT instruction a licensed pack gate ships as (issue #129): the control plane
  // reads this to build the gate's signed `{kind:'prompt', id, prompt}` GateSpec --
  // `run` itself never executes runner-side for a pack gate, only server-side/in tests.
  // Unset for the always-on generic gates, which run as bundled code (`{kind:'generic'}`).
  prompt?: string;
}

export interface GateReport {
  ok: boolean;
  results: GateResult[];
}
