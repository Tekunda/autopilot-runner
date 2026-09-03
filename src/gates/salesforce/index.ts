// The Salesforce runtime profile's gate set, and the argument for how it is registered.
//
// THE ACCEPTANCE BAR: a repo with an `sfdx-project.json` gets these gates with ZERO hand
// configuration. That single requirement decides the whole design, because of where gate
// selection happens:
//
//   `packs/registry.ts enabledGateSpecs` picks the gates and signs them into the grant, and it
//   runs CONTROL-PLANE side. The control plane cannot see the customer's checkout -- that is
//   the split plane, not an oversight -- so it cannot know a repo is Salesforce. And
//   `stackProfiles` deliberately does not ride in the signed grant for the same reason
//   (gates/types.ts: a filesystem-derived fact assembled runner-side, diagnostic and never
//   authorization).
//
// So selection cannot happen where gates are CHOSEN. It happens where they RUN: every gate
// below is registered unconditionally, and each one reads `ctx.stackProfiles` at run time and
// returns a benign `skip`/`no-config` on a repo that is not Salesforce (see profile.ts).
//
// THE ALTERNATIVE THAT WAS EVALUATED AND REJECTED: making this an entitlement-gated `Pack`
// like `seoPack`. It is cleaner in every respect but one -- `enabledPacks` filters on
// Entitlement, so a non-Salesforce tenant would never sign, run or publish these gates at all,
// and there would be no skip path to write. It was rejected because granting that entitlement
// IS hand configuration, which is exactly the bar this work exists to clear. A Salesforce shop
// must be able to point Autopilot at its repo and get Apex analysis, not file a ticket first.
//
// WHAT THAT COSTS, stated plainly rather than hidden: every non-Salesforce tenant now publishes
// one extra check per gate below, concluded `skipped` (adapters/github/vcs-host.ts concludes a
// `skipped:true` check rather than leaving it in progress, so it cannot wedge a PR), and runs
// one extra no-op gate per gate stage.
//
// AND THE ONE REAL HAZARD IT INTRODUCES, with its mitigation. `no-config` is classified BENIGN
// by control-plane/gate-verdict-ledger.ts, so a gate returning it forever is invisible to
// `gate_never_fired`, to coverage-regression detection, and to every operator alarm. That is
// correct for a gate with genuinely nothing to do -- but it means a bug in DETECTION (a real
// Salesforce repo mis-read as not-Salesforce) would silently disable this entire gate set with
// no alarm anywhere. The mitigation is that `no-config` is used ONLY for "this is not a
// Salesforce repo". Every other way these gates decline to judge -- no provisioned tool, no
// JVM, no org credential, an unreadable report -- is non-benign (`unjudgeable-language`) or
// `unjudged`, so it stays out of the coverage record and still alarms. And detection itself is
// pinned down by fixture-repo.test.ts, which runs the real detector over a real checked-in
// sfdx tree.

import type { Gate } from '../types.ts';
import { createCodeAnalyzerGate, createFlowScanGate } from './code-analyzer.ts';
import { createLwcJestGate } from './lwc-jest.ts';
import { createDeployValidateGate } from './deploy-validate.ts';

// Ordered the way a Salesforce engineer would want to read a failing PR: what the code IS
// (static analysis, Flows), then whether it DEPLOYS AND ITS LOCAL TESTS PASS, then whether its
// LWC unit tests pass. `salesforce-deploy-validate` is the only gate here that needs a real org.
//
// TWO GATES THAT USED TO BE IN THIS LIST WERE DELETED, and recording why is the point of this
// paragraph: a gate that is merely absent gets re-added by the next person who notices the gap.
//
//   `salesforce-osv-lockfile`, an LWC-lockfile dependency audit. #402 landed osv-scanner
//   provisioning in action.yml and taught the GENERIC `cve` gate to use it, so an sfdx repo's
//   `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml` is audited by `cve` exactly like any other
//   tree's. Keeping a Salesforce-specific second scanner would have been the duplicated-audit-tool
//   problem that work exists to end -- two gates, two parsers and two sets of pins over one
//   lockfile -- so the gate was removed instead of wired up.
//
//   `salesforce-apex-test`, an `sf apex run test --test-level RunLocalTests` against the org. It
//   never deployed the PR's metadata first, so its verdict was a fact about what is ALREADY
//   DEPLOYED in the org: identical on every PR, independent of the diff, and able to red a PR
//   over a pre-existing org failure that no edit to the branch could fix. Meanwhile
//   `salesforce-deploy-validate` runs those SAME local tests against the PR's OWN metadata, via
//   the check-only deploy `sf project deploy validate --test-level RunLocalTests`. So apex-test
//   was strictly weaker than a gate we already ship, cost a second org login and a second
//   multi-minute round-trip -- and, worst, its `pass` banked coverage in
//   control-plane/gate-verdict-ledger.ts for a check that never looked at the diff. Banking
//   coverage for a check that examined nothing is the exact defect this gate layer exists to
//   prevent.

export function salesforceGates(): Gate[] {
  return [createCodeAnalyzerGate(), createFlowScanGate(), createDeployValidateGate(), createLwcJestGate()];
}

