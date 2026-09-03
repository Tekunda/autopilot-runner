// HOW THE SALESFORCE PROFILE SELECTS GATES. This is the one place the Salesforce gates read
// the detected stack, and the answer to "how does an sfdx-project.json repo get the Salesforce
// gate set with zero hand configuration".
//
// The shape of the problem first, because it rules out the obvious design. Gate SELECTION
// happens in `packs/registry.ts enabledGateSpecs`, which runs CONTROL-PLANE side and signs the
// result into the grant. The control plane cannot see the checkout -- that is the whole point
// of the split plane -- so it cannot possibly know a repo is Salesforce. And `stackProfiles` is
// deliberately NOT in the signed grant for exactly the same reason (gates/types.ts: it is a
// filesystem-derived fact assembled runner-side, diagnostic and never authorization).
//
// So the selection cannot happen where gates are chosen. It happens where they RUN:
//
//   - Every Salesforce gate is registered unconditionally, alongside the generic gates, so the
//     control plane always signs a spec for it and no tenant has to ask for one. That is the
//     zero-configuration half.
//   - Each gate then reads `ctx.stackProfiles` at run time and, on a repo with no `salesforce`
//     profile, returns `skip` with `no-config` -- the existing reason for "this gate has
//     nothing to do here", and the same route cve.ts takes for a tree with no Node manifest.
//     A Node-only tenant therefore sees a benign skip, not a failure and not a fake pass.
//
// `no-config` is REUSED rather than a new `not-applicable` SkipReason being minted, on
// purpose: the benign/suspicious split in control-plane/gate-verdict-ledger.ts is keyed off
// that union, so a new member would be an unknown value to the ledger until it is taught
// about, and an untaught skip reason is how a perpetually-skipping gate gets banked as
// coverage. Reusing the reason the ledger already classifies correctly is the smaller and
// safer change.
//
// ABSENT `stackProfiles` IS NOT "NOT SALESFORCE". The field is optional and absence means "not
// detected" -- an older caller, or a hand-built context. Treating that as "no Salesforce here"
// would silently switch the entire gate set off on any run whose detection did not populate,
// which is a pass banked for a scan that never happened. So absence re-runs `detectStackAt`,
// the SAME detector run-gate-stage uses. That is consuming the one detector from a second
// call site, not writing a second detector; there is still exactly one implementation of
// "what is this repo".

import path from 'node:path';

import { detectStackAt, type StackProfile } from '../stack-profile.ts';
import type { GateContext, GateResult, SkipReason } from '../types.ts';

export type Applicability =
  | { kind: 'applies'; profile: StackProfile }
  // What WAS detected rides along so the skip can name it. "structure found node, not
  // salesforce" is checkable by the person reading it; "not applicable" is not.
  | { kind: 'not-salesforce'; detected: readonly string[] };

export function salesforceApplicability(ctx: GateContext): Applicability {
  let profiles: readonly StackProfile[] = ctx.stackProfiles ?? [];
  if (profiles.length === 0) {
    try {
      profiles = detectStackAt(ctx.workspaceRoot);
    } catch {
      // Detection never throws by contract, but a gate that crashes because it did would take
      // down the stage before it writes gate-report.json. An empty list falls through to the
      // skip below, which is honest: we do not know that this is a Salesforce repo.
      profiles = [];
    }
  }

  const salesforce = profiles.find((profile) => profile.ecosystem === 'salesforce');
  if (salesforce !== undefined) return { kind: 'applies', profile: salesforce };
  return { kind: 'not-salesforce', detected: profiles.map((profile) => profile.ecosystem) };
}

// The benign "there is no Salesforce here" skip every Salesforce gate returns on a Node,
// Python or unknown repo.
export function notSalesforceSkip(id: string, applicability: Extract<Applicability, { kind: 'not-salesforce' }>): GateResult {
  const detected = applicability.detected.length > 0 ? applicability.detected.join(', ') : 'nothing';
  return {
    id,
    status: 'skip',
    skipReason: 'no-config',
    findings: [
      `${id} did not run: this checkout has no sfdx-project.json, so it is not a Salesforce ` +
        `project (detected: ${detected}). Nothing was asserted, and nothing was claimed.`,
    ],
  };
}

