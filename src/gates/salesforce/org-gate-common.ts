// The org preamble shared by the Salesforce gates that need a REAL ORG. Today there is exactly
// one -- `salesforce-deploy-validate`, a check-only deploy of the package's metadata, which also
// runs the org's local Apex tests against THAT metadata. (`salesforce-apex-test` used to sit
// beside it; index.ts records why it was deleted -- it tested the org's already-deployed code
// rather than the diff, duplicating work deploy-validate already does correctly.) Everything
// else in this directory analyses files on disk; this gate does not, and cannot, because there
// is no Apex compiler and no Apex test runner outside a Salesforce org. That is the whole reason
// org.ts exists, and its rules -- credential by NAME, never by value; no org means skip, never
// pass -- are consumed here rather than re-litigated. The preamble stays factored out here
// rather than inlined: it is the contract any future org-backed gate must obey, and the rules
// below are the reason it is a contract and not a helper.
//
// THE FALSE-GREEN PATHS, which are what this file is really about. The command is easy to run
// and easy to mis-read, and every rule below is a way of not reporting a green gate for work
// that did not happen:
//
//   1. NO ORG IS NEVER A PASS. An absent credential, an invalid credential NAME, or a failed
//      login all leave the gate with nothing to judge. They route through org.ts to a
//      non-benign `skip` or to `unjudged`, so the gate stays out of the coverage record and
//      `gate_never_fired` stays reachable.
//   2. AN UNDOCUMENTED EXIT CODE IS NOT A PASS. plugin-deploy-retrieve publishes its exit codes
//      (DEPLOY_STATUS_CODES). Anything outside that set is a program we are not reading
//      correctly, and is `unjudged`.
//   3. "STILL RUNNING" IS NOT A VERDICT. `sf project deploy validate` exits 69 when the deploy
//      is InProgress/Pending/Canceling at the end of `--wait`. There is no result yet, so
//      there is nothing to judge -- `unjudged`/`infra`, because a re-run genuinely may resolve
//      it.
//   4. A DOCUMENT WE CANNOT READ IS NOT "NO FAILURES". The parser never `?? []`s a missing key
//      into an empty failure list (code-analyzer.ts's load-bearing distinction): an absent
//      `result` object or an absent failure list makes the whole envelope unrecognised, never a
//      clean run.
//   5. THE CREDENTIAL VALUE NEVER ENTERS THIS PROCESS. It is referenced by name inside org.ts's
//      `sh -c` login and nowhere else. No argv below carries it, and every byte of subprocess
//      output that reaches a finding goes through `redactSecrets` first, because a tool that
//      echoes its own stdin back in an error would otherwise put an sfdx auth URL into a PR
//      comment.
//
// WHERE THE CREDENTIAL NAME IS CONFIGURED: `authUrlEnvVar` under THE GATE'S OWN ID --
// `packConfig.gateConfig.salesforce-deploy-validate.authUrlEnvVar` -- read below out of
// `ctx.config[<this gate's id>]`, exactly like every other gate's config. Per-gate ids are the
// only path `packs/registry.ts enabledGateSpecs` can sign, since it signs
// `config.gateConfig[<gate id>]` and no gate has the id `salesforce`. That is also why the
// preamble takes the id as an argument rather than hard-coding one: a second org-backed gate
// gets its own signable key for free.
//
// That is NOT the same as saying the value is always signed, and org.ts's header spells the
// difference out: for a tenant who configures nothing, there is no signed spec and
// `ctx.config[<gate id>]` is the unsigned `gate-target` input. The control that holds either
// way is org.ts's `^SF(?:DX)?_` namespace confinement -- the name can only ever be a Salesforce
// variable, never `GH_PAT` or the executor credential.

