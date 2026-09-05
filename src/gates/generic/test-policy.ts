// `test-policy` gate: tests-present policy. A changed, non-exempt source file must have a
// matching test file changed in the same diff -- "matching" means the same path with a test
// marker (".test."/".spec.") inserted before the extension. Pure over
// GateContext.changedFiles + config, plus one filesystem probe described below. See #77.
//
// THE FAILURE MODE THIS FILE NOW GUARDS AGAINST IS ITS OWN: the defaults below describe a
// single-package TypeScript layout (`src/`, `.ts`). A tenant whose repo has no `src/` -- a
// Next.js monorepo of `apps/`+`packages/`, a repo whose logic is `scripts/*.sh` -- matched
// ZERO files on every PR and the gate reported a green `pass` for a check that could not
// fail. A gate cannot tell the operator it is misconfigured if it reports the same thing
// when it works and when it is pointed at nothing.
//
// So a zero-match is now a first-class outcome, never a pass, and the two causes are graded
// differently because their remedies are different:
//
//   - The configured sourceDirs do not exist in the checkout at all -> `unjudged` +
//     `unjudgedReason: 'content'`. The gate is pointed at a layout this repo does not have
//     and can NEVER match a file, on this PR or any other. `unjudged` maps to a blocking
//     `fail` in run-gate-stage's toCheckStatus AND tags the check so the fix loop escalates
//     it to a human at once instead of burning fix rounds no edit can resolve (fix-loop's
//     isContentUnjudged) -- which is the correct route for a defect that lives in tenant
//     config, not in the diff.
//
//     This was a `skip` in the first cut of this change, on the reasoning that the
//     never-fired ledger would raise it, and that must not be re-attempted. A skip here is
//     STILL not an escalation: `toCheckStatus` maps it to `pending` rather than a failure, so
//     the finding renders nowhere (fix-loop and deploy-watch render findings only for `fail`)
//     and the gate becomes a silent no-op. Converting a false green into a silent no-op is not
//     a fix. The ledger's reach has since grown -- a skip tagged `invalid-config` now alarms
//     (`gate_config_invalidated`) and drops out of the regression set even for a gate with a
//     long verdict history, where before `lastRealVerdictAt` being sticky forever
//     silenced every signal -- but an operator alarm on a merged promotion is a different thing
//     from blocking the PR that broke it, which is what this defect needs.
//
//   - The dirs exist but this diff touched none of them (a docs-only PR) -> `skip` +
//     `no-matching-files`. Honest for one PR, and the non-benign reason keeps it out of the
//     promotion coverage record.
//
// THE SECOND DEFECT, FIXED HERE: THE COMPANION MODEL WAS A MARKER SPLICE.
//
// `companionsFor` used to build the expected test path by splicing a marker in before the
// extension -- `src/foo/bar.ts` -> `src/foo/bar.test.ts` -- and that is the ONLY shape it could
// express. It works for JS/TS, where the test sits next to the source, and it is structurally
// incapable of expressing the near-universal Python layout, where it does not:
//
//     <pkg>/collectors/reader.py   ->   tests/test_reader.py
//
// The test moves to a DIFFERENT DIRECTORY and takes a PREFIX, not a suffix. No value of
// `sourceDirs`, `sourceExtensions`, `testMarkers` or `exemptSuffixes` could name it, which is why
// the Python tenant runbook lists this gate as a hard blocker for the live Python tenant and why
// docs/language-support-extension-points.md §3 says the model itself has to change.
// `blocking:false` was NOT an available workaround: an `unjudged` gate always blocks
// (run-gate-stage's `ok` predicate), so the tenant needed BOTH a `sourceDirs` that exists AND
// `blocking:false` just to stop the gate wedging every PR -- two coupled config edits to buy a
// gate that then asserted nothing.
//
// So the marker splice is replaced by a COMPANION TEMPLATE -- a pattern pair rather than a splice.
// A template is a path with four placeholders, all derived from the source file and the source
// root it matched:
//
//     {root}  the matched sourceDir, with its trailing slash ('' for a '.' root)
//     {dir}   the path between the root and the file, with a trailing slash, or '' at the root
//     {name}  the basename without its extension
//     {ext}   expanded over every configured sourceExtension (see below)
//
//     TS  '{root}{dir}{name}.test{ext}'   src/a/b.ts  -> src/a/b.test.ts     (the old behaviour,
//                                                                             exactly)
//     PY  'tests/{dir}test_{name}{ext}'   pkg/c/d.py  -> tests/c/test_d.py
//     PY  'tests/test_{name}{ext}'        pkg/c/d.py  -> tests/test_d.py     (the live tenant's)
//
// Backwards compatibility is not a promise about the config format, it is a derivation: when a
// tenant supplies `testMarkers` and no `companionTemplates`, the SUFFIX markers (the ones ending
// in '.', which is all the splice model could ever mean) are turned back into templates. A tenant
// that never heard of this change gets byte-identical behaviour.
//
// THE THIRD THING THIS FILE LEARNED: STACK-DRIVEN DEFAULTS. `sourceDirs: ['src/']` is a fact about
// a TypeScript repo, and it is the value that produced the blocking `unjudged` on the Python
// tenant. When `ctx.stackProfiles` reports a Python tree, the defaults come from the DETECTOR --
// the profile's own `sourceRoots` and `testRoots` -- so a `pyproject.toml` repo is gated correctly
// with no tenant config at all. Explicit tenant config still wins, key by key.
//
// THE SAME DEFECT, ONE LANGUAGE OVER: an sfdx repo has no `src/` and no `.ts`, so the stock
// defaults produced that blocking `unjudged` on EVERY PR for a Salesforce tenant -- correct by
// the rules above, useless as a product, because the tenant did nothing wrong and the remedy
// ("point test-policy at this repo's real source roots") is knowledge the runner already has.
// So when the tenant configured NOTHING, the defaults are derived from `ctx.stackProfiles`
// (gates/stack-profile.ts) instead: a `salesforce` profile ADDS its sfdx packageDirectories and
// `.cls`/`.trigger` to the Node defaults. Adding, never replacing -- a Salesforce org with an
// LWC front end is genuinely both ecosystems, and replacing would silently drop policing of the
// half that is still TypeScript. A tenant that DID configure the gate is honoured verbatim, as
// before: stack detection is a fact about the checkout, not a licence to widen a scope an
// operator deliberately narrowed.

