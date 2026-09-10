// The visual-fix sub-stage runner: regenerate the Playwright pixel baselines this PR's visual
// edits made stale, and commit them onto the PR branch. Dispatched as its own `ubuntu-latest` job
// (so the regenerated baselines carry the `-chromium-linux` platform suffix, which is the whole
// point), off a `fix` grant marked `fixMode: 'visual'` (src/control-plane/subtask-pipeline.ts ->
// src/adapters/github-actions/ci-runner.ts). No vendor agent runs on this stage.
//
// The DECISIONS live in ../control-plane/snapshot-regen.ts (pure, unit-tested). This file is the
// orchestration: gather the runner-side filesystem facts, ask those decisions, bring the customer
// site up (reusing the heavy-gate serveSite recipe), run the tenant's own update command against
// it, then classify the resulting churn and either commit the baselines or surface a finding.
//
// Fail-closed + burn-in: if the regen cannot run (no browser, serve failure, command failure) it
// records a finding and never commits a stale baseline -- but it never blocks the merge either
// (the control plane dispatches it best-effort). Promotion to a blocking posture is a later step,
// after the opt-in burn-in period.

import { execFileSync } from 'node:child_process';
import type { ExecutionGrant, ServeConfig } from '../contracts/types.ts';
import {
  classifyChurn,
  detectVisualRegen,
  isSnapshotPath,
  resolveSnapshotRegenConfig,
} from '../contracts/snapshot-regen.ts';
import { computeChangedFiles, DEFAULT_BASE_REF } from './prepare-stage.ts';
import { serveSite, type ServedSite } from './serve-and-gate.ts';
import { isDirectlyExecuted } from './entrypoint.ts';
import { E2E_BROWSER_PROVISION_COMMAND } from '../gates/e2e/e2e-gate.ts';
// The sanctioned runner->control-plane grant-verification seam (see PUBLISHABLE_CONTROL_PLANE_FILES
// in build-runner-dist.test.ts): every runner stage that acts on a grant verifies its signature
// first, and this stage shells out + pushes with the customer PAT, so it must too.
import { parseVerifyKeys, verifyGrant } from '../control-plane/grant-verify.ts';

/** The injected side-effects, so the orchestration control-flow is testable without a browser. */
export interface VisualFixIO {
  /** Repo-relative paths this PR changed, vs the diff base. */
  changedFiles(baseRef: string): Promise<readonly string[]>;
  /** Every committed `*-snapshots/**` path in the checkout (the suite-presence probe). */
  listSnapshotFiles(): Promise<readonly string[]>;
  /** Install the browser the tenant's Playwright will drive. Throws if it cannot. */
  provisionBrowsers(): Promise<void>;
  /** Bring the customer site up (heavy-gate serve recipe). Present only when a serve recipe exists. */
  serve(config: ServeConfig): Promise<ServedSite>;
  /** Run the (already spec-scoped) update command with PLAYWRIGHT_BASE_URL set. Throws on failure. */
  runUpdate(command: string, baseUrl: string | undefined): Promise<void>;
  /** The `*-snapshots/**` paths git reports as changed after the update command ran. */
  changedSnapshotFiles(): Promise<readonly string[]>;
  /** Stage ONLY the snapshot paths, commit, and push. */
  commitSnapshots(message: string): Promise<void>;
  /** Progress line (stdout). */
  log(line: string): void;
  /** A finding the operator must see (a GitHub `::warning::` annotation in the real runner). */
  warn(finding: string): void;
}

export interface VisualFixResult {
  outcome: 'skipped' | 'committed' | 'churn-rejected' | 'error';
  reason: string;
}

/**
 * Single-quote a shell argument. The spec paths are repo filenames a PR under work controls
 * (a branch can add `foo; rm -rf ~.spec.ts` with a matching `-snapshots/` dir), and they are
 * appended to a string run via `bash -lc` -- so they MUST be quoted or they are an injection
 * surface. Wrap in single quotes and escape any embedded single quote the POSIX way.
 */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/** Compose the scoped update command: the tenant's command, plus each affected spec as a quoted positional arg. */
