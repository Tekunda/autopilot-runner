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
// judged is worse than no gate. Aggregation maps it to a merge-blocking `fail`
// and it escalates to a human (no code fix can resolve it) -- see toCheckStatus
// and the fix loop's non-revertable classification.
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

export interface GateResult {
  id: string;
  status: GateStatus;
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