import { stat } from 'node:fs/promises';
import path from 'node:path';

import { readGateConfig } from './config.ts';
import { matchesTestMarker } from './structure.ts';
import type { StackProfile } from '../stack-profile.ts';
import type { Gate, GateContext, GateResult } from '../types.ts';

export interface TestPolicyGateConfig {
  sourceDirs: string[];
  sourceExtensions: string[];
  testMarkers: string[];
  exemptSuffixes: string[];
  // The expected test path(s) for a source file, as templates over {root}/{dir}/{name}/{ext}.
  // See the header. A source file passes when ANY of its expanded companions is in the diff.
  companionTemplates: string[];
}

export const DEFAULT_TEST_POLICY_CONFIG: TestPolicyGateConfig = {
  sourceDirs: ['src/'],
  sourceExtensions: ['.ts'],
  testMarkers: ['.test.', '.spec.'],
  exemptSuffixes: ['.d.ts', '/index.ts', '/types.ts'],
  companionTemplates: ['{root}{dir}{name}.test{ext}', '{root}{dir}{name}.spec{ext}'],
};

// ---------------------------------------------------------------------------
// Stack-driven defaults
// ---------------------------------------------------------------------------

// Python's defaults, built from what the DETECTOR found rather than from a convention this file
// asserts. `sourceRoots` is `src/` for a src-layout project and the top-level `__init__.py`
// packages otherwise (stack-profile.ts pythonSourceRoots), which on the live Python tenant is its
// single `<pkg>` root. `testRoots` is `tests`/`test` when present.
//
// EMPTY sourceRoots is the branch that matters: it means "no conventional root is present" (a flat
// repo of `foo.py` + `tests/test_foo.py`), NOT "this repo has no sources". Falling back to the
// TypeScript `['src/']` there would recreate the exact blocking `unjudged` this change removes, so
// it falls back to `'.'` -- the whole checkout -- which always exists and cannot wedge.
export function pythonTestPolicyDefaults(profile: StackProfile): TestPolicyGateConfig {
  const testRoots = profile.testRoots.length > 0 ? [...profile.testRoots] : ['tests'];
  // A TEST ROOT IS NOT A SOURCE ROOT, even when the detector reports it as one. `pythonSourceRoots`
  // returns every top-level directory holding an `__init__.py`, and `tests/__init__.py` is
  // completely ordinary -- so `tests` would arrive here as a source root, and then every helper in
  // it (`conftest.py` is exempt, but an ordinary shared helper -- a fixture builder, a harness --
  // is not) would demand a companion test of its own. Excluding the detected test roots is not
  // second-guessing the detector: it reported both facts, and this gate is the consumer that has to
  // decide which one wins for "things that need a test".
  const detectedTestRoots = new Set(profile.testRoots);
  const sources = profile.sourceRoots.filter((root) => !detectedTestRoots.has(root));
  const sourceDirs = sources.length > 0 ? sources : ['.'];
  const companionTemplates = [
    // The relocating companions: the test lives under a test root, named `test_<module>.py`,
    // either flat or mirroring the source's sub-path.
    ...testRoots.flatMap((root) => [`${root}/test_{name}{ext}`, `${root}/{dir}test_{name}{ext}`]),
    // ...and the colocated ones, for a package that keeps its tests inside itself.
    '{root}{dir}test_{name}{ext}',
    '{root}{dir}{name}_test{ext}',
  ];
  return {
    sourceDirs,
    sourceExtensions: ['.py'],
    // `test_` is a filename PREFIX, matched as one (structure.ts matchesTestMarker) -- a plain
    // substring match would classify `latest_run.py` as a test file.
    testMarkers: ['test_', '_test.'],
    // The Python files that are not "a module that should have a test": package markers, the
    // pytest fixture module, entry points, and generated version stamps.
    exemptSuffixes: ['__init__.py', 'conftest.py', 'setup.py', '__main__.py', '_version.py'],
    companionTemplates,
  };
}

