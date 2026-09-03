// Salesforce Code Analyzer v5 as two gates: `salesforce-code-analyzer` (Apex PMD, LWC ESLint,
// RetireJS, and the Salesforce Graph Engine's data-flow security analysis) and
// `salesforce-flow-scan` (the Flow engine). One provisioned tool, two rule selections, two
// check statuses -- see manifest.ts's FLOW_ENGINES for why Flows get their own gate.
//
// THIS FILE IS WRITTEN AGAINST cve.ts's LESSON, which is the most expensive one in this
// codebase: a security gate that runs a tool, gets a document it does not understand, reads a
// missing key as zero findings, and reports `pass`. Every rule below is a way of NOT doing
// that:
//
//   1. `violations` PRESENT AND EMPTY is a clean scan and passes. `violations` ABSENT is a
//      document this parser does not recognise, and is `unjudged` -- never zero findings.
//   2. The requested engines are checked against the `versions` object, which Code Analyzer
//      builds from the engines that actually RAN (core's toJsonVersionObject iterates
//      results.getEngineNames()). An engine that did not run analysed nothing, and a short
//      violation list is then evidence of nothing. This is the false-green path that matters
//      most here, because Code Analyzer does NOT fail when an engine cannot start -- a runner
//      with no JVM reports the engines it could run and says nothing about pmd/sfge.
//   3. Java and Python are probed BEFORE the tool runs (provision.ts probeRuntimes), so the
//      common cause of (2) is caught with a message that names the runtime rather than leaving
//      an operator to work backwards from a missing key.
//   4. A severity outside the documented 1-5 scale is a FINDING, not "below threshold". An
//      unrankable severity that compares false against every threshold is how an advisory
//      silently vanishes.
//   5. The tool is never invoked through a shell. `runCommand(bin, args, cwd)` passes an argv
//      array, so no path, root or selector can be interpreted as shell syntax.
//
// SEVERITY RUNS BACKWARDS from every other severity in this repo: Critical=1 .. Info=5. The
// comparison is therefore `severity <= threshold`, and the constants in manifest.ts exist so
// that inversion is never written as a bare number.

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runCommand } from '../exec.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';
import { scrubbedSubprocessEnv } from './subprocess-env.ts';
import { readGateConfig } from '../generic/config.ts';
import {
  CODE_ANALYZER,
  DEFAULT_SEVERITY_THRESHOLD,
  FLOW_ENGINES,
  SEVERITY_CRITICAL,
  SEVERITY_INFO,
  SEVERITY_NAMES,
  STATIC_ANALYSIS_ENGINES,
} from './manifest.ts';
import {
  analysisRoots,
  notSalesforceSkip,
  rejectedRoots,
  salesforceApplicability,
  salesforceSourceOutsideRoots,
  scannerControlFilesInDiff,
  skip,
  toolAbsentSkip,
  unjudged,
} from './profile.ts';
import {
  blockingRuntimeGaps,
  describeRuntimeGaps,
  probeRuntimes,
  resolveSfCli,
  type SfCliResolution,
} from './provision.ts';

// SFGE compiles the whole package to build its graph, so this is minutes, not seconds, on a
// real org. Below the runner job's own budget so the gate reports a timeout rather than having
// the job killed out from under it with no gate report written.
const ANALYSIS_TIMEOUT_MS = 20 * 60 * 1000;

const PROBE_TIMEOUT_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Is the pinned plugin ACTUALLY the one that will run?
// ---------------------------------------------------------------------------

// THIS PROBE IS NOT DEFENSIVE PROGRAMMING, IT IS THE PIN. Without it the version pin in
// manifest.ts is decorative, and that was verified against the real CLI rather than reasoned
// about:
//
//   `sf code-analyzer run` on a CLI that does NOT have the plugin installed EXITS ZERO. It
//   does not fail; oclif's JIT-install hook silently fetches the plugin from the registry
//   first and then runs it. And the version it fetches is the one pinned in the CLI's OWN
//   `oclif.jitPlugins` -- 5.15.0 in @salesforce/cli 2.150.6 -- which is NOT the version this
//   repo pinned and checksum-verified. So a run where provisioning failed would download an
//   unverified analyser, analyse the code with it, and report a perfectly ordinary verdict.
//   Every guarantee in manifest.ts would be intact on paper and worth nothing.
//
// `sf plugins inspect <name> --json` is the probe: exit 0 with a JSON document naming the
// installed version, exit non-zero when the plugin is absent. Both were confirmed against a
// real provisioned CLI and a bare one.
export type PluginProbe =
  | { kind: 'installed'; version: string }
  | { kind: 'absent'; reason: string };

