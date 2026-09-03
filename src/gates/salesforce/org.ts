// THE ORG CREDENTIAL. One Salesforce gate -- `salesforce-deploy-validate` -- needs a real
// Salesforce org: its check-only deploy compiles the PR's metadata and runs the org's local Apex
// tests against it, and that can only happen IN the org, because that is the only place an Apex
// compiler or an Apex test runner exists. (`salesforce-apex-test` used to be the second; index.ts
// records why it was deleted.) So this file is where a secret meets a subprocess, and it follows
// the discipline this repo already established for MCP server tokens rather than inventing one.
//
// THE EXISTING MECHANISM, reused exactly. `McpServerSpec.authEnvVar` (contracts/types.ts) is
// "the NAME of the env var holding the token, never the value", and runner/mcp-config.ts
// renders it into a `${NAME}` placeholder so "no secret ever appears in the grant, the config
// file, or any log". The same rule here:
//
//   - Tenant config carries `authUrlEnvVar`, a NAME, under THE org gate's OWN id --
//     `packConfig.gateConfig.salesforce-deploy-validate.authUrlEnvVar`.
//
//     BE PRECISE ABOUT WHAT THAT BUYS, because an earlier draft of this comment overclaimed it.
//     Per-gate ids are the only path that CAN be signed: `packs/registry.ts enabledGateSpecs`
//     signs `config.gateConfig[<gate id>]` and nothing else, so a shared `gateConfig.salesforce`
//     key belongs to no gate and could never ride the grant. But `run-gate-stage.ts` builds
//     `ctx.config` by overlaying signed specs ON TOP OF the unsigned `gate-target` input, and a
//     tenant who configures nothing -- the zero-configuration case this whole profile is built
//     around -- has no signed spec for this gate at all. For that tenant `ctx.config[<gate
//     id>]` IS the unsigned value. So the id does not, on its own, make this decision signed.
//
//     WHAT ACTUALLY HOLDS THE LINE is the namespace confinement below: whoever supplies the
//     name, it must match `^SF(?:DX)?_`, so it can only ever point at a Salesforce variable. It
//     cannot be aimed at `GH_PAT`, `CLAUDE_CODE_OAUTH_TOKEN` or the grant verification key. The
//     per-gate id is correct and worth keeping -- it is what lets a configured tenant sign the
//     choice -- but the allowlist is the control, not the key path.
//   - The grant, the gate config, the gate report and every log line carry that NAME and never
//     the value.
//   - The VALUE is never read into this Node process. Not into a variable, not into an argv
//     array, not into a template string. The gate shells `sh -c` with the variable referenced
//     BY NAME -- `printf '%s' "$SFDX_AUTH_URL" | sf org login sfdx-url --sfdx-url-stdin` -- so
//     the expansion happens inside the child shell, from the environment it inherited.
//
// WHY NOT argv, WHICH WOULD AVOID THE SHELL. Passing the secret as `--sfdx-url <value>` would
// put it in the process command line, which on Linux is world-readable at /proc/<pid>/cmdline
// for the life of the process and is echoed by any `ps` a later step runs. A pipe into stdin
// is the reason `--sfdx-url-stdin` exists. Reading the value into JS to write that pipe would
// also work, but keeping it out of this process entirely is strictly stronger: a value never
// held cannot be logged by an unrelated `catch` that stringifies a context object.
//
// WHY THE NAME IS VALIDATED, AND WHY A POSIX IDENTIFIER IS NOT ENOUGH. The name comes from
// tenant-editable config, and it is INTERPOLATED INTO A SHELL COMMAND (as `"$NAME"`). That is
// the one place a config value reaches shell syntax, so it must be an identifier. But an
// identifier check alone still lets the config NAME AN UNRELATED SECRET: the runner's
// environment also holds `GH_PAT` and `CLAUDE_CODE_OAUTH_TOKEN`, and `authUrlEnvVar: "GH_PAT"`
// would pipe the installation token into `sf org login sfdx-url` -- into a vendor CLI's stdin,
// and into whatever that CLI puts in an error message. So the name is additionally confined to
// the namespace Salesforce itself reserves (`SFDX_*` from the old sfdx CLI, `SF_*` from the sf
// v2 CLI). Every credential this gate could legitimately want already lives there; nothing else
// in the environment does. A name that fails either check is `invalid-config` -- and that reason
// is EARNED here in the way gates/types.ts demands: the decision is made on CONFIG ALONE, is
// permanent until a human edits it, and does not depend on the diff.
//
// WHY A MISSING CREDENTIAL IS A SKIP AND NEVER A PASS. An org-backed gate with no org verified
// nothing about the code. Reporting `pass` would be the exact defect this codebase was burned
// by; reporting `fail` would block every tenant who has not wired an org yet, on a defect that
// is not in their diff. So it is a non-benign `skip` that stays out of the coverage record and
// still raises `gate_never_fired` if it never once produces a verdict.