// The defaults for THIS checkout. Ecosystems are UNIONED, never ranked: a repo that is genuinely
// both (a Python service with an LWC or Next.js front end) must police both trees, and
// `stackProfiles` is explicitly not a ranking. Unioning can only ever widen what the gate looks at
// and what it ACCEPTS as a companion -- it can never invent a requirement, which is the same
// argument the multi-extension companion rule already rests on.
//
// Absent/unknown profiles -> the TypeScript default, unchanged. Every gate must behave correctly
// when `stackProfiles` is absent (gates/types.ts), and for this gate "absent" means "nothing was
// detected, so do exactly what you did before".
// The two Apex source extensions, and the only ones. An LWC bundle's `.js`/`.html` lives under
// the same packageDirectory but belongs to the node half of a polyglot repo, which contributes
// its own defaults.
const APEX_SOURCE_EXTENSIONS = ['.cls', '.trigger'] as const;

// Every `.cls` and every LWC bundle carries a metadata sidecar. An API-version bump or a
// visibility change in one is not a code change, and a gate that demands an Apex test class for
// it fails PRs whose policy is satisfied -- which is how a gate gets configured off entirely.
const SALESFORCE_EXEMPT_SUFFIXES = ['.cls-meta.xml', '.js-meta.xml'] as const;

// The defaults BEFORE tenant config, derived from what the checkout actually is.
//
// `stackProfiles` is optional on GateContext and absent means "not detected" (an older caller, a
// hand-built test context) -- never "nothing here" -- so absence falls back to the historic Node
// defaults rather than to a wider or narrower guess. This reads the field only: a gate re-running
// its own filesystem detector would both duplicate the once-per-stage detection and disagree with
// the stack the rest of the run reported.
//
// Ecosystems are UNIONED, never ranked. A repo that is genuinely two things -- a Salesforce org
// with an LWC front end, a Python service with a TypeScript dashboard -- must have both halves
// policed, and replacing rather than adding would silently drop one of them. Unioning can only
// widen what the gate LOOKS AT and what it ACCEPTS as a companion; it never invents a requirement.
export function stackDefaultTestPolicyConfig(stackProfiles?: readonly StackProfile[]): TestPolicyGateConfig {
  const contributions = [
    DEFAULT_TEST_POLICY_CONFIG,
    pythonContribution(stackProfiles),
    salesforceContribution(stackProfiles),
  ].filter((c): c is TestPolicyGateConfig => c !== undefined);
  // Only the Node baseline: nothing else was detected, so there is nothing to add to it.
  if (contributions.length === 1) return DEFAULT_TEST_POLICY_CONFIG;

  const union = (pick: (c: TestPolicyGateConfig) => string[]): string[] => [...new Set(contributions.flatMap(pick))];
  return {
    sourceDirs: union((c) => c.sourceDirs),
    sourceExtensions: union((c) => c.sourceExtensions),
    testMarkers: union((c) => c.testMarkers),
    exemptSuffixes: union((c) => c.exemptSuffixes),
    companionTemplates: union((c) => c.companionTemplates),
  };
}