// A Salesforce repo where the gate COULD apply but its tool was not there. Deliberately NOT a
// pass and deliberately NOT `no-config`: the gate has real work to do on this repo and did not
// do it, so the reason must stay non-benign, keep the gate out of the coverage record, and
// keep `gate_never_fired` reachable for a gate that never once produces a verdict.
//
// `unjudgeable-language` is the right member of the existing union for this: the gate ran and
// found itself unable to judge the artefacts in front of it. It is diff/environment-scoped
// rather than a permanent config fault, which is what `invalid-config` would wrongly promise
// the control plane (gates/types.ts is explicit that `invalid-config` may only come from a
// decision made on CONFIG ALONE).
export function toolAbsentSkip(id: string, reason: string): GateResult {
  return {
    id,
    status: 'skip',
    skipReason: 'unjudgeable-language',
    findings: [
      `${id} asserted NOTHING on this Salesforce repo: ${reason} This is reported as a skip, ` +
        `never as a pass -- a green gate that ran no analysis is worse than no gate.`,
    ],
  };
}

// The gate RAN its tool and could not turn the result into a verdict -- an unparseable
// document, an unrecognised shape, an exit code the tool does not document. Blocking, because
// a tool that produced something we cannot read has told us nothing about the code.
export function unjudged(id: string, unjudgedReason: 'infra' | 'content', findings: string[]): GateResult {
  return { id, status: 'unjudged', unjudgedReason, findings };
}

export function skip(id: string, skipReason: SkipReason, findings: string[]): GateResult {
  return { id, status: 'skip', skipReason, findings };
}

// ---------------------------------------------------------------------------
// What the profile says about the tree
// ---------------------------------------------------------------------------

// The sfdx packageDirectories, as the `--workspace` the analysis runs over. Falls back to the
// repo root when the project declares none that survive the checkout -- analysing the whole
// tree is a superset of the right answer, where analysing nothing would be a clean report of
// an empty scan.
//
// THESE ROOTS COME OUT OF THE PR UNDER GATE. `stack-profile.ts salesforcePackageDirs` reads
// them verbatim from `sfdx-project.json`'s `packageDirectories[].path`, a file the branch being
// gated can edit, and they end up as `--workspace` / `--source-dir` arguments and as the root
// of a filesystem walk. So they get the same containment treatment structure.ts gives every
// other PR-authored path ("a `../` entry must not turn a gate into an arbitrary-file reader"):
// a root that is absolute, or that resolves outside the checkout, is DROPPED. `"path": "../.."`
// otherwise passes the detector's existence check and becomes a check-only deploy of, and a
// security scan over, whatever sits above the workspace.
//
// Dropping every root falls back to `['.']` rather than to an empty list: scanning the whole
// checkout is a superset of the intended scope, while scanning nothing would produce a clean
// report of an empty scan -- the outcome this whole file exists to prevent.
export function analysisRoots(profile: StackProfile, workspaceRoot?: string): string[] {
  const declared = profile.sourceRoots.length > 0 ? [...profile.sourceRoots] : ['.'];
  if (workspaceRoot === undefined) return declared;
  const base = path.resolve(workspaceRoot);
  const contained = declared.filter((root) => {
    if (path.isAbsolute(root)) return false;
    const target = path.resolve(base, root);
    return target === base || target.startsWith(base + path.sep);
  });
  return contained.length > 0 ? contained : ['.'];
}

// Roots the checkout declared that this gate refused to use, so a skip or a pass can NAME them
// rather than silently narrowing its own scope.
export function rejectedRoots(profile: StackProfile, workspaceRoot: string): string[] {
  const declared = profile.sourceRoots.length > 0 ? [...profile.sourceRoots] : [];
  const kept = new Set(analysisRoots(profile, workspaceRoot));
  return declared.filter((root) => !kept.has(root));
}