import { runCommand } from '../exec.ts';
import type { GateResult } from '../types.ts';

// A POSIX environment-variable name IN THE SALESFORCE NAMESPACE, and nothing else. Two jobs in
// one allowlist: the character class is the shell-injection boundary (what a name may contain,
// never a denylist of what an attack needs), and the `SF_`/`SFDX_` prefix is the
// wrong-secret boundary (what a name may POINT AT). Both official spellings fit --
// `SFDX_AUTH_URL` and `SF_ORG_AUTH_URL` -- and `GH_PAT` and `CLAUDE_CODE_OAUTH_TOKEN` do not.
const ORG_AUTH_ENV_NAME = /^SF(?:DX)?_[A-Z0-9_]+$/;

// The default the overwhelming majority of Salesforce CI setups already export. A tenant that
// uses another name sets `authUrlEnvVar` under the gate's own id; a tenant that uses this one
// configures nothing, which is the zero-configuration bar.
export const DEFAULT_AUTH_URL_ENV = 'SFDX_AUTH_URL';

// The alias prefix. Deliberately NOT configurable: it is interpolated into the same shell
// command as the variable name, and every configurable string that reaches shell syntax is
// another thing to validate for no benefit -- nothing outside this gate needs to name the org.
export const ORG_ALIAS_PREFIX = 'autopilot-gate-org';

// ONE ALIAS PER GATE. There is only one org-backed gate today (`salesforce-deploy-validate`), so
// there is NO live race to fix -- this is a guard, not a repair, and the comment says so rather
// than describing a collision that cannot currently happen.
//
// The hazard it forecloses: `gates/run-gates.ts` executes every gate under `Promise.all`, so the
// moment a SECOND org-backed gate is added it reaches `loginToOrg` at the same time as this one.
// A single fixed alias would have them writing the same auth file under the same `SF_DATA_DIR`
// while the other reads it, and an interleaved write -- or a read of a half-written file -- is an
// intermittent login failure, which this module reports as `unjudged`/`content`: merge-blocking
// and escalated straight to a human, for a fault that is purely our own filename collision.
// Deriving the alias from the gate id means that gate cannot reintroduce the race silently; it
// gets a distinct auth file with no thought required, which is exactly why the mechanism stays
// even with one caller.
//
// The argument is always a module-constant gate id; the character filter keeps that structural
// rather than conventional, so no future caller can route config into shell syntax through here.
export function orgAliasFor(gateId: string): string {
  return `${ORG_ALIAS_PREFIX}-${gateId.replace(/[^A-Za-z0-9-]/g, '')}`;
}

export type OrgCredential =
  | { kind: 'named'; envVar: string }
  // No credential is configured/exported. The gate skips; it does not fail and never passes.
  | { kind: 'absent'; reason: string }
  // The configured NAME is not a usable identifier. A config-alone, permanent fault.
  | { kind: 'invalid'; reason: string };

export interface OrgEnv {
  [key: string]: string | undefined;
}