function pythonContribution(stackProfiles?: readonly StackProfile[]): TestPolicyGateConfig | undefined {
  const python = stackProfiles?.find((profile) => profile.ecosystem === 'python');
  if (!python) return undefined;
  const py = pythonTestPolicyDefaults(python);
  // Python's `'.'` fallback means "no conventional root here, so police the whole checkout" --
  // honest on a Python-ONLY repo, and wrong the moment another ecosystem contributed a REAL root:
  // `asDirPrefix('.')` is `''`, so it would put every file in the repo in scope and make every one
  // of them demand a companion. Unioning may widen what the gate LOOKS AT; it may not invent
  // requirements.
  const alone = !(stackProfiles ?? []).some((p) => p.ecosystem === 'node' || p.ecosystem === 'salesforce');
  return alone ? py : { ...py, sourceDirs: py.sourceDirs.filter((dir) => dir !== '.') };
}

function salesforceContribution(stackProfiles?: readonly StackProfile[]): TestPolicyGateConfig | undefined {
  const roots = (stackProfiles ?? [])
    .filter((profile) => profile.ecosystem === 'salesforce')
    .flatMap((profile) => profile.sourceRoots);
  if (roots.length === 0) return undefined;
  return {
    sourceDirs: roots.map(asDirPrefix),
    sourceExtensions: [...APEX_SOURCE_EXTENSIONS],
    testMarkers: [],
    exemptSuffixes: [...SALESFORCE_EXEMPT_SUFFIXES],
    // Apex companions are matched by BASENAME over the whole diff (apexCompanionsFor), never by
    // template, so this ecosystem contributes none.
    companionTemplates: [],
  };
}

// The name this file used for the same thing before the Salesforce profile landed beside the
// Python one. Kept so neither branch's callers and tests had to churn.
export const stackTestPolicyDefaults = stackDefaultTestPolicyConfig;

// Tenant-editable config rides the signed spec, so a wrong-shape value falls back to the
// default rather than throwing the gate (same discipline as risk.ts). An EMPTY array falls
// back too: an empty sourceDirs or sourceExtensions silently disarms the gate completely,
// which is the exact vacuous pass this file exists to make impossible.
function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.length > 0)
    ? (value as string[])
    : fallback;
}

// Turns the SUFFIX markers of the old splice model back into templates, so a tenant that
// configured `testMarkers: ['.it.']` and nothing else keeps working byte-for-byte. Only markers
// ending in '.' are converted, because a splice is all the old model could express -- a PREFIX
// marker like `test_` had no meaning there (splicing it gives `gmailtest.py`), which is exactly
// the structural gap this change closes.
function templatesFromMarkers(markers: readonly string[]): string[] {
  return markers.filter((marker) => marker.endsWith('.')).map((marker) => `{root}{dir}{name}${marker.slice(0, -1)}{ext}`);
}

// The keys that define this gate's SCOPE. Setting any one of them is the operator saying "I have
// decided what this gate looks at", and the stack-derived defaults then stand down entirely.
const SCOPE_KEYS = ['sourceDirs', 'sourceExtensions', 'testMarkers', 'exemptSuffixes', 'companionTemplates'] as const;

// The stack supplies the defaults ONLY when the tenant scoped nothing. Tenant scope wins WHOLE, not
// key by key: an operator who named this repo's source roots and silently got `force-app/` or a
// detected `<pkg>/` bolted on beside them would be policing a scope nobody approved, and would have
// no way to say "only these". Detection informs the default; it never edits a decision someone made.
//
// Keyed on the SCOPE keys, not on `specConfig` being present at all. `gateConfig['test-policy']`
// also carries `blocking`, which this gate never reads -- so a tenant who set only
// `{blocking: false}` would otherwise discard every stack-derived default and land back on
// `sourceDirs: ['src/']`, which is the blocking `unjudged` wedge at the top of this file, on a repo
// that has no `src/`. Setting an unrelated key must not silently re-scope the gate.
function tenantScopedThisGate(specConfig?: Record<string, unknown>): boolean {
  return specConfig !== undefined && SCOPE_KEYS.some((key) => specConfig[key] !== undefined);
}


