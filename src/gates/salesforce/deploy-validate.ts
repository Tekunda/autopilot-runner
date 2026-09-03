// `salesforce-deploy-validate`: a check-only deploy of the package's metadata into a real org.
// The six false-green rules it obeys, and where the credential env-var NAME is configured, are
// documented once in org-gate-common.ts, which also owns the shared org preamble this gate runs
// before it ever reaches the CLI.

import { runCommand } from '../exec.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';
import { readGateConfig } from '../generic/config.ts';
import { redactSecrets } from './org.ts';
import { skip, unjudged } from './profile.ts';
import {
  COMMAND_TIMEOUT_MS,
  MAX_LISTED,
  WAIT_MINUTES,
  bounded,
  describeProvenance,
  isObject,
  prepareOrg,
  type OrgGateDeps,
} from './org-gate-common.ts';

export const DEPLOY_VALIDATE_GATE_ID = 'salesforce-deploy-validate';

// ---------------------------------------------------------------------------
// salesforce-deploy-validate
// ---------------------------------------------------------------------------

// `sf project deploy validate --test-level`'s own option list, minus the one this gate cannot
// drive. A value outside it is refused by the CLI itself, which would turn a config typo into an
// unjudged gate on every PR; it falls back to the default instead (risk.ts's discipline), and
// never to "run no tests" -- there is no such option here, which is the point.
export const DEPLOY_TEST_LEVELS = ['RunAllTestsInOrg', 'RunLocalTests', 'RunRelevantTests'] as const;
export type DeployTestLevel = (typeof DEPLOY_TEST_LEVELS)[number];
export const DEFAULT_DEPLOY_TEST_LEVEL: DeployTestLevel = 'RunLocalTests';

// `RunSpecifiedTests` is a REAL CLI option that this gate cannot use: it requires a `--tests`
// list, and nothing here has one to pass, so selecting it validates nothing and fails every
// time. It is called out separately rather than merged into "unrecognised value" so it can be
// REFUSED rather than silently rewritten. Falling back to RunLocalTests would run a different
// test set from the one the tenant asked for and report a pass for it -- the gate answering a
// question nobody put. `invalid-config` is earned exactly as gates/types.ts demands: decided on
// CONFIG ALONE, identical on every diff, permanent until a human edits it.
const UNSUPPORTED_TEST_LEVELS = ['RunSpecifiedTests'] as const;

export type TestLevelChoice =
  | { kind: 'level'; level: DeployTestLevel }
  | { kind: 'unsupported'; requested: string };

export function effectiveTestLevel(config: Record<string, unknown>): TestLevelChoice {
  const raw = readGateConfig(config, DEPLOY_VALIDATE_GATE_ID, {
    testLevel: DEFAULT_DEPLOY_TEST_LEVEL as unknown,
  }).testLevel;
  if (UNSUPPORTED_TEST_LEVELS.includes(raw as (typeof UNSUPPORTED_TEST_LEVELS)[number])) {
    return { kind: 'unsupported', requested: raw as string };
  }
  return {
    kind: 'level',
    level: DEPLOY_TEST_LEVELS.includes(raw as DeployTestLevel) ? (raw as DeployTestLevel) : DEFAULT_DEPLOY_TEST_LEVEL,
  };
}

// plugin-deploy-retrieve's DEPLOY_STATUS_CODES, verbatim. `Failed` and `Canceled` share 1;
// InProgress, Pending and Canceling share 69.
const DEPLOY_EXIT_SUCCEEDED = 0;
const DEPLOY_EXIT_FAILED = 1;
const DEPLOY_EXIT_SUCCEEDED_PARTIAL = 68;
const DEPLOY_EXIT_IN_PROGRESS = 69;

export interface DeployComponentFailure {
  file?: string;
  line?: number;
  type?: string;
  fullName?: string;
  problem: string;
}

export type DeployParse =
  | { kind: 'envelope'; failures: DeployComponentFailure[]; reportedErrors?: number }
  // The `--json` envelope could not be recognised. NEVER "no component failures".
  | { kind: 'unrecognised'; reason: string };

