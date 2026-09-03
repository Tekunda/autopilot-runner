// The pipeline-risk heuristic itself, extracted from the `risk` gate so the SAME reading of a
// diff can drive two decisions that must never disagree: the gate's pass/fail verdict
// (createRiskGate, which fails iff the level is `high`) and how much independent review the
// assembled branch is worth (selectReviewLenses). Two copies of "is this diff risky" would
// eventually classify one diff two ways, and the customer would have no way to tell which
// answer the pipeline acted on.
//
// Pure over the changed-file list plus an ALREADY-normalized RiskGateConfig -- both callers
// resolve config through effectiveRiskConfig, so a tenant override lands identically on both.

import type { DiffRiskLevel } from '../../contracts/types.ts';

// The classifier's input shape. It lives HERE, not in risk.ts, because risk.ts already imports
// this module: declaring it there and importing it back would make the two files depend on each
// other. That cycle would happen to work -- it is a type, erased at build -- but check-layering
// forbids it outright, and "happens to work" is not a property the module graph should rest on.
// risk.ts re-exports it, so every existing importer is unaffected.
export interface RiskGateConfig {
  highRiskPathPrefixes: string[];
  maxChangedFiles: number;
  // Generated / binary artifacts (image + font assets, e2e visual snapshots) do NOT count
  // toward the large-diff heuristic: a snapshot regeneration or an asset drop legitimately
  // touches hundreds of files but is not the large, risky SOURCE change the threshold exists
  // to flag -- and no fix can shrink it, so counting it just wedges the fix loop. A file
  // matching this pattern is still checked against highRiskPathPrefixes; it's only excluded
  // from the count.
  largeChangeExemptPattern: string;
}

export interface DiffRiskAssessment {
  level: DiffRiskLevel;
  /** Human-readable justification of the level ACTUALLY assigned -- never empty. At `high`
   *  these are verbatim the `risk` gate's findings, which is what keeps the gate's reported
   *  wording and this classification the same sentence. */
  reasons: string[];
  /** The changed files that tripped a high-risk path prefix (empty unless a prefix matched). */
  highRiskFiles: string[];
  /** Review-relevant file count: changed files minus generated/binary artifacts. */
  countedFiles: number;
}

// Extensions whose content has NO executable surface: prose a human reads. Deliberately tiny
// and closed -- see isInertProseFile for why nothing else may be added casually.
//
// `.mdx` is NOT here, and that is the whole point of the list being closed. MDX carries `import`
// statements and evaluated JSX: on a Next/Astro content site it is exactly where a component gets
// wired into a page. It looks like prose and executes like code, so it lands in `medium` and keeps
// every configured reviewer -- which is the honest answer, not a concession.
const PROSE_EXTENSIONS = new Set(['md', 'markdown', 'txt', 'rst', 'adoc']);

// The conventional extensionless repo-metadata files. `CODEOWNERS` is prose in the same sense:
// it carries no executable surface. (It DOES carry review policy, but a change to it lands in
// the same PR the reviewer is reading and GitHub enforces it independently.)
const PROSE_BASENAMES = new Set([
  'README',
  'LICENSE',
  'LICENCE',
  'COPYING',
  'CHANGELOG',
  'CONTRIBUTORS',
  'AUTHORS',
  'NOTICE',
  'CODEOWNERS',
]);

// Is this path certainly inert prose? The allowlist is deliberately CLOSED: the cost of a false
// positive is a real code change reviewed by one lens instead of three, so anything not proven
// inert is not low. That means a dotfile is never prose (dotfiles are config), an unrecognised
// extension is never prose (.json/.yml/.toml/.env/.sh/.sql/.tf and friends all carry executable
// or deployment surface), and an EXTENSIONLESS path is never prose unless it is one of the
// conventional bare metadata names above -- an extensionless file is as likely a shell script.
// A path under `docs/` is low by virtue of its prose extension; living under a docs directory
// never rescues a file the allowlist rejects.
function isInertProseFile(file: string): boolean {
  const name = file.slice(file.lastIndexOf('/') + 1);
  if (name.length === 0 || name.startsWith('.')) return false;
  const dot = name.lastIndexOf('.');
  if (dot > 0) return PROSE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
  return PROSE_BASENAMES.has(name.toUpperCase());
}