export function effectiveTestPolicyConfig(
  specConfig?: Record<string, unknown>,
  stackProfiles?: readonly StackProfile[],
): TestPolicyGateConfig {
  const defaults = tenantScopedThisGate(specConfig)
    ? DEFAULT_TEST_POLICY_CONFIG
    : stackDefaultTestPolicyConfig(stackProfiles);
  const config = readGateConfig(specConfig === undefined ? {} : { 'test-policy': specConfig }, 'test-policy', defaults);
  const testMarkers = normalizeStringArray(config.testMarkers, defaults.testMarkers);
  // A tenant who set `testMarkers` but no `companionTemplates` is speaking the OLD vocabulary;
  // derive their templates from it.
  //
  // Read off the RAW spec, not the merged config: `readGateConfig` layers the spec over the
  // defaults, so `config.companionTemplates` is always populated and a merged read could never
  // tell "the tenant chose these" from "these are the defaults" -- which would make the whole
  // marker-derivation path dead code and silently break a pre-existing `testMarkers` tenant.
  const declaredTemplates = specConfig?.companionTemplates;
  // A tenant who EXPLICITLY set `testMarkers` gets exactly the templates those markers mean -- not
  // a union with the base. Unioning was a silent WIDENING dressed up as compatibility: a tenant on
  // `testMarkers: ['.it.']` would suddenly also accept `foo.test.ts` and `foo.spec.ts` as
  // companions, i.e. the gate would start passing PRs it used to fail. Compatibility means the same
  // verdicts, not more permissive ones.
  //
  // The base is still the fallback when the markers yield nothing -- every configured marker is a
  // PREFIX (`test_`), which the splice model could never express. Falling back beats emitting an
  // empty template list, which would silently disarm the gate for every in-scope file.
  const fromMarkers = templatesFromMarkers(testMarkers);
  const tenantSetMarkers =
    Array.isArray(specConfig?.testMarkers) && (specConfig.testMarkers as unknown[]).length > 0;
  const derived =
    tenantSetMarkers && fromMarkers.length > 0
      ? fromMarkers
      : [...new Set([...fromMarkers, ...defaults.companionTemplates])];
  return {
    sourceDirs: normalizeStringArray(config.sourceDirs, defaults.sourceDirs),
    sourceExtensions: normalizeStringArray(config.sourceExtensions, defaults.sourceExtensions),
    testMarkers,
    // exemptSuffixes is the one list an empty array legitimately means: "exempt nothing".
    exemptSuffixes: Array.isArray(config.exemptSuffixes) && config.exemptSuffixes.every((v) => typeof v === 'string')
      ? (config.exemptSuffixes as string[])
      : defaults.exemptSuffixes,
    companionTemplates: normalizeStringArray(declaredTemplates, derived),
  };
}

// --- Apex ---
//
// Apex has no sibling-path test convention to splice a marker into: `Foo.test.cls` is not a
// thing any org deploys. A test is an ordinary class marked `@isTest`, named for the class it
// covers, and it is matched HERE BY BASENAME ANYWHERE IN THE DIFF for two reasons:
//   - An Apex class name is globally unique within an org (there are no packages or folders in
//     the runtime namespace), so a basename carries no path ambiguity to resolve.
//   - A TRIGGER lives in `triggers/` while its test class must be a class, in `classes/`. A
//     sibling-path model cannot express that at all -- it would demand
//     `triggers/OrderTriggerTest.cls`, a file the platform will not accept -- so it would fail
//     every trigger PR whose test exists.
// This is keyed off the file extension, not off which config path produced it: the naming
// convention is a fact about the language, so a tenant that configures `.cls` by hand gets the
// same (correct) model rather than the marker splice.
function isApexSource(file: string): boolean {
  return APEX_SOURCE_EXTENSIONS.some((ext) => file.endsWith(ext));
}

function apexCompanionsFor(file: string): string[] {
  const ext = APEX_SOURCE_EXTENSIONS.find((candidate) => file.endsWith(candidate))!;
  const base = path.posix.basename(file).slice(0, -ext.length);
  // Always `.cls`: a test is a class even when the thing under test is a trigger.
  return [`${base}Test.cls`, `${base}Tests.cls`, `${base}_Test.cls`, `Test${base}.cls`];
}