// Does this diff touch anything the Salesforce gates care about? Used to keep a docs-only PR
// from paying for a full org round-trip, and reported as `no-matching-files` (diff-scoped,
// non-benign) rather than as a pass.
// UNAMBIGUOUS Salesforce metadata: an extension that means nothing else in any repo.
//
// `.xml` is deliberately ABSENT and `.js`/`.html`/`.css` are handled separately below. This
// list feeds salesforceSourceOutsideRoots, whose finding is a merge-blocking `unjudged` on a
// gate no tenant can configure narrower -- so a bare `.xml` or `.js` here means an ordinary PR
// touching `jest.config.js`, `pom.xml` or a root `web.config` is declared to be "Salesforce
// source outside the scanned scope" and wedges. Precision costs nothing on the attack this
// check exists to stop, because the thing an attacker must hide is Apex and LWC, and both are
// still covered.
const SALESFORCE_METADATA_EXTENSIONS = [
  '.cls',
  '.trigger',
  '.page',
  '.component',
  '.cmp',
  '.app',
  '.flow-meta.xml',
  '.object-meta.xml',
  '.permissionset-meta.xml',
  // THE SIDECARS, and the rule is ONE LINE: every source extension above gets its `-meta.xml`
  // companion, plus `.js-meta.xml` for the LWC bundle whose `.js` is matched by the bundle rule
  // below rather than by extension. Six above, seven here -- a reader checking the list against
  // the rule should find nothing missing, because a list someone stopped adding to is
  // indistinguishable from a list that is complete.
  //
  // They belong HERE and not under the bundle rule because a PR can change ONLY the sidecar: an
  // `apiVersion` bump on `Foo.cls-meta.xml`, `isExposed` or a new `target` on
  // `orderList.js-meta.xml`. Without them that diff selects no Salesforce gate at all -- the
  // under-inclusion failure, where nothing runs, nothing is banked and nobody is told.
  //
  // THE BAR ANYTHING ADDED HERE HAS TO CLEAR, and the reason all seven clear it: each is a full
  // Salesforce-only suffix, never a bare `.xml`. `pom.xml`, `web.config` and an ordinary
  // `settings.xml` cannot match any of them, so none can wedge an ordinary PR on the
  // merge-blocking `unjudged` this list feeds.
  '.cls-meta.xml',
  '.trigger-meta.xml',
  '.page-meta.xml',
  '.component-meta.xml',
  '.cmp-meta.xml',
  '.app-meta.xml',
  '.js-meta.xml',
] as const;

// Web files are Salesforce source ONLY inside a component bundle, and "inside a bundle" has to
// be tested by the SHAPE the platform requires, not by an `/lwc/` substring.
//
// `lwc` IS A REAL NPM PACKAGE NAME. A bare `/lwc/` test matches `packages/lwc/index.js` and
// `node_modules/lwc/dist/x.js`, and `/aura/` matches any directory somebody called aura. That
// cuts both ways here, because two different callers read this predicate:
//
//   - `salesforceSourceOutsideRoots` turns a match into a merge-blocking `unjudged` on a gate
//     no tenant can configure narrower. OVER-inclusion wedges an sfdx monorepo on a PR touching
//     `packages/lwc/index.js` -- a change the gate has no business having an opinion about.
//   - `touchesSalesforceSource` uses it to decide whether the Salesforce gates run at all.
//     UNDER-inclusion silently skips them on a real Salesforce diff, which is the worse failure:
//     a gate that does not run banks nothing, and nobody is told.
//
// So the rule has to be exact, not merely conservative. The platform's own requirement is that
// a bundle is a FOLDER under `lwc/` or `aura/` holding the files -- `lwc/<name>/<name>.js`,
// `aura/<Cmp>/<Cmp>Helper.js`, `lwc/<name>/__tests__/<name>.test.js`. Every one of those puts
// the file AT LEAST TWO SEGMENTS below the `lwc`/`aura` segment. That single test admits every
// bundle shape -- including the Aura `Helper`/`Controller`/`Renderer` files whose stems
// deliberately do NOT equal their folder, and a `__tests__` subfolder at any depth.
//
// WHAT IT DOES NOT EXCLUDE, stated plainly so nobody reads more into it. The depth test only
// rejects the ONE-segment spelling: `packages/lwc/index.js` and `vendor/aura/x.js` are `false`,
// but `packages/lwc/src/index.js` and `vendor/lwc/dist/engine/engine.js` are `true` -- a checked-in
// copy of the `lwc` npm package outside `node_modules` is indistinguishable BY SHAPE from
// `pkg/lwc/orderList/orderList.js`, and salesforceSourceOutsideRoots would report it as a
// merge-blocking `unjudged`. That is accepted rather than patched: separating the two needs
// content or manifest heuristics whose own false negatives would land on the UNDER-inclusion
// side, which is the worse direction (see above). `node_modules`/`bower_components`, the one
// place the vendored copy actually lives, is excluded by path below.
const BUNDLE_SEGMENTS = ['lwc', 'aura'] as const;
const BUNDLE_EXTENSIONS = ['.js', '.ts', '.html', '.css'] as const;

