// The runner's bundled gate catalog. Two families run runner-side:
//   - the always-on GENERIC gates -- commodity checks with no licensed IP (npm-audit
//     thresholds, forbidden-path/file-count predicates) -- registered unconditionally by
//     createRunnerGateRegistry.
//   - the DETERMINISTIC pack gates (the SEO crawl/changed-file gates, docs coverage/changelog,
//     the security regex review) -- these carry no model prompt and run exactly like a generic
//     gate (src/packs/registry.ts, enabledGateSpecs). They are NOT registered up front; the
//     grant decides which ones apply, so registerPackGatesForSpecs instantiates only the ones
//     whose id appears in the grant's signed gateSpecs (issue #129).
//
// Registering a gate here grants it no authority to run: a gate id only executes when it is
// present in the grant's signed `gateSpecs` (GateRegistry.run, src/gates/registry.ts), a set
// decided entirely server-side by issueGateGrant (src/control-plane/grant.ts) from the
// tenant's entitlement. This module imports only the deterministic pack gates -- never the
// model-judged PROMPT gates or any control-plane logic, which stay server-side. See AGENTS.md
// and docs/architecture.md.

import { e2eGate } from '../gates/e2e/e2e-gate.ts';
import { registerGenericGates } from '../gates/generic/index.ts';
import { layoutRulesGate } from '../gates/layout/layout-gate.ts';
import { GateRegistry } from '../gates/registry.ts';
import type { Gate } from '../gates/types.ts';
import { visualQaGate } from '../gates/visual/visual-qa.ts';
import { bannedPhraseGate } from '../packs/content/banned-phrase.ts';
import { competitorMentionsGate } from '../packs/content/competitor-mentions.ts';
import { i18nCompletenessGate } from '../packs/content/i18n-completeness.ts';
import { internalLinksGate } from '../packs/content/internal-links.ts';
import { apiCoverageGate } from '../packs/docs/api-coverage-gate.ts';
import { changelogFreshnessGate } from '../packs/docs/changelog-freshness-gate.ts';
import { createSecurityReviewGate } from '../packs/security/review-gate.ts';
import { cannibalizationGate } from '../packs/seo/cannibalization.ts';
import { coverTitleGate } from '../packs/seo/cover-title.ts';
import { externalLinksGate } from '../packs/seo/external-links.ts';
import { seoMonitorGate } from '../packs/seo/seo-monitor.ts';
import { siteCrawlGate } from '../packs/seo/site-crawl.ts';

// The deterministic pack gates the runner can instantiate, keyed by gate id. A spec carrying
// one of these ids resolves here to its Gate implementation; the security review gate is a
// factory, built once with its default (node fs) dependency.
const PACK_GATE_CATALOG: ReadonlyMap<string, Gate> = new Map(
  [
    cannibalizationGate,
    coverTitleGate,
    externalLinksGate,
    seoMonitorGate,
    siteCrawlGate,
    apiCoverageGate,
    changelogFreshnessGate,
    createSecurityReviewGate(),
    i18nCompletenessGate,
    internalLinksGate,
    competitorMentionsGate,
    bannedPhraseGate,
  ].map((gate) => [gate.id, gate] as const),
);

export function createRunnerGateRegistry(): GateRegistry {
  const registry = new GateRegistry();
  registerGenericGates(registry);
  return registry;
}

// Registers the deterministic pack gate for each of `ids` that names one, so a grant carrying
// a pack-gate spec (e.g. `seo-site-crawl`) has an executable Gate to run. Ids that don't name a
// pack gate (generic gates, command gates, unknown ids) are ignored, and a gate already
// registered (e.g. a duplicate id in the spec list) is not registered twice.
export function registerPackGatesForSpecs(registry: GateRegistry, ids: Iterable<string>): void {
  for (const id of ids) {
    const gate = PACK_GATE_CATALOG.get(id);
    if (gate && !registry.get(id)) registry.register(gate);
  }
}

// The HEAVY gates, kept OFF the fast deterministic gate path: they need a running server and a
// headless browser, provisioned only by the dedicated heavy stage (src/runner/serve-and-gate.ts).
// registerHeavyGatesForSpecs runs there, never in the fast runGateStage path, so a Visual-QA spec
// can only ever execute inside the browser/server-capable stage.
const HEAVY_GATE_CATALOG: ReadonlyMap<string, Gate> = new Map(
  [visualQaGate, e2eGate, layoutRulesGate].map((gate) => [gate.id, gate] as const),
);

export function registerHeavyGatesForSpecs(registry: GateRegistry, ids: Iterable<string>): void {
  for (const id of ids) {
    const gate = HEAVY_GATE_CATALOG.get(id);
    if (gate && !registry.get(id)) registry.register(gate);
  }
}

// Every gate id the runner can actually EXECUTE: the always-on generic gates plus both the
// fast (deterministic pack) and heavy catalogs. The catalog-completeness invariant
// (gate-catalog-completeness.test.ts) asserts every `{kind:'generic'}` id that
// enabledGateSpecs can emit resolves here -- so a pack gate added server-side without a
// runner catalog entry (the silent-green failure mode) fails CI rather than shipping.
export function runnerExecutableGateIds(): Set<string> {
  const ids = new Set<string>(createRunnerGateRegistry().list().map((gate) => gate.id));
  for (const id of PACK_GATE_CATALOG.keys()) ids.add(id);
  for (const id of HEAVY_GATE_CATALOG.keys()) ids.add(id);
  return ids;
}