// The Metadata API's JSON is SOAP-derived, so a list with exactly ONE member arrives as a bare
// object rather than a one-element array. Reading only arrays here would drop precisely the
// single-failure case -- the most common one -- and report a failing deploy with no failures.
function asList(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isObject(value)) return [value];
  return [];
}

function readFailures(entries: unknown[], problemKey: 'problem' | 'message'): DeployComponentFailure[] {
  const failures: DeployComponentFailure[] = [];
  for (const entry of entries) {
    if (!isObject(entry)) continue;
    const problem = entry[problemKey] ?? entry.problem ?? entry.message;
    if (typeof problem !== 'string') continue;
    failures.push({
      ...(typeof entry.fileName === 'string' ? { file: entry.fileName } : {}),
      ...(typeof entry.lineNumber === 'number' ? { line: entry.lineNumber } : {}),
      ...(typeof entry.componentType === 'string' ? { type: entry.componentType } : {}),
      ...(typeof entry.fullName === 'string'
        ? { fullName: entry.fullName }
        : typeof entry.name === 'string'
          ? { fullName: entry.name }
          : {}),
      problem,
    });
  }
  return failures;
}

// Parse `sf project deploy validate --json`. Strict about the ENVELOPE (an absent `result` is a
// document we do not understand) and forgiving about each failure's detail (a missing line
// number costs a line number, not the finding).
export function parseDeployEnvelope(raw: string): DeployParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: 'unrecognised',
      reason: `the \`sf project deploy validate --json\` output is not JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (!isObject(parsed) || !isObject(parsed.result)) {
    return {
      kind: 'unrecognised',
      reason:
        'the `sf project deploy validate --json` output has no `result` object. An absent key is ' +
        'not an empty result -- this is not a deploy report, so no failure list can be read from it.',
    };
  }
  const result = parsed.result;
  const details = isObject(result.details) ? result.details : undefined;

  const componentFailures = readFailures(asList(details?.componentFailures), 'problem');
  // At `--test-level RunLocalTests` the validation most often fails on an APEX TEST rather than
  // on a component, and those live in a different part of the same document. Reading only
  // componentFailures would report "validation failed, 0 failures" for the commonest failure.
  const testFailures =
    details !== undefined && isObject(details.runTestResult)
      ? readFailures(asList(details.runTestResult.failures), 'message')
      : [];

  return {
    kind: 'envelope',
    failures: [...componentFailures, ...testFailures],
    ...(typeof result.numberComponentErrors === 'number' ? { reportedErrors: result.numberComponentErrors } : {}),
  };
}

// EXIT 1 IS NOT ONLY "THE DEPLOY FAILED". oclif exits 1 for its OWN command errors too -- no org
// found, an expired session, REQUEST_LIMIT_EXCEEDED, a flag combination the plugin rejects -- and
// it prints an ERROR envelope instead of a deploy result: `{"status":1,"name":...,"message":...}`
// with no `result`. Treating that as `DEPLOY_STATUS_CODES.Failed` fails the PR for a fault that
// is not in the diff and that the author cannot fix. So an error envelope is recognised on its
// own terms and routed to `unjudged`/`infra`. Deliberately strict: a document carrying a `result`
// is a deploy report and stays on the `fail` path, because "we could not parse it" must never
// become a way to soften a real failure.
export function parseOclifError(raw: string): { name?: string; message: string } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isObject(parsed) || isObject(parsed.result)) return undefined;
  if (typeof parsed.status !== 'number' || parsed.status === 0) return undefined;
  const message = typeof parsed.message === 'string' ? parsed.message : undefined;
  const name = typeof parsed.name === 'string' ? parsed.name : undefined;
  if (message === undefined && name === undefined) return undefined;
  return { ...(name !== undefined ? { name } : {}), message: message ?? (name as string) };
}

export function describeDeployFailure(failure: DeployComponentFailure): string {
  const where =
    failure.file !== undefined
      ? `${failure.file}${failure.line !== undefined ? `:${failure.line}` : ''}`
      : (failure.fullName ?? '(no location)');
  const type = failure.type !== undefined ? ` [${failure.type}]` : '';
  return redactSecrets(`${where}${type} ${failure.problem}`);
}

// What the command actually did, carried whole into the classification below. Everything here
// is needed by a finding string, so it travels as one value rather than seven arguments.
interface DeployRun {
  id: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  roots: string[];
  provenance: string;
  testLevel: DeployTestLevel;
}

// Exit 1 (Failed/Canceled) and exit 68 (SucceededPartial): the CLI has told us the validation did
// not succeed, and all that is left is to say WHY as precisely as the envelope allows.
function deployDidNotSucceedResult(run: DeployRun): GateResult {
  const { id, exitCode, stdout, stderr, roots, provenance } = run;
  const parsed = parseDeployEnvelope(stdout);
  if (exitCode === DEPLOY_EXIT_FAILED && parsed.kind === 'unrecognised') {
    // The CLI failed as a COMMAND, not as a deploy: see `parseOclifError`. No metadata was
    // ever uploaded, so there is no verdict about this diff -- and `infra` rather than
    // `content` because an expired session or a governor limit is precisely what a bounded
    // re-run clears.
    const cliError = parseOclifError(stdout);
    if (cliError !== undefined) {
      return unjudged(id, 'infra', [
        `${id}: \`sf project deploy validate\` failed as a command rather than as a deploy ` +
          `(exit ${exitCode}${cliError.name !== undefined ? `, ${cliError.name}` : ''}): ` +
          `${redactSecrets(cliError.message)}. No metadata reached the org, so nothing was ` +
          `validated -- this is an org/CLI fault, not a defect in this diff, and it is reported ` +
          `as unjudged rather than as a failure of the PR.`,
        ...bounded(stderr),
      ]);
    }
  }
  const outcome = exitCode === DEPLOY_EXIT_SUCCEEDED_PARTIAL ? 'succeeded only partially' : 'failed or was cancelled';
  if (parsed.kind === 'envelope' && parsed.failures.length > 0) {
    const reported =
      parsed.reportedErrors !== undefined ? ` (the CLI reports ${parsed.reportedErrors} component error(s))` : '';
    return {
      id,
      status: 'fail',
      findings: [
        `${id}: the check-only deploy of [${roots.join(', ')}] ${outcome} (exit ${exitCode}) ` +
          `with ${parsed.failures.length} failure(s)${reported}, using ${provenance}:`,
        ...parsed.failures.slice(0, MAX_LISTED).map(describeDeployFailure),
        ...(parsed.failures.length > MAX_LISTED ? [`... and ${parsed.failures.length - MAX_LISTED} more`] : []),
      ],
    };
  }
  // The CLI said the validation did not succeed. Not being able to find the structured
  // failures is a reason to report the raw output -- never a reason to soften a stated
  // failure into anything greener.
  return {
    id,
    status: 'fail',
    findings: [
      `${id}: the check-only deploy of [${roots.join(', ')}] ${outcome} (exit ${exitCode}) ` +
        `using ${provenance}, but no structured component failure could be read from its \`--json\` ` +
        `output${parsed.kind === 'unrecognised' ? ` (${parsed.reason})` : ''}. The raw output follows.`,
      ...bounded(stderr, stdout),
    ],
  };
}

