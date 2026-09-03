// The artifact a JUDGMENT stage (architect, accept, lensed review) reports itself on.
//
// The gate stage has gate-report.json and the fix stage has fix-report.json, both for the same
// reason: GitHub exposes no API for a DISPATCHED run's step outputs, so a file uploaded as a
// workflow artifact is the only channel a stage's structured result can travel back on. Judgment
// stages had no such file. Their only artifact was plan.json -- written by the AGENT, uploaded by
// a step that is skipped when the vendor step fails -- so a run whose agent never executed
// reported nothing at all, and the control plane saw a bare `failure` conclusion.
//
// That is what made a PROVIDER REJECTION indistinguishable from a judgment that ran and failed:
// finalize-stage.ts has classified the two apart since #431 and puts a `provider-rejected` check
// in the judgment telemetry, but nothing carried that telemetry off the runner. Observed live on
// Tekunda/Website external-pr-1534 (run 33694525003, 2026-09-02 23:19 UTC): the accept/QA run
// ended in 332ms having spent $0 with an empty modelUsage, and the control plane charged it to
// the PR's content repair budget.
//
// Written by the runner (action-entry.ts) rather than by the agent, and uploaded with `always()`,
// so it exists on exactly the runs that matter -- the failing ones.

/** The workspace file action-entry.ts writes and action.yml uploads. */
export const JUDGMENT_REPORT_FILE = 'judgment-report.json';

/**
 * The artifact NAME that file is uploaded under, and the name ci-runner.ts downloads by. The
 * two are separate strings in the Actions API (artifact vs. member path), so both live here:
 * action.yml has to spell them as literals, and judgment-report.test.ts asserts the template
 * still agrees with these -- a silent rename on either side would restore the exact
 * "artifact never arrives, classifier constant-false, tests green" state this file exists to end.
 */
export const JUDGMENT_REPORT_ARTIFACT = 'judgment-report';