// Resolve the credential to a NAME, checking only that the environment defines it. The value
// is compared against `undefined`/empty and is otherwise never touched, never returned, and
// never logged.
export function resolveOrgCredential(configuredName: unknown, env: OrgEnv): OrgCredential {
  if (configuredName !== undefined && typeof configuredName !== 'string') {
    return {
      kind: 'invalid',
      reason:
        `gateConfig.<this gate's id>.authUrlEnvVar must be the NAME of an environment variable (a ` +
        `string), not a ${typeof configuredName}. It names where the credential lives; it must never ` +
        `BE the credential.`,
    };
  }
  const envVar = configuredName === undefined || configuredName.trim() === '' ? DEFAULT_AUTH_URL_ENV : configuredName.trim();

  if (!ORG_AUTH_ENV_NAME.test(envVar)) {
    return {
      kind: 'invalid',
      reason:
        `gateConfig.<this gate's id>.authUrlEnvVar is "${envVar}", which is not a valid ` +
        `environment-variable name in the Salesforce namespace (${String(ORG_AUTH_ENV_NAME)}, so ` +
        `SFDX_AUTH_URL and SF_ORG_AUTH_URL both fit). This value is interpolated into a shell command, ` +
        `so anything outside the character class is refused rather than quoted and hoped for; and it ` +
        `decides which environment variable is piped into the Salesforce CLI, so a name outside the ` +
        `SF_/SFDX_ namespace -- which is where every credential this gate could legitimately want ` +
        `lives -- is refused rather than allowed to name an unrelated secret.`,
    };
  }

  const value = env[envVar];
  if (value === undefined || value.trim() === '') {
    return {
      kind: 'absent',
      reason:
        `no Salesforce org credential is available: the environment does not define ${envVar}. ` +
        `Export an sfdx auth URL under that name in the workflow that calls this action (or point ` +
        `gateConfig.<this gate's id>.authUrlEnvVar at the SF_/SFDX_ name you use). Until then this ` +
        `gate runs nothing against an org, and reports a skip rather than a pass.`,
    };
  }
  return { kind: 'named', envVar };
}

// An sfdx auth URL carries the refresh token. If one ever reaches a findings array -- from a
// tool echoing its input back in an error, say -- it would land in a PR comment and a gate
// report. Every byte of subprocess output that this file lets through goes past this first.
// Deliberately broad: the cost of over-redacting a diagnostic is a worse error message; the
// cost of under-redacting one is a leaked org.
export function redactSecrets(text: string): string {
  return text
    .replace(/force:\/\/\S+/g, 'force://[redacted]')
    .replace(/\b(?:00D|5Ae)[A-Za-z0-9]{12,}\b/g, '[redacted-salesforce-id]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]');
}

export interface LoginOutcome {
  ok: boolean;
  detail: string;
}

// Authenticate the runner's `sf` against the tenant's org, by NAME, under the CALLER'S OWN
// alias (see `orgAliasFor`: gates run concurrently, so no two of them may share an auth file).
//
// The command is a `sh -c` string on purpose (the rest of this module's subprocesses use argv
// arrays). It is the only way to reference the credential by name and let the CHILD expand it,
// and every substitution into it is either a validated identifier (`envVar`), a constant-derived
// alias, or `sfBin` -- which came from provisioning, not from config.
export async function loginToOrg(
  sfBin: string,
  credential: Extract<OrgCredential, { kind: 'named' }>,
  alias: string,
  cwd: string,
  exec: typeof runCommand = runCommand,
): Promise<LoginOutcome> {
  // `printf '%s'` rather than `echo`: echo's handling of a leading `-` and of backslashes is
  // shell-dependent, and an auth URL mangled by the shell fails authentication in a way that
  // looks like a bad secret.
  const script =
    `printf '%s' "$${credential.envVar}" | ` +
    `"${sfBin}" org login sfdx-url --sfdx-url-stdin --alias ${alias} --json`;
  try {
    const { exitCode, stdout, stderr } = await exec('sh', ['-c', script], cwd, { timeoutMs: 5 * 60 * 1000 });
    if (exitCode === 0) return { ok: true, detail: `authenticated as ${alias} using $${credential.envVar}` };
    return {
      ok: false,
      detail:
        `\`sf org login sfdx-url\` exited ${exitCode} using the credential in $${credential.envVar}. ` +
        `${redactSecrets((stderr || stdout).trim()).slice(0, 1500)}`,
    };
  } catch (err) {
    return {
      ok: false,
      detail: `\`sf org login sfdx-url\` could not run: ${redactSecrets(err instanceof Error ? err.message : String(err))}`,
    };
  }
}

// A login that did not work leaves the gate with no org, so there is nothing to judge. It is
// `unjudged`/`content` rather than `infra`: a rejected or expired credential is not fixed by
// retrying, and `content` routes it straight to a human instead of burning the infra lane's
// bounded retry on a secret only an operator can rotate.
export function loginFailedResult(id: string, detail: string): GateResult {
  return {
    id,
    status: 'unjudged',
    unjudgedReason: 'content',
    findings: [
      `${id} could not reach the Salesforce org, so it verified nothing: ${detail} This is an ` +
        `operator/credential fault rather than a defect in this diff, and it is reported as unjudged ` +
        `rather than passed.`,
    ],
  };
}