export function composeUpdateCommand(command: string, specs: readonly string[]): string {
  return specs.length === 0 ? command : `${command} ${specs.map(shellQuote).join(' ')}`;
}

/** Parse `git status --porcelain` output into the snapshot-baseline paths it reports as changed. */
export function parseChangedSnapshotFiles(porcelain: string): string[] {
  return porcelain
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    // porcelain v1: two status chars + space + path (rename arrows are excluded by --no-renames).
    .map((line) => line.slice(2).trim().replace(/^"(.*)"$/, '$1'))
    .filter((path) => isSnapshotPath(path));
}

const COMMIT_MESSAGE = 'Delivery Autopilot: visual-fix (regenerate snapshot baselines)';

// The browser-provisioning command, defined ONCE as the e2e gate's so the two provisioning paths
// can never diverge again. `--no-install` runs the CHECKOUT's own Playwright CLI (never a registry
// fetch, so no version skew), and `--with-deps` is deliberately absent: the OS shared libraries are
// installed by the action's own `--with-deps` run for this stage (action.yml), and re-installing
// them needs sudo the runner does not have -- with `--with-deps`, this command fails and baselines
// are left stale, which is exactly the bug this reuse removes. See src/gates/e2e/e2e-gate.ts.
export const VISUAL_FIX_BROWSER_PROVISION_COMMAND = E2E_BROWSER_PROVISION_COMMAND;

/**
 * Provision the browser, bring the site up (if a serve recipe is present), run the scoped update
 * command against it, and ALWAYS stop the server afterwards. Throws on any failure -- the caller
 * turns that into a finding. Extracted so `runVisualFix` stays within the complexity budget.
 */
async function provisionServeAndRun(io: VisualFixIO, grant: ExecutionGrant, command: string): Promise<void> {
  await io.provisionBrowsers();
  const served = grant.serve ? await io.serve(grant.serve) : undefined;
  try {
    await io.runUpdate(command, served?.baseUrl);
  } finally {
    if (served) await served.stop();
  }
}

/**
 * The orchestration, pure over its injected IO. Returns the outcome; the caller maps it to a
 * process exit (always 0 during burn-in -- this stage reports, it does not block).
 */
export async function runVisualFix(grant: ExecutionGrant, io: VisualFixIO): Promise<VisualFixResult> {
  const sr = grant.snapshotRegen;
  if (!sr) {
    // A visual-fix grant with no config is a control-plane bug, not a stale baseline -- but still
    // surface it rather than pass silently.
    io.warn('visual-fix stage dispatched without snapshot-regen config; nothing to do.');
    return { outcome: 'error', reason: 'missing-config' };
  }

  const config = resolveSnapshotRegenConfig({
    enabled: true,
    visualGlobs: sr.visualGlobs,
    updateCommand: sr.command,
    maxChurnedSpecDirs: sr.churnCap,
  });
  const baseRef = sr.baseRef ?? DEFAULT_BASE_REF;

  // Everything below shells out to git or the browser. ANY of it can throw -- a git push rejected
  // non-fast-forward, a network blip, a `git status` failure. The stage's contract is "record a
  // finding and exit 0, never a stale baseline and never a bare crash", so the whole IO segment is
  // fail-closed: an unexpected throw becomes a finding, exactly like the regen-failure path.
  try {
    const changedFiles = await io.changedFiles(baseRef);
    const snapshotFiles = await io.listSnapshotFiles();
    const detection = detectVisualRegen({ changedFiles, snapshotFiles, config });
    if (!detection.regenerate) {
      io.log(`visual-fix: nothing to regenerate (${detection.reason}).`);
      return { outcome: 'skipped', reason: detection.reason };
    }

    const scope = detection.affectedSpecFiles.length > 0 ? detection.affectedSpecFiles.join(', ') : 'the whole suite';
    io.log(`visual-fix: regenerating baselines for ${scope}.`);

    try {
      await provisionServeAndRun(io, grant, composeUpdateCommand(config.updateCommand, detection.affectedSpecFiles));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      io.warn(`visual-fix could not regenerate baselines (${message}); NOT committing -- the baselines may still be stale.`);
      return { outcome: 'error', reason: 'regen-failed' };
    }

    const changedSnapshots = await io.changedSnapshotFiles();
    const churn = classifyChurn({
      changedSnapshotFiles: changedSnapshots,
      affectedSpecFiles: detection.affectedSpecFiles,
      config,
    });
    if (!churn.commit) {
      io.warn(churn.finding ?? 'visual-fix: unexpected snapshot churn; not committing.');
      return { outcome: 'churn-rejected', reason: churn.finding ?? 'broad-churn' };
    }
    if (changedSnapshots.length === 0) {
      io.log('visual-fix: the update produced no baseline changes (nothing to commit).');
      return { outcome: 'skipped', reason: 'no-op' };
    }

    await io.commitSnapshots(COMMIT_MESSAGE);
    io.log(`visual-fix: committed ${changedSnapshots.length} regenerated baseline(s).`);
    return { outcome: 'committed', reason: `${changedSnapshots.length} baseline(s)` };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    io.warn(`visual-fix failed during git/IO (${message}); NOT committing -- the baselines may still be stale.`);
    return { outcome: 'error', reason: 'io-failed' };
  }
}