// The one shape the two-segment rule cannot tell from a real bundle: the `lwc` npm package's own
// installed tree, `node_modules/lwc/dist/x.js`, which puts a file two segments below an `lwc`
// segment exactly as `pkg/lwc/order/order.js` does. A vendored dependency is never a tenant's
// Salesforce source whatever its shape, so it is excluded by path rather than by bundle rule.
// (Committed node_modules is not hypothetical -- structure.ts carries it in
// `forbiddenPathPrefixes` for the same reason.)
const VENDORED_SEGMENTS = ['node_modules', 'bower_components'] as const;

export function isSalesforceSourceFile(file: string): boolean {
  if (SALESFORCE_METADATA_EXTENSIONS.some((ext) => file.endsWith(ext))) return true;
  if (!BUNDLE_EXTENSIONS.some((ext) => file.endsWith(ext))) return false;

  const segments = file.split('/');
  if (segments.some((segment) => (VENDORED_SEGMENTS as readonly string[]).includes(segment))) return false;
  // The last segment is the file itself, so a bundle segment must sit at least two positions
  // before it: <...>/lwc/<bundleName>/<file>.
  return segments.some(
    (segment, index) =>
      (BUNDLE_SEGMENTS as readonly string[]).includes(segment) && index <= segments.length - 3,
  );
}

function rootPrefixes(roots: readonly string[]): string[] {
  return roots.map((root) => (root === '.' ? '' : `${root.replace(/\/$/, '')}/`));
}

export function touchesSalesforceSource(changedFiles: readonly string[], roots: readonly string[]): boolean {
  const prefixes = rootPrefixes(roots);
  return changedFiles.some(
    (file) => prefixes.some((prefix) => prefix === '' || file.startsWith(prefix)) && isSalesforceSourceFile(file),
  );
}

// THE SCOPE CROSS-CHECK, and the reason it exists.
//
// `roots` comes out of `sfdx-project.json`, which the branch under gate can edit. A PR that
// repoints `packageDirectories` at a directory containing no Apex gets a scan where every guard
// in code-analyzer.ts holds and every one of them is satisfied: the CLI exits 0, `versions`
// lists all four requested engines (they ran -- over nothing), `violations` is PRESENT AND
// EMPTY, so `missingEngines` is empty and the gate returns `pass`. A green security gate over a
// tree nothing looked at, with no rule broken. That is cve.ts's rule 5 -- "the audited tree does
// not get to choose its own advisory source" -- one tool over.
//
// The check that closes it needs no trust in the project file at all: the DIFF says which
// Salesforce sources this PR actually changed, and if any of them fall outside the scanned
// roots then the scan did not cover the change, whatever the roots claim. That is a fact about
// two lists, and the branch cannot edit `changedFiles`.
export function salesforceSourceOutsideRoots(
  changedFiles: readonly string[],
  roots: readonly string[],
): string[] {
  const prefixes = rootPrefixes(roots);
  // A '.' root covers the whole checkout, so nothing can be outside it.
  if (prefixes.includes('')) return [];
  return changedFiles.filter(
    (file) => isSalesforceSourceFile(file) && !prefixes.some((prefix) => file.startsWith(prefix)),
  );
}

// The files that decide WHAT the scanner scans and WHICH RULES it runs. Salesforce Code
// Analyzer v5 auto-discovers `code-analyzer.yml`/`.yaml` from its working directory, and that
// file can disable rules and re-map severities; `sfdx-project.json` decides the scope. A PR
// that edits either is editing its own gate.
//
// Note this is the DIFF-scoped half of the defence. A config file that already exists and this
// diff does not touch is the tenant's committed policy and is honoured (refusing it outright
// would permanently wedge every repo that legitimately has one) -- but the gate says it is in
// force. What is refused is a change to it arriving in the same PR the gate is judging, because
// then the branch is weakening the check that is about to judge it, and no automated verdict
// on that is worth anything.
const SCANNER_CONTROL_FILES = ['code-analyzer.yml', 'code-analyzer.yaml', 'sfdx-project.json'] as const;

export function scannerControlFilesInDiff(changedFiles: readonly string[]): string[] {
  return changedFiles.filter((file) => {
    const base = file.slice(file.lastIndexOf('/') + 1);
    return (SCANNER_CONTROL_FILES as readonly string[]).includes(base);
  });
}

// Flow definitions, which are what the Flow gate exists for. A Flow is executable -- it does
// DML, it calls Apex, it enforces (or fails to enforce) sharing -- so it is a defect surface
// with no compiler and no unit test, and the only thing standing between a broken Flow and
// production is a scanner.
export function changedFlows(changedFiles: readonly string[]): string[] {
  return changedFiles.filter((file) => file.endsWith('.flow-meta.xml'));
}
