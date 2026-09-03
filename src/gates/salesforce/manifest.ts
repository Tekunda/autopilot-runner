// THE PINS. Every external tool the Salesforce gates run is named here once, with the exact
// version, the exact URL it is fetched from, and the SHA-256 of the bytes that must arrive.
// Nothing else in the tree may name a Salesforce tool version -- action.yml provisions by
// running provision-cli.ts, which reads THIS file, so the pin cannot drift from what CI
// installs the way a version duplicated into a YAML step always eventually does.
//
// WHY A CHECKSUM AND NOT JUST A VERSION. A version pin says "this is the package I asked for";
// a checksum says "these are the bytes I got". Between the two sits the registry, the CDN, and
// the network -- and a published npm version can be replaced (unpublish/republish inside the
// 72-hour window, or a registry compromise). The gate that runs a security scanner is exactly
// the wrong place to trust a name resolution, so the bytes are verified before anything from
// them is executed. This is also why provisioning downloads to a FILE and hashes it rather
// than piping a fetch into a shell: `curl | sh` executes bytes it has not finished reading and
// cannot, even in principle, verify them first.
//
// HOW THESE VALUES WERE OBTAINED, so the next person can redo it rather than trust it: each
// tarball was downloaded from the registry, its SHA-512 compared against the `dist.integrity`
// npm publishes for that exact version, and only then was the SHA-256 below computed from the
// same bytes. The chain is registry-signed integrity -> verified bytes -> our digest, not a
// digest of whatever happened to download that day.
//
// BOTH PACKAGES SHIP AN `npm-shrinkwrap.json`. That matters: npm honours a published
// shrinkwrap, so installing from the checksummed tarball resolves the WHOLE dependency tree to
// the versions the publisher locked. Without it, a pinned tarball would still pull unpinned
// transitive dependencies and the pin would be mostly decorative.

export interface ExternalRuntime {
  // The executable that must already exist on the runner. These are NOT provisioned here.
  id: 'java' | 'python3';
  minVersion: string;
  // The Code Analyzer engines that cannot run without it, named so a skip can say which
  // analysis was lost rather than just "a runtime is missing".
  neededBy: readonly string[];
}

export interface PinnedTool {
  id: string;
  packageName: string;
  version: string;
  // The registry tarball. Pinned to the exact version in the path, so the URL alone can never
  // resolve to different bytes than the ones the digest below was taken from.
  url: string;
  sha256: string;
  // Checked alongside the digest. A truncated download whose length is wrong is caught before
  // the hash is computed, which turns "checksum mismatch" -- a scary, ambiguous message that
  // reads like tampering -- into "got 12 bytes, expected 188624", which reads like the network
  // fault it almost always is.
  bytes: number;
  externalRuntimes: readonly ExternalRuntime[];
}

const JAVA: ExternalRuntime = { id: 'java', minVersion: '11.0.0', neededBy: ['pmd', 'cpd', 'sfge'] };
const PYTHON: ExternalRuntime = { id: 'python3', minVersion: '3.10.0', neededBy: ['flow'] };

// The `sf` CLI is provisioned too, not assumed. Code Analyzer is an `sf` PLUGIN, so an
// unpinned host CLI would leave the pinned plugin running on an unpinned oclif runtime and
// plugin API -- the pin would cover the analysis rules but not the program that loads them.
export const SF_CLI: PinnedTool = {
  id: 'sf-cli',
  packageName: '@salesforce/cli',
  version: '2.150.6',
  url: 'https://registry.npmjs.org/@salesforce/cli/-/cli-2.150.6.tgz',
  sha256: '11ede48cb63d613d42acdb16b1622a047666a5cd80eefabdf612f9c53782d50e',
  bytes: 498375,
  externalRuntimes: [],
};