import { runCommand } from '../exec.ts';
import type { GateContext, GateResult } from '../types.ts';
import { readGateConfig } from '../generic/config.ts';
import { SF_CLI } from './manifest.ts';
import { loginFailedResult, loginToOrg, orgAliasFor, redactSecrets, resolveOrgCredential } from './org.ts';
import {
  analysisRoots,
  notSalesforceSkip,
  salesforceApplicability,
  skip,
  toolAbsentSkip,
  touchesSalesforceSource,
} from './profile.ts';
import { resolveSfCli, type SfCliResolution, type ToolProvenance } from './provision.ts';

// `--wait` is in MINUTES. Two budgets have to nest, in this order:
//
//   WAIT_MINUTES  <  COMMAND_TIMEOUT_MS  <  the runner job's `timeout-minutes`
//
// The first inequality: if Node's subprocess timeout fired first it would kill the CLI before
// the CLI gave up, and the gate would report a spawn failure for a deploy that was merely slow
// -- an infra fault invented by our own clock.
//
// The second is the one that actually bites, and the ceiling it has to fit under is 35 MINUTES,
// not runner.yml's `timeout-minutes: 40`. 40 is a backstop deliberately set ABOVE the real
// deadline (runner.yml says so): the CONTROL PLANE cancels a stage at 35 minutes of wall clock
// (src/service/tenant-adapters.ts), so a gate still waiting at 35 produces no verdict and no
// gate-report.json -- a dead stage, rather than the honest `unjudged` it would have reported. A
// gate whose budget exceeds its stage's does not gate; it just loses.
//
// The arithmetic against 35, with the other big consumers named:
//
//     35   the control plane's wall-clock deadline
//   -  5   checkout, `npm ci`, and the Playwright browser install
//   - 20   Salesforce toolchain provisioning at its CEILING: provision-cli.ts's 10-minute
//          INSTALL_TIMEOUT_MS, twice -- the CLI itself and the code-analyzer plugin
//   -  1   assembling and publishing gate-report.json
//   =  9   left for the gates themselves
//
// One org round-trip has to fit in that 9: 8 minutes of subprocess budget, of which `--wait`
// gets 6 and the remaining 2 cover CLI startup, the org handshake and JSON serialisation. (This
// used to be an argument about two org gates sharing the 9 under `Promise.all`; there is one
// now, and the numbers are unchanged because they were already sized for a single round-trip.) A
// validation that outruns 6 minutes exits 69 and is reported as `unjudged`/`infra` with a retry
// -- honest, and strictly better than the whole stage being cancelled with nothing written.
// Raising these means raising the CONTROL PLANE's 35 first; runner.yml's 40 is not the knob.
export const WAIT_MINUTES = 6;
export const COMMAND_TIMEOUT_MS = (WAIT_MINUTES + 2) * 60 * 1000;

// Findings land in a PR comment, so both the list length and each raw dump are bounded.
export const MAX_LISTED = 50;
const MAX_RAW_OUTPUT = 2000;

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Every string passed here originates in a subprocess, so it is redacted before it can reach a
// finding (rule 5), then bounded.
export function bounded(...parts: string[]): string[] {
  return parts
    .map((part) => redactSecrets(part).trim())
    .filter((part) => part !== '')
    .map((part) => part.slice(0, MAX_RAW_OUTPUT));
}

// ---------------------------------------------------------------------------
// The shared org preamble
// ---------------------------------------------------------------------------

export interface OrgGateDeps {
  exec?: typeof runCommand;
  env?: NodeJS.ProcessEnv;
  resolve?: (env: NodeJS.ProcessEnv) => SfCliResolution;
}

type OrgPreamble =
  | { kind: 'ready'; bin: string; provenance: ToolProvenance; roots: string[]; envVar: string; alias: string }
  // Every non-`ready` outcome already IS the gate's answer, carried out whole so no caller
  // gets to reinterpret "no org" into something greener.
  | { kind: 'stop'; result: GateResult };