// The EXIT CODE is the verdict; the `--json` envelope only ever explains it. One branch per code
// plugin-deploy-retrieve documents, and one closing refusal for everything it does not.
function classifyDeployExit(run: DeployRun): GateResult {
  const { id, exitCode, stdout, stderr, roots, provenance, testLevel } = run;

  if (exitCode === DEPLOY_EXIT_SUCCEEDED) {
    return {
      id,
      status: 'pass',
      findings: [
        `${id} ran a check-only deploy of [${roots.join(', ')}] into the Salesforce org ` +
          `at test level ${testLevel}, using ${provenance}: the metadata compiled and the tests it ` +
          `selected passed. Nothing was deployed -- \`project deploy validate\` never commits.`,
      ],
    };
  }

  if (exitCode === DEPLOY_EXIT_FAILED || exitCode === DEPLOY_EXIT_SUCCEEDED_PARTIAL) {
    return deployDidNotSucceedResult(run);
  }

  if (exitCode === DEPLOY_EXIT_IN_PROGRESS) {
    // Rule 3: there is no result yet, so there is nothing to judge. `infra`, because the
    // deploy was healthy and merely slow, and a re-run is exactly the right response.
    return unjudged(id, 'infra', [
      `${id} stopped waiting after ${WAIT_MINUTES} minute(s) while the deploy was still in ` +
        `progress or pending (exit ${exitCode}). The org never returned a result, so there is no ` +
        `verdict about this diff -- not a pass and not a failure. A re-run may resolve it.`,
      ...bounded(stderr),
    ]);
  }

  // Rule 2: an exit code plugin-deploy-retrieve does not document means we are not reading
  // this program correctly, and a guess would be a verdict about nothing.
  return unjudged(id, 'content', [
    `${id}: \`sf project deploy validate\` exited ${exitCode}, which is not one of the exit codes ` +
      `the Salesforce deploy plugin documents (0 Succeeded, 1 Failed/Canceled, 68 SucceededPartial, ` +
      `69 InProgress/Pending). An undocumented exit code is not a pass, so this is reported as ` +
      `unjudged.`,
    ...bounded(stderr, stdout),
  ]);
}