// ---- real runner IO (not exercised by unit tests; validated during burn-in) ----

const PLAYWRIGHT_BASE_URL_ENV = 'PLAYWRIGHT_BASE_URL';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function sh(command: string, cwd: string, env: NodeJS.ProcessEnv): void {
  execFileSync('bash', ['-lc', command], { cwd, env, stdio: 'inherit' });
}

/** Build the production IO bound to the checkout, the grant's push identity and the branch. */
export function makeVisualFixIO(opts: {
  cwd: string;
  branch: string;
  committerName: string;
  committerEmail: string;
}): VisualFixIO {
  const { cwd, branch, committerName, committerEmail } = opts;
  return {
    changedFiles: (baseRef) => computeChangedFiles(baseRef, cwd),
    listSnapshotFiles: async () =>
      git(['ls-files', '-z'], cwd)
        .split('\0')
        .filter((p) => p.length > 0 && isSnapshotPath(p)),
    provisionBrowsers: async () => {
      // Provision the browser for the TENANT's own Playwright (already in their node_modules after
      // serve's install step), mirroring the e2e gate's `--no-install` provisioning. OS deps come
      // from the action's `--with-deps` run for this stage (action.yml), never from here.
      sh(VISUAL_FIX_BROWSER_PROVISION_COMMAND, cwd, process.env);
    },
    serve: (config) => serveSite(config, { cwd }),
    runUpdate: async (command, baseUrl) => {
      const env = { ...process.env };
      if (baseUrl) env[PLAYWRIGHT_BASE_URL_ENV] = baseUrl;
      sh(command, cwd, env);
    },
    changedSnapshotFiles: async () => parseChangedSnapshotFiles(git(['status', '--porcelain', '--no-renames'], cwd)),
    commitSnapshots: async (message) => {
      git(['config', 'user.name', committerName], cwd);
      git(['config', 'user.email', committerEmail], cwd);
      // Stage ONLY snapshot baselines -- never anything else the regen run may have touched.
      git(['add', '--', ':(glob)**/*-snapshots/**'], cwd);
      const staged = git(['diff', '--cached', '--name-only'], cwd).trim();
      if (staged.length === 0) return;
      git(['commit', '-m', message], cwd);
      // autopilot/* is a deterministic Autopilot-owned branch (force-push a retry); any other is a
      // real/shared branch pushed fast-forward, matching action.yml's coding commit step.
      if (branch.startsWith('autopilot/')) git(['push', '--force', 'origin', `HEAD:refs/heads/${branch}`], cwd);
      else git(['push', 'origin', `HEAD:refs/heads/${branch}`], cwd);
    },
    log: (line) => process.stdout.write(`${line}\n`),
    warn: (finding) => process.stdout.write(`::warning::${finding}\n`),
  };
}

