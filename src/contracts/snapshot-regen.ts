// Snapshot-regen detection: the deterministic, browser-free core of the visual-fix sub-stage.
//
// The problem it exists for: AutoPilot's fix/build (coding) stages edit visual-affecting source
// (`*.scss`, `*.css`, component files) but never regenerate the committed Playwright pixel
// baselines (`*-chromium-linux.png` under `**/*.spec.ts-snapshots/`). Those baselines go stale
// and the visual suite (`toHaveScreenshot`) then fails deterministically on LATER, unrelated PRs.
//
// This module makes ONLY the decisions -- it runs no browser and touches no files. The runner
// (action.yml's visual-fix job) gathers the two filesystem inputs (the diff's changed files and
// the repo's committed snapshot PNGs), asks `detectVisualRegen` whether to dispatch a regen, and
// after `--update-snapshots` asks `classifyChurn` whether the resulting PNG churn is safe to
// commit or is broad drift (font/env) that must be surfaced as a finding instead.
//
// Everything is OFF by default and opt-in per tenant (`enabled: false`), following the burn-in
// discipline of the generic gates (see assertion-delta's `enforce`). No tenant-specific paths are
// hardcoded -- the trigger is the PRESENCE of a `*-snapshots/` suite plus a tenant-configured
// visual-glob list, both generic.

import { matchesAnyPath } from './changed-paths.ts';

// Shallow-merge a namespaced tenant-config slice over defaults, mirroring gates/generic/config.ts's
// readGateConfig. Inlined (not imported) so this module stays in the contracts layer -- the runner
// imports it (visual-fix.ts), and the layering rule forbids runner -> control-plane/gates internals.
function mergeConfigSlice<T>(config: Record<string, unknown>, key: string, defaults: T): T {
  const raw = config[key];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return { ...defaults, ...(raw as unknown as Partial<T>) } as T;
  }
  return defaults;
}

// The marker Playwright appends to every screenshot-baseline directory: a spec's baselines live in
// a sibling directory named `<spec-file>-snapshots` (e.g. `home.spec.ts-snapshots/`). This is the
// framework's own convention, not a tenant setting, so it is the one hardcoded string here.
const SNAPSHOT_DIR_MARKER = '-snapshots/';

export interface SnapshotRegenConfig {
  /** Opt-in switch. OFF by default: the whole feature is inert until a tenant sets it true. */
  enabled: boolean;
  /**
   * Repo-relative glob patterns (the `changed-paths.ts` subset) whose presence in a diff marks it
   * as visual-affecting. Default is stylesheet extensions only -- deliberately conservative so the
   * stage never fires on a pure-logic change; a tenant adds its own component/UI directories.
   */
  visualGlobs: string[];
  /**
   * The tenant's own snapshot-update command, run on the Linux runner. Spec paths are appended by
   * the runner when the diff scopes to specific specs. The tenant overrides this with the command
   * that launches ITS Playwright (e.g. `yarn --cwd apps/web test:e2e --update-snapshots`); the
   * runner injects the served URL via PLAYWRIGHT_BASE_URL, so AutoPilot never reads the tenant's
   * playwright.config path.
   */
  updateCommand: string;
  /**
   * Broad-churn guardrail cap: when the diff does NOT name specific spec files (a global
   * stylesheet edit, so the whole suite is regenerated), commit only if the regen churned at most
   * this many distinct spec directories. More than that reads as font/env drift, not a real visual
   * change, and is surfaced as a finding instead of laundered into the baselines. Ignored when the
   * diff DOES name specs -- then only those specs' directories may churn, with zero tolerance.
   */
  maxChurnedSpecDirs: number;
}

export const DEFAULT_SNAPSHOT_REGEN_CONFIG: SnapshotRegenConfig = {
  enabled: false,
  visualGlobs: ['**/*.css', '**/*.scss', '**/*.sass', '**/*.less', '**/*.styl', '**/*.vue', '**/*.svelte'],
  updateCommand: 'npx playwright test --update-snapshots',
  maxChurnedSpecDirs: 3,
};

// Same untrusted provenance as the risk gate's config (a tenant-editable packConfig rides into the
// signed spec): normalize every field to a safe value rather than throwing, because a throw here
// would wedge the fix loop. See risk.ts for the same discipline.
function normalizeEnabled(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_SNAPSHOT_REGEN_CONFIG.enabled;
}