// The same four shapes read backwards, so a changed `OrderServiceTest.cls` is recognised as a
// test and does not itself demand a test of its own -- the substring `testMarkers` match below
// never fires for Apex, and without this every test class in the diff would be reported as an
// uncovered source file.
function isApexTestFile(file: string): boolean {
  const name = path.posix.basename(file);
  return /^(?:Test.+|.+(?:_Test|Tests|Test))\.cls$/.test(name);
}

// Exported so the cross-gate invariant suite can drive THIS selector rather than a
// re-implementation of it -- a proxy would still pass if this gate stopped calling
// `matchesTestMarker`, which is the exact drift that suite exists to catch.
export function isTestPolicyTestFile(file: string, testMarkers: string[]): boolean {
  return isApexTestFile(file) || testMarkers.some((marker) => matchesTestMarker(file, marker));

}

function isExempt(file: string, exemptSuffixes: string[]): boolean {
  return exemptSuffixes.some((suffix) => file.endsWith(suffix));
}

// A directory prefix always ends at a path separator. Without this, `sourceDirs: ['source']`
// matches `sourcemaps/a.ts` -- the gate would then police files in a directory the tenant
// never named, and (worse) report a scope it does not have.
//
// `.` / `./` / `` are the WHOLE CHECKOUT and resolve to the empty prefix. That root exists in
// every repo, which is the point: it is what a flat Python project (`foo.py` at the root, tests in
// `tests/`) falls back to instead of the TypeScript `src/`, whose absence produces the blocking
// `unjudged` at the top of this file.
function asDirPrefix(dir: string): string {
  const trimmed = dir.replace(/^\.\/+/, '');
  if (trimmed === '' || trimmed === '.') return '';
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
}

function isInScope(file: string, config: TestPolicyGateConfig): boolean {
  return (
    config.sourceDirs.some((dir) => file.startsWith(asDirPrefix(dir))) &&
    config.sourceExtensions.some((ext) => file.endsWith(ext))
  );
}

// Expands the companion templates for one source file. `src/foo/bar.ts` with
// '{root}{dir}{name}.test{ext}' -> `src/foo/bar.test.ts`; `<pkg>/collectors/reader.py`
// with 'tests/test_{name}{ext}' -> `tests/test_reader.py`.
//
// The companion may carry ANY configured source extension, not only the changed file's own:
// a test harness is routinely written in a different language from the thing it tests (a
// shell suite covering a python script, a `.ts` spec covering a `.js` module). With the
// single-extension default this is exactly the old same-extension behaviour; it only widens
// for a tenant that configures more than one extension, and widening can only ever ACCEPT a
// test that exists, never invent a requirement.
//
// A file that matches no configured extension, or no configured source root, yields NO companions
// -- and the caller treats "no companions" as "nothing to demand", never as "the test is missing".
export function companionsFor(file: string, config: TestPolicyGateConfig): string[] {
  const ext = config.sourceExtensions.find((candidate) => file.endsWith(candidate));
  if (ext === undefined) return [];
  // The LONGEST matching root wins, so `sourceDirs: ['.', 'pkg']` resolves `pkg/a.py` against
  // `pkg/` (giving `{dir}` = '') rather than against the whole checkout (`{dir}` = 'pkg/'). A
  // shorter root would silently change every relocating companion's shape.
  const root = config.sourceDirs
    .map(asDirPrefix)
    .filter((prefix) => file.startsWith(prefix))
    .sort((a, b) => b.length - a.length)[0];
  if (root === undefined) return [];
  const rest = file.slice(root.length);
  const slash = rest.lastIndexOf('/');
  const dir = slash === -1 ? '' : rest.slice(0, slash + 1);
  const name = rest.slice(slash + 1, rest.length - ext.length);
  return [
    ...new Set(
      config.companionTemplates.flatMap((template) =>
        config.sourceExtensions.map((candidate) =>
          template
            .replaceAll('{root}', root)
            .replaceAll('{dir}', dir)
            .replaceAll('{name}', name)
            .replaceAll('{ext}', candidate),
        ),
      ),
    ),
  ];
}