// Salesforce Code Analyzer v5. One tool, several engines: `pmd` (Apex static analysis),
// `eslint` (LWC/Aura JavaScript, via @salesforce/eslint-config-lwc), `retire-js` (known-vulnerable
// JS libraries vendored into static resources), `sfge` (the Salesforce Graph Engine's data-flow
// security analysis) and `flow` (the Flow scanner -- see flow-engine below).
export const CODE_ANALYZER: PinnedTool = {
  id: 'code-analyzer',
  packageName: '@salesforce/plugin-code-analyzer',
  version: '5.16.0',
  url: 'https://registry.npmjs.org/@salesforce/plugin-code-analyzer/-/plugin-code-analyzer-5.16.0.tgz',
  sha256: 'd6b29595d290d261099bff15faddc460a4cac1730c4a238f33afd35403759e91',
  bytes: 188624,
  externalRuntimes: [JAVA, PYTHON],
};

export const PINNED_TOOLS: readonly PinnedTool[] = [SF_CLI, CODE_ANALYZER];

// ---------------------------------------------------------------------------
// Engine selectors
// ---------------------------------------------------------------------------

// The `--rule-selector` strings, taken from each engine's own `getName()`/`NAME` constant --
// NOT from the docs, which spell two of them differently from the code. `retire-js` is
// hyphenated though its package is `code-analyzer-retirejs-engine`, and the flow engine is
// `flow` though its command-line reputation is "flowtest". A wrong selector here does not
// error: Code Analyzer runs the rules that DID match and reports a clean result for the ones
// that did not exist, which is precisely a scan that silently examined less than it claimed.
// That is why these are constants with a provenance comment and not inline strings.
export const ENGINE_PMD = 'pmd';
export const ENGINE_ESLINT = 'eslint';
export const ENGINE_RETIRE_JS = 'retire-js';
export const ENGINE_SFGE = 'sfge';
export const ENGINE_FLOW = 'flow';

// The static-analysis gate's engine set: Apex PMD, LWC ESLint, RetireJS, and the security
// graph engine.
export const STATIC_ANALYSIS_ENGINES: readonly string[] = [
  ENGINE_PMD,
  ENGINE_ESLINT,
  ENGINE_RETIRE_JS,
  ENGINE_SFGE,
];

// The Flow scanner runs as its own gate rather than as a fifth engine in the set above,
// because Flows are a different artefact with a different owner: a Flow defect is fixed by an
// admin in Flow Builder, not by a developer in a `.cls`, and folding it into the code scan
// would put both behind one check status. It needs NO second provisioned tool -- Code Analyzer
// v5 already bundles @salesforce/code-analyzer-flow-engine. `lightning-flow-scanner` (a
// separate sf plugin covering the same surface) was deliberately NOT added: a second download
// is a second pin, a second checksum and a second thing to keep current, for rules the tool
// already provisioned here can run.
export const FLOW_ENGINES: readonly string[] = [ENGINE_FLOW];

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

// Code Analyzer's `SeverityLevel`: Critical=1, High=2, Moderate=3, Low=4, Info=5. ONE IS THE
// WORST -- the scale runs the opposite way to every other severity in this repo (cve.ts ranks
// low=0 .. critical=3), which is exactly the kind of inversion that produces a gate that
// blocks on `Info` and passes on `Critical`. Named constants, never a bare number in a
// comparison.
export const SEVERITY_CRITICAL = 1;
export const SEVERITY_HIGH = 2;
const SEVERITY_MODERATE = 3;
const SEVERITY_LOW = 4;
export const SEVERITY_INFO = 5;

export const SEVERITY_NAMES: ReadonlyMap<number, string> = new Map([
  [SEVERITY_CRITICAL, 'Critical'],
  [SEVERITY_HIGH, 'High'],
  [SEVERITY_MODERATE, 'Moderate'],
  [SEVERITY_LOW, 'Low'],
  [SEVERITY_INFO, 'Info'],
]);

// Default blocking threshold: a violation at or ABOVE this severity (i.e. a NUMERICALLY LOWER
// or equal level) fails the gate. Moderate matches Code Analyzer's own `Recommended` tag
// posture and keeps the first Salesforce tenant from drowning in Low/Info noise on day one.
//
// SEVERITY_MODERATE and SEVERITY_LOW are intentionally NOT exported: the two levels callers
// actually compare against are the ends of the scale (range-checking an unrankable severity)
// and this policy default. Exporting a second public name for the same number is what knip
// flags as a duplicate export, and it invites two spellings of one threshold.
export const DEFAULT_SEVERITY_THRESHOLD = SEVERITY_MODERATE;