export function createDeployValidateGate(deps: OrgGateDeps = {}): Gate {
  const id = DEPLOY_VALIDATE_GATE_ID;
  return {
    id,
    async run(ctx: GateContext): Promise<GateResult> {
      const preamble = await prepareOrg(id, ctx, deps);
      if (preamble.kind === 'stop') return preamble.result;

      const exec = deps.exec ?? runCommand;
      // Checked HERE rather than at the top of `run`, so that a repo this gate does not apply to
      // -- or a diff with no Salesforce source in it -- gets that answer first. The price is one
      // login on a tenant whose config is permanently unusable; the alternative is telling a Node
      // repo its Salesforce test level is wrong.
      const choice = effectiveTestLevel(ctx.config);
      if (choice.kind === 'unsupported') {
        return skip(id, 'invalid-config', [
          `${id} did not run: testLevel "${choice.requested}" needs a \`--tests\` list of specific ` +
            `Apex classes, and this gate has none to pass -- it would validate nothing on every diff. ` +
            `Choose one of ${DEPLOY_TEST_LEVELS.join(', ')}. Nothing was asserted about this diff, and ` +
            `nothing will be asserted about the next one either until the config changes.`,
        ]);
      }
      const testLevel = choice.level;
      const provenance = describeProvenance(preamble.provenance);
      // `validate` is check-only by construction: it uploads and compiles the package in the
      // org and never commits it. There is no `--dry-run` on this command and none is needed.
      const args = [
        'project',
        'deploy',
        'validate',
        '--target-org',
        preamble.alias,
        ...preamble.roots.flatMap((root) => ['--source-dir', root]),
        '--test-level',
        testLevel,
        '--wait',
        String(WAIT_MINUTES),
        '--json',
      ];

      let exitCode: number;
      let stdout: string;
      let stderr: string;
      try {
        ({ exitCode, stdout, stderr } = await exec(preamble.bin, args, ctx.workspaceRoot, {
          timeoutMs: COMMAND_TIMEOUT_MS,
        }));
      } catch (err) {
        // runCommand rejects only on a spawn failure, a timeout or an output-budget overrun --
        // all of which MIGHT clear on a re-run, hence `infra` and its bounded gate-only retry.
        return unjudged(id, 'infra', [
          `${id} could not run \`sf project deploy validate\`: ` +
            `${redactSecrets(err instanceof Error ? err.message : String(err))}. Nothing was validated ` +
            `against the org.`,
        ]);
      }


      return classifyDeployExit({
        id,
        exitCode,
        stdout,
        stderr,
        roots: preamble.roots,
        provenance,
        testLevel,
      });
    },
  };
}