function normalizeVisualGlobs(value: unknown): string[] {
  if (!Array.isArray(value)) return DEFAULT_SNAPSHOT_REGEN_CONFIG.visualGlobs;
  // Keep the well-formed entries and drop junk (empty strings, non-strings) rather than discarding
  // the whole list on one bad entry. Only an entirely-empty result falls back to the default.
  const valid = value.filter((g): g is string => typeof g === 'string' && g.length > 0);
  return valid.length > 0 ? valid : DEFAULT_SNAPSHOT_REGEN_CONFIG.visualGlobs;
}

function normalizeUpdateCommand(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value : DEFAULT_SNAPSHOT_REGEN_CONFIG.updateCommand;
}

function normalizeMaxChurnedSpecDirs(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
    ? value
    : DEFAULT_SNAPSHOT_REGEN_CONFIG.maxChurnedSpecDirs;
}

/**
 * The effective per-tenant config: defaults overlaid by the `snapshot-regen` slice of the signed
 * gate config, each field normalized. Mirrors `effectiveRiskConfig`.
 */
export function resolveSnapshotRegenConfig(specConfig?: Record<string, unknown>): SnapshotRegenConfig {
  const merged = mergeConfigSlice(
    specConfig === undefined ? {} : { 'snapshot-regen': specConfig },
    'snapshot-regen',
    DEFAULT_SNAPSHOT_REGEN_CONFIG,
  );
  return {
    enabled: normalizeEnabled(merged.enabled),
    visualGlobs: normalizeVisualGlobs(merged.visualGlobs),
    updateCommand: normalizeUpdateCommand(merged.updateCommand),
    maxChurnedSpecDirs: normalizeMaxChurnedSpecDirs(merged.maxChurnedSpecDirs),
  };
}

/** Whether a repo-relative path is a Playwright screenshot baseline (lives under a `*-snapshots/` dir). */
export function isSnapshotPath(file: string): boolean {
  return file.includes(SNAPSHOT_DIR_MARKER);
}

/**
 * The snapshot directory a baseline PNG belongs to, e.g.
 * `a/b/home.spec.ts-snapshots/x-chromium-linux.png` -> `a/b/home.spec.ts-snapshots`.
 * Returns null for a path that is not under a snapshot directory.
 */
export function snapshotDirOf(file: string): string | null {
  const idx = file.indexOf(SNAPSHOT_DIR_MARKER);
  if (idx === -1) return null;
  return file.slice(0, idx + SNAPSHOT_DIR_MARKER.length - 1); // keep the dir, drop the trailing slash
}

/**
 * The spec file whose baselines a snapshot directory holds:
 * `a/b/home.spec.ts-snapshots` -> `a/b/home.spec.ts`. Playwright always names the directory
 * `<spec-file>-snapshots`, so stripping that suffix recovers the spec path to pass to the runner.
 */
export function specFileForSnapshotDir(dir: string): string {
  return dir.replace(/-snapshots$/, '');
}

export interface VisualRegenDetection {
  /** Whether the visual-fix sub-stage should be dispatched at all. */
  regenerate: boolean;
  /** A stable machine reason, for the finding/telemetry when regenerate is false. */
  reason: 'disabled' | 'no-snapshot-suite' | 'no-visual-change' | 'regenerate';
  /**
   * Spec files named directly by the diff whose snapshot directories exist in the repo. When
   * non-empty the runner scopes `--update-snapshots` to exactly these specs (and the guardrail
   * permits churn only within their directories). When empty the change is global -- the runner
   * regenerates the whole suite and the guardrail falls back to the magnitude cap.
   */
  affectedSpecFiles: string[];
}

/**
 * Decide whether to dispatch the visual-fix sub-stage.
 *
 * Inputs, all gathered by the runner (this function reads no filesystem):
 *  - `changedFiles`  : the coding stage's own diff (from `computeChangedFiles`).
 *  - `snapshotFiles` : every committed `*-snapshots/**` path in the repo (the suite-presence probe).
 *  - `config`        : the resolved, normalized tenant config.
 */