// The credential env-var NAME, from THIS GATE'S OWN config key -- the only key the control plane
// signs for it (see the header). `readGateConfig` returns the defaults for a non-object value,
// so a malformed block falls back to org.ts's DEFAULT_AUTH_URL_ENV rather than throwing.
function configuredAuthUrlEnvVar(config: Record<string, unknown>, id: string): unknown {
  return readGateConfig(config, id, { authUrlEnvVar: undefined as unknown }).authUrlEnvVar;
}

export async function prepareOrg(id: string, ctx: GateContext, deps: OrgGateDeps): Promise<OrgPreamble> {
  const applicability = salesforceApplicability(ctx);
  if (applicability.kind === 'not-salesforce') {
    return { kind: 'stop', result: notSalesforceSkip(id, applicability) };
  }
  const roots = analysisRoots(applicability.profile, ctx.workspaceRoot);

  // Before the org is touched at all: does this diff contain anything an org could have an
  // opinion about? A README-only PR in an sfdx repo would otherwise pay a login and a check-only
  // deploy with a full RunLocalTests run to conclude what the file list already said.
  // `no-matching-files` is the diff-scoped, NON-benign reason for a FILE matcher that selected
  // nothing (#402 split it out from the route matcher) -- the gate asserted nothing, so it
  // stays out of the coverage record and `gate_never_fired` stays reachable; it is not a pass.
  if (!touchesSalesforceSource(ctx.changedFiles, roots)) {
    return {
      kind: 'stop',
      result: skip(id, 'no-matching-files', [
        `${id} did not run: none of the ${ctx.changedFiles.length} changed file(s) is Salesforce ` +
          `source under [${roots.join(', ')}], so there is nothing for an org to compile or test. ` +
          `Nothing was asserted about this diff, and nothing was claimed.`,
      ]),
    };
  }

  const env = deps.env ?? process.env;

  // 1. Is `sf` there at all? Absence is a skip with a reason, never a pass.
  const cli = (deps.resolve ?? resolveSfCli)(env);
  if (cli.kind === 'absent') return { kind: 'stop', result: toolAbsentSkip(id, cli.reason) };

  // 2. Is there a credential? Only its NAME is ever resolved; the value is compared against
  // empty inside org.ts and never returned here.
  const credential = resolveOrgCredential(configuredAuthUrlEnvVar(ctx.config, id), env);
  if (credential.kind === 'invalid') {
    // `invalid-config` is EARNED here in the way gates/types.ts demands: the decision was made
    // on CONFIG ALONE, it is the same on every diff, and it stays until a human edits it.
    return {
      kind: 'stop',
      result: skip(id, 'invalid-config', [
        `${id} did not run: ${credential.reason} Nothing was asserted about this diff, and nothing ` +
          `will be asserted about the next one either -- the config itself is unusable.`,
      ]),
    };
  }
  if (credential.kind === 'absent') return { kind: 'stop', result: toolAbsentSkip(id, credential.reason) };

  // 3. Can we actually reach the org? A login that did not work leaves nothing to judge. The
  // alias is this gate's own (org.ts `orgAliasFor`), so a second org-backed gate added later
  // cannot interleave its login with this one's.
  const alias = orgAliasFor(id);
  const login = await loginToOrg(cli.bin, credential, alias, ctx.workspaceRoot, deps.exec ?? runCommand);
  if (!login.ok) return { kind: 'stop', result: loginFailedResult(id, login.detail) };

  return {
    kind: 'ready',
    bin: cli.bin,
    provenance: cli.provenance,
    roots,
    envVar: credential.envVar,
    alias,
  };
}

// "Which tool produced this verdict" is the first question asked of a surprising one.
export function describeProvenance(provenance: ToolProvenance): string {
  return provenance === 'pinned'
    ? `the checksum-verified Salesforce CLI ${SF_CLI.version}`
    : `an ambient Salesforce CLI (not provisioned by this run, so its version is unverified)`;
}