// The version out of `plugins inspect --json`, which is an ARRAY of plugin descriptors.
export function parsePluginInspect(raw: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  // oclif has shipped both a bare array and a `{result: [...]}` envelope depending on the
  // --json plumbing, so both are accepted; anything else yields undefined (i.e. "cannot tell").
  const list = Array.isArray(parsed)
    ? parsed
    : isObject(parsed) && Array.isArray((parsed as { result?: unknown }).result)
      ? ((parsed as { result: unknown[] }).result)
      : undefined;
  if (list === undefined) return undefined;
  for (const entry of list) {
    if (!isObject(entry)) continue;
    const version = entry.version;
    if (typeof version === 'string') return version;
    const options = entry.options;
    if (isObject(options) && typeof options.version === 'string') return options.version;
  }
  return undefined;
}

async function probePlugin(
  bin: string,
  cwd: string,
  exec: typeof runCommand,
): Promise<PluginProbe> {
  try {
    const { exitCode, stdout } = await exec(
      bin,
      ['plugins', 'inspect', CODE_ANALYZER.packageName, '--json'],
      cwd,
      { timeoutMs: PROBE_TIMEOUT_MS },
    );
    if (exitCode !== 0) {
      return {
        kind: 'absent',
        reason:
          `the Salesforce CLI is present but ${CODE_ANALYZER.packageName} is not installed in it ` +
          `(\`sf plugins inspect\` exited ${exitCode}). Running the analysis anyway would make the ` +
          `CLI JIT-install an unpinned copy of the plugin from the registry and analyse the code ` +
          `with bytes nothing verified, so it is NOT run.`,
      };
    }
    const version = parsePluginInspect(stdout);
    if (version === undefined) {
      return {
        kind: 'absent',
        reason:
          `\`sf plugins inspect ${CODE_ANALYZER.packageName} --json\` returned a document this gate ` +
          `cannot read, so it cannot confirm which analyser would run. It is not run.`,
      };
    }
    return { kind: 'installed', version };
  } catch (err) {
    return {
      kind: 'absent',
      reason: `\`sf plugins inspect\` could not run: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// The report document
// ---------------------------------------------------------------------------

export interface CodeAnalyzerLocation {
  file?: string;
  startLine?: number;
  startColumn?: number;
}

export interface CodeAnalyzerViolation {
  rule: string;
  engine: string;
  severity: number;
  message: string;
  locations: CodeAnalyzerLocation[];
  primaryLocationIndex: number;
}

export type CodeAnalyzerParse =
  | { kind: 'report'; violations: CodeAnalyzerViolation[]; enginesRan: string[] }
  // The document could not be recognised as a Code Analyzer run result. NEVER "no violations".
  | { kind: 'unrecognised'; reason: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// One entry of the `violations` array, or the reason the whole document must be disowned.
// Strict about the three fields a finding cannot be written without, forgiving about the rest.
type ViolationParse =
  | { kind: 'violation'; violation: CodeAnalyzerViolation }
  | { kind: 'unrecognised'; reason: string };

function parseViolation(entry: unknown): ViolationParse {
  if (!isObject(entry)) {
    return { kind: 'unrecognised', reason: 'a Code Analyzer violation entry is not an object' };
  }
  const rule = typeof entry.rule === 'string' ? entry.rule : undefined;
  const engine = typeof entry.engine === 'string' ? entry.engine : undefined;
  const severity = entry.severity;
  if (rule === undefined || engine === undefined || typeof severity !== 'number') {
    return {
      kind: 'unrecognised',
      reason:
        'a Code Analyzer violation is missing its rule, engine or severity. Dropping it would ' +
        'quietly shrink the finding list, so the whole document is reported as unreadable instead.',
    };
  }
  const locations: CodeAnalyzerLocation[] = Array.isArray(entry.locations)
    ? entry.locations.filter(isObject).map((location) => ({
        ...(typeof location.file === 'string' ? { file: location.file } : {}),
        ...(typeof location.startLine === 'number' ? { startLine: location.startLine } : {}),
        ...(typeof location.startColumn === 'number' ? { startColumn: location.startColumn } : {}),
      }))
    : [];
  return {
    kind: 'violation',
    violation: {
      rule,
      engine,
      severity,
      message: typeof entry.message === 'string' ? entry.message : '(no message)',
      locations,
      primaryLocationIndex: typeof entry.primaryLocationIndex === 'number' ? entry.primaryLocationIndex : 0,
    },
  };
}

// Parse the `--output-file *.json` document. Strict about SHAPE and forgiving about DETAIL: a
// missing `startLine` costs a line number in one finding, while a missing `violations` array
// means the whole document is something else and no verdict may be drawn from it.
export function parseCodeAnalyzerReport(raw: string): CodeAnalyzerParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: 'unrecognised',
      reason: `the Code Analyzer output file is not JSON (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  if (!isObject(parsed)) {
    return { kind: 'unrecognised', reason: 'the Code Analyzer output file is not a JSON object' };
  }
  // THE LOAD-BEARING DISTINCTION (cve.ts's ENOLOCK bug, one tool over): a present-but-empty
  // `violations` array is a clean scan; an ABSENT one is a document we do not understand, and
  // `?? []` on it would report that document as a clean scan.
  const rawViolations = parsed.violations;
  if (!Array.isArray(rawViolations)) {
    return {
      kind: 'unrecognised',
      reason:
        'the Code Analyzer output file has no `violations` array. An absent key is not an empty ' +
        'result -- this document is not a run result, so no verdict about the code can be drawn ' +
        'from it.',
    };
  }

  const violations: CodeAnalyzerViolation[] = [];
  for (const entry of rawViolations) {
    const parsedViolation = parseViolation(entry);
    // One unreadable entry disowns the WHOLE document, for the reason parseViolation gives:
    // skipping it would shrink the finding list silently.
    if (parsedViolation.kind === 'unrecognised') return parsedViolation;
    violations.push(parsedViolation.violation);
  }

  // `violationCounts.total` is the tool's OWN count. If it disagrees with the array we just
  // read, we are not reading the document the tool wrote, and a verdict from it would be
  // fiction. Only checked when present -- its absence is not itself proof of anything.
  const counts = parsed.violationCounts;
  if (isObject(counts) && typeof counts.total === 'number' && counts.total !== violations.length) {
    return {
      kind: 'unrecognised',
      reason:
        `the Code Analyzer output file reports ${counts.total} violation(s) but its \`violations\` ` +
        `array holds ${violations.length}. The document is not being read correctly, so no verdict ` +
        `is drawn from it.`,
    };
  }

  // `versions` maps engine name -> version for every engine that RAN (plus the core itself).
  // It is the only place the document says what was actually analysed.
  const versions = parsed.versions;
  const enginesRan = isObject(versions)
    ? Object.keys(versions).filter((name) => name !== 'code-analyzer')
    : [];

  return { kind: 'report', violations, enginesRan };
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

function severityName(severity: number): string {
  return SEVERITY_NAMES.get(severity) ?? `severity ${severity}`;
}

// An unrankable severity is a FINDING, never "below threshold" (cve.ts rule 3). A violation
// carrying a severity outside the documented scale is still a violation the tool reported, and
// filtering it out because the number is odd is how a real defect disappears.
function isBlocking(violation: CodeAnalyzerViolation, threshold: number): boolean {
  if (!Number.isInteger(violation.severity)) return true;
  if (violation.severity < SEVERITY_CRITICAL || violation.severity > SEVERITY_INFO) return true;
  // Backwards scale: 1 is Critical, so "at or above the threshold" is `<=`.
  return violation.severity <= threshold;
}

export function describeViolation(violation: CodeAnalyzerViolation): string {
  const location = violation.locations[violation.primaryLocationIndex] ?? violation.locations[0];
  const where =
    location?.file !== undefined
      ? `${location.file}${location.startLine !== undefined ? `:${location.startLine}` : ''}`
      : '(no location)';
  return `${where} [${violation.engine}/${violation.rule}, ${severityName(violation.severity)}] ${violation.message}`;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface AnalyzerGateConfig {
  // Violations at or above this severity fail the gate. Backwards scale: LOWER is worse.
  severityThreshold: number;
  // Extra `--rule-selector` values, appended to the gate's own engine set. A tenant may widen
  // what is analysed; it may not narrow it, because a gate whose coverage a config can shrink
  // to nothing is a gate that can be configured into a permanent green.
  extraRuleSelectors: string[];
}

function effectiveConfig(id: string, config: Record<string, unknown>): AnalyzerGateConfig {
  const raw = readGateConfig(config, id, {
    severityThreshold: DEFAULT_SEVERITY_THRESHOLD,
    extraRuleSelectors: [] as string[],
  });
  const threshold = raw.severityThreshold;
  return {
    // A wrong-shape or out-of-range threshold falls back to the default rather than throwing
    // (risk.ts's discipline) -- and, critically, never widens to "block nothing".
    severityThreshold:
      typeof threshold === 'number' && Number.isInteger(threshold) && threshold >= SEVERITY_CRITICAL && threshold <= SEVERITY_INFO
        ? threshold
        : DEFAULT_SEVERITY_THRESHOLD,
    extraRuleSelectors: Array.isArray(raw.extraRuleSelectors)
      ? raw.extraRuleSelectors.filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      : [],
  };
}

export interface AnalyzerGateSpec {
  id: string;
  engines: readonly string[];
  // What this gate is FOR, in one clause, used in every finding it writes.
  subject: string;
}

export interface AnalyzerDeps {
  exec?: typeof runCommand;
  env?: NodeJS.ProcessEnv;
  resolve?: (env: NodeJS.ProcessEnv) => SfCliResolution;
}

// ---------------------------------------------------------------------------
// The preflight refusals
//
// Every one of these is a reason NOT to draw a verdict, and each is checked before the analyser
// is allowed to run. They are written as separate functions returning `GateResult | undefined`
// -- undefined meaning "nothing to refuse, carry on" -- so `run` below reads as the ordered
// list of refusals it actually is, and so no single one of them can be lost in the middle of a
// long function.
// ---------------------------------------------------------------------------

// THE BRANCH MAY NOT EDIT ITS OWN SCANNER IN THE PR THE SCANNER IS JUDGING.
// `sfdx-project.json` decides the scope; `code-analyzer.yml` decides which rules run and
// at what severity. A diff that changes either is changing the check that is about to
// judge it, and no automated verdict on that is worth anything -- so it escalates to a
// human instead of being honoured. `content`, not `infra`: re-running changes nothing.
function scannerControlFileRefusal(spec: AnalyzerGateSpec, changedFiles: readonly string[]): GateResult | undefined {
  const controlFiles = scannerControlFilesInDiff(changedFiles);
  if (controlFiles.length === 0) return undefined;
  return unjudged(spec.id, 'content', [
    `${spec.id} did not judge this PR: it changes the analyser's own scope or rules ` +
      `(${controlFiles.join(', ')}). sfdx-project.json's packageDirectories decide what is ` +
      `scanned and code-analyzer.yml decides which rules run, so a verdict produced under ` +
      `configuration this same diff supplied would be a check grading its own homework. ` +
      `A human must review the change to these files.`,
  ]);
}

type ReadySfCli = Extract<SfCliResolution, { kind: 'ready' }>;

type VerifiedAnalyzer =
  | { kind: 'refusal'; result: GateResult }
  | { kind: 'ready'; cli: ReadySfCli; pluginVersion: string };

// Is there an `sf`, does it carry the Code Analyzer plugin, and is that plugin the PINNED one?
async function resolveVerifiedAnalyzer(
  spec: AnalyzerGateSpec,
  ctx: GateContext,
  exec: typeof runCommand,
  env: NodeJS.ProcessEnv,
  resolve: (env: NodeJS.ProcessEnv) => SfCliResolution,
): Promise<VerifiedAnalyzer> {
  // 1. Is the tool there at all? Absence is a skip with a reason, never a pass.
  const cli = resolve(env);
  if (cli.kind === 'absent') return { kind: 'refusal', result: toolAbsentSkip(spec.id, cli.reason) };

  // 2. Is the PINNED plugin the one that would actually run? See probePlugin: without this
  // check a failed provisioning silently JIT-installs an unverified analyser and the pin
  // means nothing.
  const plugin = await probePlugin(cli.bin, ctx.workspaceRoot, exec);
  if (plugin.kind === 'absent') return { kind: 'refusal', result: toolAbsentSkip(spec.id, plugin.reason) };

  // A DIFFERENT VERSION IS NOT THE PINNED TOOL, and this refusal is what actually enforces
  // the pin. Computing the mismatch and then only softening a sentence in the findings left
  // the entire JIT-install defence resting on one binary fact -- that `plugins inspect`
  // exits non-zero when the plugin is absent. That is a fact about somebody else's CLI:
  // `parsePluginInspect` already accommodates two different oclif envelopes, which is
  // evidence this output shape moves, and any oclif release that resolves a declared
  // jitPlugin from `plugins inspect` would silently restore the hole.
  //
  // It is also the posture this same file already takes twice. An engine missing from
  // `versions` is `unjudged` because a short violation list from an analysis that did not
  // happen is evidence of nothing -- and a violation list from a DIFFERENT ANALYSER VERSION
  // has exactly that property, with different rules, different defaults and different bugs.
  // A prose caveat in a green security check is not a control; nobody reads it.
  if (plugin.version !== CODE_ANALYZER.version) {
    return {
      kind: 'refusal',
      result: unjudged(spec.id, 'content', [
        `${spec.id} did not judge this PR: the Salesforce CLI has Code Analyzer ` +
          `${plugin.version}, but this build pinned and checksum-verified ` +
          `${CODE_ANALYZER.version}. A verdict from an analyser whose bytes nothing verified is ` +
          `not this gate's verdict, so none is reported. Re-run provisioning, or bump the pin ` +
          `in src/gates/salesforce/manifest.ts to ${plugin.version} if that is the intended tool.`,
      ]),
    };
  }

  return { kind: 'ready', cli, pluginVersion: plugin.version };
}

// 3. Are the runtimes the requested engines need there? Checked BEFORE running, because
// Code Analyzer's own answer to a missing JVM is a shorter report, not an error.
async function runtimeGapRefusal(
  spec: AnalyzerGateSpec,
  ctx: GateContext,
  exec: typeof runCommand,
): Promise<GateResult | undefined> {
  const gaps = blockingRuntimeGaps(await probeRuntimes(CODE_ANALYZER, ctx.workspaceRoot, exec), spec.engines);
  if (gaps.length === 0) return undefined;
  return toolAbsentSkip(
    spec.id,
    `${describeRuntimeGaps(gaps)}. Code Analyzer does not fail when an engine cannot start -- ` +
      `it reports the engines it could run -- so a verdict here would be drawn from an ` +
      `analysis that never happened.`,
  );
}

// ---------------------------------------------------------------------------
// Reading the report
// ---------------------------------------------------------------------------

// Everything the analysis needs once the preflight refusals are past, carried as one object so
// the helpers below take a subject rather than a parameter list nobody can read.
interface AnalysisRun {
  spec: AnalyzerGateSpec;
  ctx: GateContext;
  config: AnalyzerGateConfig;
  roots: string[];
  dropped: string[];
  cli: ReadySfCli;
  pluginVersion: string;
  exec: typeof runCommand;
  env: NodeJS.ProcessEnv;
}

type CodeAnalyzerReport = Extract<CodeAnalyzerParse, { kind: 'report' }>;

// The two "the scan happened, but not over what you think" refusals, both drawn from a report
// that parsed cleanly. Undefined when the report covers this diff and may be judged.
function coverageRefusal(run: AnalysisRun, parsed: CodeAnalyzerReport): GateResult | undefined {
  const { spec, ctx, roots, dropped } = run;

  // 3. Did every engine we asked for actually run? `versions` names the engines that
  // produced results; one missing analysed nothing, and its silence would read as clean.
  const missingEngines = spec.engines.filter((engine) => !parsed.enginesRan.includes(engine));
  if (missingEngines.length > 0) {
    return unjudged(spec.id, 'content', [
      `${spec.id} asked for the ${spec.engines.join(', ')} engine(s) but the report says only ` +
        `${parsed.enginesRan.join(', ') || 'none'} ran: ${missingEngines.join(', ')} produced no ` +
        `results at all. ${missingEngines.join(', ')} analysed nothing, so a short violation list ` +
        `is evidence of nothing. Reported as unjudged, never as a pass.`,
    ]);
  }

  // THE SCOPE CROSS-CHECK. Everything above verifies the scan RAN; this verifies it ran
  // over THIS DIFF. The roots came from a file the branch can edit, so a PR that repoints
  // packageDirectories at an empty directory satisfies every other guard here -- engines
  // ran, `violations` is present and empty -- and would otherwise pass having looked at
  // nothing. `changedFiles` is not editable by the branch, so comparing the two lists
  // needs no trust in the project file at all. See profile.ts salesforceSourceOutsideRoots.
  const unscanned = salesforceSourceOutsideRoots(ctx.changedFiles, roots);
  if (unscanned.length > 0) {
    return unjudged(spec.id, 'content', [
      `${spec.id} scanned [${roots.join(', ')}] but this PR changes ${unscanned.length} ` +
        `Salesforce source file(s) OUTSIDE that scope: ${unscanned.slice(0, 10).join(', ')}. ` +
        `The scope comes from sfdx-project.json's packageDirectories, which this checkout ` +
        `supplies, so a clean result over roots that exclude the change is evidence about ` +
        `nothing. Point packageDirectories at the metadata this repo actually contains.`,
      ...(dropped.length > 0
        ? [`(${dropped.length} declared root(s) were refused for escaping the checkout: ${dropped.join(', ')})`]
        : []),
    ]);
  }

  return undefined;
}

// The verdict itself, once the report is known to be a real scan of this diff.
function analyzerVerdict(run: AnalysisRun, parsed: CodeAnalyzerReport): GateResult {
  const { spec, ctx, config, roots, dropped, cli, pluginVersion } = run;

  // Code Analyzer v5 auto-discovers `code-analyzer.yml`/`.yaml` from its working directory,
  // and that file can disable rules and re-map severities. One that this diff CHANGES is
  // refused above. One that was already committed is the tenant's own policy and is
  // honoured -- refusing it outright would permanently wedge every repo that legitimately
  // has one -- but a pass must then say it was in force, so the reader does not assume the
  // default rule set produced the result.
  const workspaceConfig = ['code-analyzer.yml', 'code-analyzer.yaml'].find((name) =>
    existsSync(path.join(ctx.workspaceRoot, name)),
  );

  const blocking = parsed.violations.filter((violation) => isBlocking(violation, config.severityThreshold));
  // The version is guaranteed to equal the pin by the refusal above, so what is left to
  // report is whether THIS RUN is the one that verified the bytes. An ambient CLI on a
  // self-hosted runner can carry the right version without our provisioning ever having
  // hashed it; the report says so rather than claiming a check nobody performed.
  const provenance =
    cli.provenance === 'pinned'
      ? `Code Analyzer ${pluginVersion} (checksum-verified)`
      : `Code Analyzer ${pluginVersion} from an ambient CLI this run did not provision, so ` +
        `its bytes were not verified here`;

  if (blocking.length > 0) {
    return {
      id: spec.id,
      status: 'fail',
      findings: [
        `${spec.id} found ${blocking.length} violation(s) at or above ` +
          `${severityName(config.severityThreshold)} in ${spec.subject}, using ${provenance}:`,
        ...blocking.slice(0, 50).map(describeViolation),
        ...(blocking.length > 50 ? [`... and ${blocking.length - 50} more`] : []),
      ],
    };
  }

  // A pass says what it examined and with what, so "scanned 4 engines over force-app and
  // found nothing" can never be mistaken for "ran nothing".
  return {
    id: spec.id,
    status: 'pass',
    findings: [
      `${spec.id} analysed ${spec.subject} under [${roots.join(', ')}] with the ` +
        `${parsed.enginesRan.join(', ')} engine(s) via ${provenance}: ${parsed.violations.length} ` +
        `violation(s) reported, ${blocking.length} at or above ${severityName(config.severityThreshold)}.` +
        // A committed code-analyzer.yml this diff did not touch is the tenant's own policy
        // and is honoured -- but it can disable rules, so a pass must say it was in force
        // rather than let the reader assume the default rule set produced this result.
        (workspaceConfig !== undefined ? ` A committed ${workspaceConfig} was in force.` : '') +
        // A threshold LOOSER than the default (a numerically LOWER level -- the scale is
        // inverted) means fewer violations block. That knob reaches ctx.config through the
        // signed spec when a tenant configured one, and through the UNSIGNED gate-target
        // input when they did not, so a green check must say the bar was lowered rather
        // than let the reader assume the default. Not refused: a tenant legitimately
        // raises the bar during onboarding, and a gate that cannot be tuned gets turned
        // off. Disclosed, so the tuning is visible in the record.
        (config.severityThreshold < DEFAULT_SEVERITY_THRESHOLD
          ? ` NOTE: the blocking threshold was relaxed to ${severityName(config.severityThreshold)}` +
            ` from the default ${severityName(DEFAULT_SEVERITY_THRESHOLD)}, so lower-severity` +
            ` violations did not block.`
          : '') +
        (dropped.length > 0 ? ` ${dropped.length} declared root(s) refused for escaping the checkout: ${dropped.join(', ')}.` : ''),
    ],
  };
}

// Run the analyser and turn its report into a verdict.
async function analyse(run: AnalysisRun): Promise<GateResult> {
  const { spec, ctx, config, roots, cli, exec, env } = run;

  // The report is written OUTSIDE the PR checkout. A coding stage commits `git add -A` over
  // the workspace, so a report file written into it would be committed into the customer's
  // branch.
  let outDir: string;
  try {
    outDir = mkdtempSync(path.join(tmpdir(), 'autopilot-sfca-'));
  } catch (err) {
    return unjudged(spec.id, 'infra', [
      `${spec.id} could not create a temporary directory for the analysis report: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    ]);
  }
  const outFile = path.join(outDir, 'code-analyzer.json');

  const selectors = [...spec.engines, ...config.extraRuleSelectors];
  const args = [
    'code-analyzer',
    'run',
    ...roots.flatMap((root) => ['--workspace', root]),
    ...selectors.flatMap((selector) => ['--rule-selector', selector]),
    '--output-file',
    outFile,
  ];

  try {
    // `--severity-threshold` is deliberately NOT passed: it makes the CLI exit non-zero on
    // a finding, which would conflate "the tool found a violation" with "the tool failed".
    // The threshold is applied here, to a document we have actually read.
    const { exitCode, stdout, stderr } = await exec(cli.bin, args, ctx.workspaceRoot, {
      timeoutMs: ANALYSIS_TIMEOUT_MS,
      // EXPLICIT, SCRUBBED env -- not the inherited one. ESLint loads the analysed
      // project's own config and plugins, and PMD parses its sources, so this subprocess
      // runs code the branch under gate supplied. runCommand passes `env` to execFile only
      // when a caller provides it, so omitting this hands the child the whole of
      // process.env, including the org refresh token in SFDX_AUTH_URL. See
      // subprocess-env.ts.
      env: scrubbedSubprocessEnv(env),
    });

    let raw: string;
    try {
      raw = readFileSync(outFile, 'utf8');
    } catch {
      // No output file at all. If the CLI also exited non-zero, that is the real story.
      return unjudged(spec.id, exitCode === 0 ? 'content' : 'infra', [
        `${spec.id} ran \`sf code-analyzer run\` (exit ${exitCode}) but no report was written to ` +
          `${outFile}, so ${spec.subject} was not analysed. A gate with no report has no verdict; ` +
          `it is NOT a clean scan.`,
        ...(stderr.trim() ? [stderr.trim().slice(0, 2000)] : []),
        ...(stdout.trim() ? [stdout.trim().slice(0, 1000)] : []),
      ]);
    }

    const parsed = parseCodeAnalyzerReport(raw);
    if (parsed.kind === 'unrecognised') {
      return unjudged(spec.id, 'content', [
        `${spec.id} could not read the Code Analyzer result: ${parsed.reason} Reported as ` +
          `unjudged rather than guessed at -- an unparsed scan is not a clean scan.`,
      ]);
    }

    return coverageRefusal(run, parsed) ?? analyzerVerdict(run, parsed);
  } catch (err) {
    // runCommand rejects only on a spawn failure, a timeout, or an output-budget overrun --
    // all of which MIGHT clear on a re-run, hence `infra` and its bounded gate-only retry.
    return unjudged(spec.id, 'infra', [
      `${spec.id} could not run \`sf code-analyzer run\`: ${err instanceof Error ? err.message : String(err)}. ` +
        `${spec.subject} was not analysed.`,
    ]);
  } finally {
    try {
      rmSync(outDir, { recursive: true, force: true });
    } catch (err) {
      /* a leftover temp dir is harmless; it is outside the checkout */
      // Onto the runner log rather than into a finding, though: harmless is not the same as
      // uninteresting, and a tmpdir that cannot be removed says something about the machine
      // that the next confusing run would otherwise have to be debugged without.
      process.stderr.write(
        `${spec.id}: could not remove the report directory ${outDir}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

export function createAnalyzerGate(spec: AnalyzerGateSpec, deps: AnalyzerDeps = {}): Gate {
  return {
    id: spec.id,
    async run(ctx: GateContext): Promise<GateResult> {
      const applicability = salesforceApplicability(ctx);
      if (applicability.kind === 'not-salesforce') return notSalesforceSkip(spec.id, applicability);

      const exec = deps.exec ?? runCommand;
      const env = deps.env ?? process.env;
      const config = effectiveConfig(spec.id, ctx.config);
      const roots = analysisRoots(applicability.profile, ctx.workspaceRoot);
      const dropped = rejectedRoots(applicability.profile, ctx.workspaceRoot);

      const controlFileRefusal = scannerControlFileRefusal(spec, ctx.changedFiles);
      if (controlFileRefusal !== undefined) return controlFileRefusal;

      const analyzer = await resolveVerifiedAnalyzer(spec, ctx, exec, env, deps.resolve ?? resolveSfCli);
      if (analyzer.kind === 'refusal') return analyzer.result;

      const gapRefusal = await runtimeGapRefusal(spec, ctx, exec);
      if (gapRefusal !== undefined) return gapRefusal;

      const { cli, pluginVersion } = analyzer;
      return analyse({ spec, ctx, config, roots, dropped, cli, pluginVersion, exec, env });
    },
  };
}

export function createCodeAnalyzerGate(deps: AnalyzerDeps = {}): Gate {
  return createAnalyzerGate(
    {
      id: 'salesforce-code-analyzer',
      engines: STATIC_ANALYSIS_ENGINES,
      subject: 'Apex, LWC and vendored JavaScript',
    },
    deps,
  );
}

// The Flow gate short-circuits on a diff with no Flow in it: `no-matching-files` is
// diff-scoped and non-benign, so it stays out of the coverage record and cannot be mistaken
// for a Flow scan that found nothing.
export function createFlowScanGate(deps: AnalyzerDeps = {}): Gate {
  const inner = createAnalyzerGate(
    { id: 'salesforce-flow-scan', engines: FLOW_ENGINES, subject: 'Salesforce Flows' },
    deps,
  );
  return {
    id: inner.id,
    async run(ctx: GateContext): Promise<GateResult> {
      const applicability = salesforceApplicability(ctx);
      if (applicability.kind === 'not-salesforce') return notSalesforceSkip(inner.id, applicability);
      // A diff that changes no Flow gets no Flow verdict. Deliberately diff-scoped: the very
      // next PR that touches a Flow is scanned normally with nothing edited.
      if (!ctx.changedFiles.some((file) => file.endsWith('.flow-meta.xml'))) {
        return skip(inner.id, 'no-matching-files', [
          `salesforce-flow-scan examined 0 of ${ctx.changedFiles.length} changed file(s): this diff ` +
            `changes no .flow-meta.xml. Nothing was asserted about Flows on this PR.`,
        ]);
      }
      return inner.run(ctx);
    },
  };
}
