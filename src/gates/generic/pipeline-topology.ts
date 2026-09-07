// `pipeline-topology` gate: a subtask PR must merge into a ticket branch, not past it into a base
// branch. Pure over GateContext.branch + baseRef; one rule, one config key.
//
// The pipeline moves a ticket's work along a chain of branches -- a coding stage pushes to a build
// branch, whose PR lands on that ticket's branch, which is then rolled up and promoted. A subtask
// PR whose base is a base branch instead carries one slice of a ticket straight out of that chain,
// past the aggregate checks and past the control plane's own completeness guard, which is exactly
// the "never merge an incomplete set" guarantee this ports.
//
// WHAT IT CAN AND CANNOT SEE, stated plainly because the name invites a stronger reading.
// `baseRef` is a DISPATCH-TIME SNAPSHOT: the base is read once when the gate run is dispatched, and
// editing a PR's base afterwards changes no commit, so nothing re-dispatches and this verdict does
// not move. The property is therefore "the base was already wrong when this run was dispatched",
// not "the base is right at the moment of merge". Closing the remaining window is a job for the
// merge path (which re-reads the PR anyway), not for a gate; it is deliberately not attempted
// here.
//
// The rule is also a SHAPE, not an identity: a build branch's name carries a hash of its own
// subtask, not its parent's stem, so this can require A ticket branch and not THE right one. That
// raises the cost of moving work out of the chain rather than preventing it -- someone able to
// retarget a PR can create a ticket branch to retarget it onto. It is a guard on the ordinary
// accident and the careless edit, and it should not be read as a control against a determined one.
//
// ONE HOP, and the other two are deliberately absent rather than forgotten: a gate context exists
// only where a gate-stage grant is issued, those grants are per-subtask by a recorded design
// decision, and the external-PR sweep skips every head the pipeline owns. So no rollup or
// promotion head can ever reach this gate, and a rule for one could only ever be dead surface --
// and dead surface with a burn-in criterion nothing could satisfy.
//
// The prefixes come from branch-names.ts, shared with the predicate the external-PR sweep uses, so
// the two cannot disagree about which branches the pipeline owns. Nothing tenant-specific reaches
// this file: the one name that varies per customer -- the base branch a ticket eventually lands on
// -- is never needed, because every rule is stated from the head branch's own name.
//
// REPORT-ONLY BY DEFAULT (`enforce: false`), so a violation publishes and prints as a JUDGED
// `warn` and cannot block a merge. It is a per-tenant `gateConfig` flip, not a code edit, for the
// same reason `assertion-delta` made it one: a burn-in that can only end for every tenant at once
// is not a burn-in. Whoever flips it inherits one consequence -- no edit to the diff clears a
// wrong base, so this gate's findings must buy no fix rounds.

import { readGateConfig } from './config.ts';
import { BUILD_BRANCH_PREFIXES, TICKET_BRANCH_PREFIX } from '../../control-plane/branch-names.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

interface PipelineTopologyGateConfig {
  /** Tenant opt-in: true turns a violation into a blocking `fail`; default report-only `warn`. */
  enforce: boolean;
}

const DEFAULT_PIPELINE_TOPOLOGY_CONFIG: PipelineTopologyGateConfig = { enforce: false };

// `enforce` arrives from a tenant-editable packConfig, so it is untrusted: anything that is not
// exactly `true` reads as report-only rather than throwing, which is the same discipline every
// other generic gate applies to its config.
function effectivePipelineTopologyConfig(
  specConfig?: Record<string, unknown>,
): PipelineTopologyGateConfig {
  const config = readGateConfig(
    specConfig === undefined ? {} : { 'pipeline-topology': specConfig },
    'pipeline-topology',
    DEFAULT_PIPELINE_TOPOLOGY_CONFIG,
  );
  return { enforce: config.enforce === true };
}

// The stem a prefix carries, or undefined when `branch` is not that shape. A bare prefix with
// nothing after it is NOT that shape: git refuses a ref ending in `/`, so it names no branch, and
// admitting it would let a base that merely looks like a ticket branch satisfy the rule.
function stemAfter(branch: string, prefix: string): string | undefined {
  if (!branch.startsWith(prefix)) return undefined;
  const stem = branch.slice(prefix.length);
  return stem.length > 0 ? stem : undefined;
}

/** A head a coding stage pushes to -- the head of a subtask PR, and the only head this gate grades. */
export function isBuildBranch(branch: string): boolean {
  return BUILD_BRANCH_PREFIXES.some((prefix) => stemAfter(branch, prefix) !== undefined);
}

/**
 * The rule this pair breaks, or undefined when the hop is intact.
 *
 * The required target is stated positively -- the base must BE a ticket branch -- rather than as a
 * list of bases to refuse. That is what keeps the check monotone: a base that is merely more
 * pipeline-shaped can add a finding and can never remove one, whereas "the base must not look like
 * X" quietly passes every spelling of X the list forgot.
 */
export function pipelineTopologyViolation(head: string, base: string): string | undefined {
  if (!isBuildBranch(head)) return undefined;
  if (stemAfter(base, TICKET_BRANCH_PREFIX) !== undefined) return undefined;
  return (
    `build branch "${head}" targets "${base}"; a subtask PR must merge into a ticket branch ` +
    `("${TICKET_BRANCH_PREFIX}<stem>"), never past it into a base branch`
  );
}

export function createPipelineTopologyGate(): Gate {
  return {
    id: 'pipeline-topology',
    async run(ctx: GateContext): Promise<GateResult> {
      const config = effectivePipelineTopologyConfig(ctx.config['pipeline-topology'] as Record<string, unknown> | undefined);
      const { branch, baseRef } = ctx;

      // The refs arrive as unvalidated JSON from the dispatch input, so "absent" is a real
      // possibility and it is NOT the same fact as "a head no rule applies to". Both would
      // otherwise take the clean-pass branch, which would make a gate that could not read its
      // input indistinguishable from one that read it and found nothing wrong. `skip` rather than
      // `unjudged`: this gate is report-only, and a malformed dispatch input must not be the one
      // way it can block a merge. `infra` keeps it out of the coverage record and classified
      // suspicious, so a run that never reads its refs is diagnosable instead of silent.
      if (typeof branch !== 'string' || branch.length === 0 || typeof baseRef !== 'string' || baseRef.length === 0) {
        return {
          id: 'pipeline-topology',
          status: 'skip',
          skipReason: 'infra',
          findings: [
            `pipeline-topology could not read this PR's refs (head "${String(branch)}", base ` +
              `"${String(baseRef)}"), so it judged nothing`,
          ],
        };
      }

      const violation = pipelineTopologyViolation(branch, baseRef);
      if (violation !== undefined) {
        return { id: 'pipeline-topology', status: config.enforce ? 'fail' : 'warn', findings: [violation] };
      }

      // Say which of the two clean answers this was. "The hop is intact" and "no rule applies to
      // this head" are different facts, and the burn-in reads these lines: a corpus of only the
      // second would mean the gate has never actually judged a subtask PR.
      return {
        id: 'pipeline-topology',
        status: 'pass',
        findings: [
          `pipeline-topology examined head "${branch}" -> base "${baseRef}": ` +
            (isBuildBranch(branch)
              ? 'the subtask hop is intact'
              : 'the head is no build branch, so no hop rule applies to it'),
        ],
      };
    },
  };
}