const warnLine = (finding: string): void => {
  process.stdout.write(`::warning::${finding}\n`);
};

export type GrantResolution = { ok: true; grant: ExecutionGrant } | { ok: false; finding: string };

/**
 * Parse and RE-VERIFY the dispatched grant in-runner before acting on it. Pure (no I/O), so the
 * refusal branches are unit-testable. A missing/unparseable grant, a missing verify key, or a
 * failed signature all refuse with a finding rather than acting on unverified input -- this stage
 * shells out an arbitrary command and pushes with the customer PAT, so verification is not optional.
 */
export function resolveVerifiedGrant(grantJson: string | undefined, verifyKeyPem: string | undefined, now: Date): GrantResolution {
  if (!grantJson) return { ok: false, finding: 'visual-fix: AUTOPILOT_GRANT is missing; refusing to run.' };
  let grant: ExecutionGrant;
  try {
    grant = JSON.parse(grantJson) as ExecutionGrant;
  } catch {
    return { ok: false, finding: 'visual-fix: AUTOPILOT_GRANT is not valid JSON; refusing to run.' };
  }
  if (!verifyKeyPem) {
    return { ok: false, finding: 'visual-fix: no verify key provided; refusing to act on an unverifiable grant.' };
  }
  const verification = verifyGrant(grant, parseVerifyKeys(verifyKeyPem), now);
  if (!verification.ok) {
    return { ok: false, finding: `visual-fix: grant signature verification failed (${verification.reason}); refusing to regenerate or push.` };
  }
  return { ok: true, grant };
}

/**
 * Entry point invoked by action.yml's visual-fix step. Fail-closed throughout: it NEVER throws to
 * the process (a bare crash would exit non-zero with no finding), and it NEVER acts on a grant it
 * has not re-verified. Every refusal records a `::warning::` finding and returns (exit 0).
 */
export async function main(): Promise<void> {
  try {
    // Re-verify the signature in-runner, exactly as the gate stage does (action-entry.ts). The
    // step's `if:` already requires a prepare that resolved the grant, but this stage shells out an
    // arbitrary command and pushes with the customer PAT off a value read straight from step env --
    // belt AND suspenders. A bad/absent signature or grant refuses without touching the tree.
    const resolution = resolveVerifiedGrant(process.env.AUTOPILOT_GRANT, process.env.AUTOPILOT_VERIFY_KEY, new Date());
    if (!resolution.ok) {
      warnLine(resolution.finding);
      return;
    }
    const grant = resolution.grant;

    // The push target is the PR head branch the grant names. NEVER fall back to a base ref: a
    // missing baseBranch defaulting to `main` would push regenerated PNGs straight onto the default
    // branch, bypassing the PR. A visual-fix grant always carries baseBranch (subtask-pipeline sets
    // it to the PR branch); its absence is a control-plane bug, so refuse rather than guess.
    const branch = grant.baseBranch;
    if (!branch) {
      warnLine('visual-fix: grant carries no baseBranch; refusing to run (would risk pushing to the default branch).');
      return;
    }
    const io = makeVisualFixIO({
      cwd: process.cwd(),
      branch,
      committerName: process.env.AUTOPILOT_COMMITTER_NAME ?? 'github-actions[bot]',
      committerEmail: process.env.AUTOPILOT_COMMITTER_EMAIL ?? '41898282+github-actions[bot]@users.noreply.github.com',
    });
    const result = await runVisualFix(grant, io);
    io.log(`visual-fix: ${result.outcome} (${result.reason}).`);
  } catch (err) {
    // Last-resort fail-closed: nothing reaches the process as a non-zero crash without a finding.
    const message = err instanceof Error ? err.message : String(err);
    warnLine(`visual-fix: unexpected failure (${message}); no baselines committed.`);
  }
  // Burn-in: report, never block. The stage exits 0 regardless of outcome.
}

if (isDirectlyExecuted(import.meta.url)) {
  void main();
}