// A source root is a REPO-RELATIVE directory. An absolute path or one that climbs out of the
// checkout is not a misdirected root, it is an invalid one -- and left unclamped it is worse
// than useless: `sourceDirs: ['/tmp/']` stats a directory that exists on every runner, so the
// probe below would report the healthy `no-matching-files` forever and permanently hide the
// misconfiguration it exists to surface.
async function isDirectoryInCheckout(root: string, dir: string): Promise<boolean> {
  const base = path.resolve(root);
  const target = path.resolve(base, dir);
  if (target !== base && !target.startsWith(base + path.sep)) return false;
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

export function createTestPolicyGate(): Gate {
  return {
    id: 'test-policy',
    async run(ctx: GateContext): Promise<GateResult> {
      const config = effectiveTestPolicyConfig(
        ctx.config['test-policy'] as Record<string, unknown> | undefined,
        ctx.stackProfiles,
      );
      const changed = new Set(ctx.changedFiles);
      const changedNames = new Set(ctx.changedFiles.map((file) => path.posix.basename(file)));

      // Exemption is part of scope, not a step inside the loop: a diff of nothing but exempt
      // files (`src/index.ts`, `src/types.ts`) asserts exactly as much as a diff of no source
      // files at all, and reporting "examined 2 in-scope source file(s)" for it is the same
      // examined-nothing-and-said-pass ambiguity in miniature.
      const inScope = ctx.changedFiles.filter(
        (file) =>
          !isTestPolicyTestFile(file, config.testMarkers) &&
          isInScope(file, config) &&
          !isExempt(file, config.exemptSuffixes),
      );

      if (inScope.length === 0) {
        const present: string[] = [];
        for (const dir of config.sourceDirs) {
          if (await isDirectoryInCheckout(ctx.workspaceRoot, dir)) present.push(dir);
        }
        const checkoutReadable = await isDirectoryInCheckout(ctx.workspaceRoot, '.');

        // No configured source root exists in a checkout we CAN read: the gate is pointed at
        // a layout this repo does not have. Blocking and escalated, not skipped -- see header.
        if (present.length === 0 && checkoutReadable) {
          return {
            id: 'test-policy',
            status: 'unjudged',
            unjudgedReason: 'content',
            findings: [
              `test-policy examined 0 of ${ctx.changedFiles.length} changed file(s): none of its configured ` +
                `sourceDirs [${config.sourceDirs.join(', ')}] exist in ${ctx.repoId}, so this gate can never ` +
                `match a file on any PR and has no verdict to give. This is a tenant gate-config defect, not a ` +
                `defect in this diff: point test-policy at this repo's real source roots ` +
                `(packConfig.gateConfig["test-policy"].sourceDirs) and re-run.`,
            ],
          };
        }

        // The roots exist (or the checkout could not be read, so the probe proves nothing and
        // must not accuse the config). The most this run can honestly claim is that today's
        // diff missed them.
        return {
          id: 'test-policy',
          status: 'skip',
          skipReason: 'no-matching-files',
          findings: [
            `test-policy examined 0 of ${ctx.changedFiles.length} changed file(s): none are under ` +
              `[${config.sourceDirs.join(', ')}] with extension [${config.sourceExtensions.join(', ')}] ` +
              `(excluding exempt paths [${config.exemptSuffixes.join(', ') || 'none'}]). ` +
              `Nothing was asserted on this PR.`,
          ],
        };
      }

      const findings: string[] = [];
      for (const file of inScope) {
        // Apex is matched by BASENAME over the whole diff; every other language goes through the
        // companion templates. An Apex source change with no test class in the diff still FAILS --
        // the naming model is different, the policy is not weaker.
        if (isApexSource(file)) {
          const companions = apexCompanionsFor(file);
          if (!companions.some((name) => changedNames.has(name))) {
            findings.push(
              `"${file}" changed without a matching test file (expected an @isTest class named one of: ` +
                `${companions.join(', ')}, anywhere in the diff)`,
            );
          }
          continue;
        }

        const companions = companionsFor(file, config);
        if (companions.length > 0 && !companions.some((c) => changed.has(c))) {
          findings.push(
            `"${file}" changed without a matching test file (expected one of: ${companions.join(', ')})`,
          );
        }
      }

      if (findings.length > 0) return { id: 'test-policy', status: 'fail', findings };

      // A pass says how much it examined, so "examined 12 files and found no problems" can
      // never be mistaken for the "examined 0 files" outcomes above. Findings on a pass are
      // inert downstream (only failing checks' findings reach PR comments and fix briefs);
      // they land in the runner log and the gate report, which is where an auditor looks.
      return {
        id: 'test-policy',
        status: 'pass',
        findings: [
          `test-policy examined ${inScope.length} in-scope source file(s) of ${ctx.changedFiles.length} changed`,
        ],
      };
    },
  };
}