/**
 * Classify a diff's risk from its changed-file list.
 *
 * Thresholds, in the order they are applied (the first that matches wins):
 *  - `high`   -- ANY changed file (exempt or not) starts with one of config.highRiskPathPrefixes
 *                (default `.github/workflows/`, `.github/actions/`), OR the review-relevant file
 *                count exceeds config.maxChangedFiles (default 40). These are exactly the two
 *                conditions the `risk` gate fails on, which is why its findings ARE these reasons.
 *  - `none`   -- nothing changed, or every changed file is a generated/binary artifact
 *                (config.largeChangeExemptPattern): there is no review-relevant change at all.
 *  - `low`    -- every review-relevant file is inert prose (see isInertProseFile): no executable
 *                surface for a reviewer to find a defect in.
 *  - `medium` -- everything else: real code, within the size threshold, off the high-risk paths.
 */
export function classifyDiffRisk(changedFiles: readonly string[], config: RiskGateConfig): DiffRiskAssessment {
  const highRiskFiles: string[] = [];
  const reasons: string[] = [];
  for (const file of changedFiles) {
    const hit = config.highRiskPathPrefixes.find((prefix) => file.startsWith(prefix));
    if (hit) {
      highRiskFiles.push(file);
      reasons.push(`"${file}" touches high-risk path "${hit}"`);
    }
  }

  // Generated/binary artifacts are excluded from the count for the reason RiskGateConfig
  // documents (a snapshot regen is not the risky source change), and for the same reason they
  // do not make a diff medium: a diff of nothing but artifacts has no source to review.
  const exempt = new RegExp(config.largeChangeExemptPattern, 'i');
  const countable = changedFiles.filter((file) => !exempt.test(file));
  if (countable.length > config.maxChangedFiles) {
    reasons.push(
      `diff touches ${countable.length} review-relevant files (excluding generated/binary assets), ` +
        `exceeding the risk threshold of ${config.maxChangedFiles}`,
    );
  }

  if (reasons.length > 0) return { level: 'high', reasons, highRiskFiles, countedFiles: countable.length };

  if (countable.length === 0) {
    return {
      level: 'none',
      reasons: [
        changedFiles.length === 0
          ? 'the diff changes no files'
          : `${changedFiles.length} changed file(s), all generated/binary artifacts; no review-relevant change`,
      ],
      highRiskFiles,
      countedFiles: 0,
    };
  }

  if (countable.every(isInertProseFile)) {
    return {
      level: 'low',
      reasons: [`${countable.length} changed file(s), all documentation/prose; no executable surface`],
      highRiskFiles,
      countedFiles: countable.length,
    };
  }

  return {
    level: 'medium',
    reasons: [
      `${countable.length} review-relevant file(s) changed, within the risk threshold of ${config.maxChangedFiles}, ` +
        'and not documentation-only',
    ],
    highRiskFiles,
    countedFiles: countable.length,
  };
}

/**
 * Raise an assessment computed from a TRUNCATED file listing to `high`.
 *
 * A host that caps its listing (GitHub's compare endpoint stops at 300 files) returned real
 * paths but not all of them, so every size-derived reading below is a LOWER bound -- and a diff
 * big enough to be capped is by construction a large one. Applied by the caller that knows the
 * listing was capped, never inside classifyDiffRisk, which is honest about only what it was given.
 */
export function raiseForTruncatedListing(assessment: DiffRiskAssessment): DiffRiskAssessment {
  return {
    ...assessment,
    level: 'high',
    reasons: [
      ...(assessment.level === 'high' ? assessment.reasons : []),
      'the host capped the changed-file listing, so this diff is larger than the paths it returned',
    ],
  };
}