export function detectVisualRegen(input: {
  changedFiles: readonly string[];
  snapshotFiles: readonly string[];
  config: SnapshotRegenConfig;
}): VisualRegenDetection {
  const { changedFiles, snapshotFiles, config } = input;
  if (!config.enabled) return { regenerate: false, reason: 'disabled', affectedSpecFiles: [] };

  // Suite presence: at least one committed snapshot baseline exists.
  const hasSuite = snapshotFiles.some((f) => isSnapshotPath(f));
  if (!hasSuite) return { regenerate: false, reason: 'no-snapshot-suite', affectedSpecFiles: [] };

  // The diff has to touch a visual-affecting source file. A diff that ONLY edits the baseline PNGs
  // themselves is not a source change and must not re-trigger a regen (that would be a loop). Note
  // this uses matchesAnyPath directly, NOT diffTouches: diffTouches treats an empty changed-file
  // list as "in scope" (its ignorance-is-safe rule), which would wrongly flag a PNG-only diff as
  // visual once the snapshot paths are filtered out.
  const nonSnapshotChanges = changedFiles.filter((f) => !isSnapshotPath(f));
  if (!nonSnapshotChanges.some((f) => matchesAnyPath(f, config.visualGlobs))) {
    return { regenerate: false, reason: 'no-visual-change', affectedSpecFiles: [] };
  }

  // Scope, where feasible: the spec files the diff names directly AND that own a snapshot directory
  // in the repo. A stylesheet-only diff names no spec, so this is empty and the caller regenerates
  // the whole suite under the magnitude guardrail.
  const suiteSpecFiles = new Set(snapshotFiles.map((f) => snapshotDirOf(f)).filter((d): d is string => d !== null).map(specFileForSnapshotDir));
  const affectedSpecFiles = changedFiles.filter((f) => suiteSpecFiles.has(f));

  return { regenerate: true, reason: 'regenerate', affectedSpecFiles };
}

export interface ChurnClassification {
  /** True -> the regenerated PNGs are safe to commit. False -> surface `finding`, commit nothing. */
  commit: boolean;
  /** Present only when commit is false: the broad-churn finding to record (never silently drop). */
  finding?: string;
}

/**
 * The broad-churn guardrail, run AFTER `--update-snapshots`. Distinguishes a legitimate localized
 * baseline update from a font/environment drift that rewrote unrelated baselines.
 *
 *  - Nothing changed        -> safe (the caller commits nothing; a no-op is never drift).
 *  - Diff named specs       -> ONLY those specs' directories may churn. Any churn outside them is
 *                              drift -> finding, no commit. (Zero tolerance: the change was scoped.)
 *  - Diff named no specs    -> whole-suite regen. Churn across up to `maxChurnedSpecDirs` distinct
 *                              directories is allowed; more reads as drift -> finding, no commit.
 */
export function classifyChurn(input: {
  changedSnapshotFiles: readonly string[];
  affectedSpecFiles: readonly string[];
  config: SnapshotRegenConfig;
}): ChurnClassification {
  const { changedSnapshotFiles, affectedSpecFiles, config } = input;

  const churnedDirs = new Set(changedSnapshotFiles.map((f) => snapshotDirOf(f)).filter((d): d is string => d !== null));
  if (churnedDirs.size === 0) return { commit: true };

  if (affectedSpecFiles.length > 0) {
    const allowedDirs = new Set(affectedSpecFiles.map((s) => `${s}${SNAPSHOT_DIR_MARKER.slice(0, -1)}`));
    const stray = [...churnedDirs].filter((d) => !allowedDirs.has(d)).sort();
    if (stray.length > 0) {
      return {
        commit: false,
        finding: `Snapshot regen changed baselines outside the specs touched by this diff (${stray.join(', ')}). This is likely a font or environment drift, not a real visual change; not committing. Regenerate the full suite deliberately if this is expected.`,
      };
    }
    return { commit: true };
  }

  if (churnedDirs.size > config.maxChurnedSpecDirs) {
    return {
      commit: false,
      finding: `Snapshot regen churned ${churnedDirs.size} baseline directories (cap ${config.maxChurnedSpecDirs}) for a change that named no spec files. This breadth reads as font or environment drift rather than the edited component; not committing. Raise snapshot-regen.maxChurnedSpecDirs if this is expected.`,
    };
  }
  return { commit: true };
}

/**
 * Convenience predicate for a caller that only has the visual-glob question (e.g. the fix loop
 * deciding whether it is even worth probing the filesystem for a suite). Snapshot-only diffs are
 * excluded, matching `detectVisualRegen`.
 */
export function diffIsVisual(changedFiles: readonly string[], config: SnapshotRegenConfig): boolean {
  const nonSnapshotChanges = changedFiles.filter((f) => !isSnapshotPath(f));
  return nonSnapshotChanges.some((f) => matchesAnyPath(f, config.visualGlobs));
}
