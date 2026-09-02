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

// `warn` is a report-only failure: the gate's check did not pass, but the gate
// is non-blocking (a `blocking:false` command gate), so it must NOT fail the
// grant. Aggregation treats it like a pass for the verdict while still carrying
// its findings -- see runGates and run-gate-stage's toCheckStatus.
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
  | 'no-matching-route'
  // The diff DID select files for this gate, but they are all in a language/format the gate's
  // checker has no patterns for, so it asserted nothing on this PR. Diff-scoped, NOT a config
  // verdict: the same config judges the next diff fine (see `invalid-config` above). Non-benign,
  // so it still stays out of the coverage record and still raises `gate_never_fired` for a gate
  // that NEVER produces a verdict.
  | 'unjudgeable-language'
  | 'no-config'
  | 'invalid-config'
  | 'disabled'
  | 'infra';

export interface GateResult {
  id: string;
  status: GateStatus;
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
