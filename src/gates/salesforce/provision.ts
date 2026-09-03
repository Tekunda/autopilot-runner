// Provisioning for the Salesforce toolchain: fetch a PINNED tarball, verify its bytes against
// the SHA-256 in manifest.ts, and only then let anything execute from it.
//
// THE THREE RULES, each of which exists because breaking it produces a green gate that checked
// nothing:
//
//   1. NEVER `curl | sh`. A pipe executes bytes before it has finished reading them, so there
//      is no point at which a digest could be checked even in principle. Everything is
//      downloaded to a FILE, hashed, compared, and only then installed from that file.
//
//   2. A CACHE HIT IS RE-VERIFIED, not trusted. The cache is a directory on a machine other
//      workflow steps can write to, restored from a remote archive keyed by a string. "It was
//      correct when we wrote it" is not a property the reader can check, and a provisioning
//      step that verifies on the cold path and trusts on the warm path verifies nothing in
//      steady state -- the warm path is the one that runs every time. So the digest is
//      recomputed on every single resolution, hit or miss.
//
//   3. ABSENCE IS NEVER SUCCESS. Every failure below returns a REASON, and every caller turns
//      that reason into a `skip` or `unjudged`. There is no path through this file that lets a
//      gate report `pass` for a tool that was not there -- which is the single defect this
//      codebase has been burned by most (see cve.ts's header: an audit that could not run,
//      reported as clean).
//
// No new runtime dependency: `fetch`, `node:crypto` and `node:fs` are all built in.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { runCommand } from '../exec.ts';
import { PINNED_TOOLS, type ExternalRuntime, type PinnedTool } from './manifest.ts';

// The env var action.yml's provisioning step exports, naming the directory the verified
// tarballs and the receipt live in. Absent -> nothing was provisioned, which is a first-class
// answer and not an error.
export const PROVISION_DIR_ENV = 'AUTOPILOT_SF_TOOLS_DIR';
// The env var naming the provisioned `sf` executable. Separate from the directory because the
// binary lands in the install prefix's `bin/`, not in the download cache.
export const SF_BIN_ENV = 'AUTOPILOT_SF_BIN';

const RECEIPT_FILE = 'autopilot-sf-provision.json';

// What a completed, verified provisioning leaves behind. It is the PROOF the digest was
// checked -- a binary on PATH proves only that something is installed, not that anyone
// verified it -- so a gate can report the provenance of the tool it ran honestly.
export interface ProvisionReceipt {
  tools: { id: string; packageName: string; version: string; sha256: string }[];
  verifiedAt: string;
}

export type VerifyOutcome = { ok: true; file: string } | { ok: false; reason: string };

export interface ProvisionDeps {
  // Injected so the failure branches are unit-testable without a network. Production passes
  // the global fetch.
  fetch?: typeof globalThis.fetch;
}

function digestOf(file: string): { sha256: string; bytes: number } {
  const buffer = readFileSync(file);
  return { sha256: createHash('sha256').update(buffer).digest('hex'), bytes: buffer.length };
}

// Size first, then digest. A truncated or error-page download has the wrong LENGTH, and saying
// "expected 188624 bytes, got 1043" names the network fault it almost always is -- where a bare
// "checksum mismatch" reads like tampering and sends the reader down the wrong path entirely.
function verifyFile(tool: PinnedTool, file: string): VerifyOutcome {
  let actual: { sha256: string; bytes: number };
  try {
    actual = digestOf(file);
  } catch (err) {
    return { ok: false, reason: `could not read the downloaded ${tool.packageName} archive: ${message(err)}` };
  }
  if (actual.bytes !== tool.bytes) {
    return {
      ok: false,
      reason:
        `${tool.packageName}@${tool.version} is ${actual.bytes} bytes, but the pin in manifest.ts ` +
        `records ${tool.bytes}. The download is truncated or the URL served something else; it was ` +
        `NOT installed.`,
    };
  }
  if (actual.sha256 !== tool.sha256) {
    return {
      ok: false,
      reason:
        `${tool.packageName}@${tool.version} failed its checksum: got ${actual.sha256}, expected ` +
        `${tool.sha256}. These are not the bytes this pin was taken from, so nothing was installed ` +
        `from them.`,
    };
  }
  return { ok: true, file };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A failed cleanup never changes a verdict -- every caller below has already decided that
// nothing will be installed from the file it is trying to remove -- but it is still evidence
// about the machine (a read-only cache directory, a full disk, a leaked handle), and a cache
// that cannot be tidied is what turns one bad download into a permanently confusing run. Onto
// the runner log rather than into a finding: it is an operator's fact, not the PR's.
function noteCleanupFailure(target: string, err: unknown): void {
  process.stderr.write(`salesforce-provision: could not remove ${target}: ${message(err)}\n`);
}

export function tarballPath(tool: PinnedTool, cacheDir: string): string {
  // The VERSION is in the filename. Without it a cache restored across a pin bump would serve
  // the old tarball under the new name, and the digest check would then fail confusingly
  // forever instead of simply missing.
  return path.join(cacheDir, `${tool.id}-${tool.version}.tgz`);
}

// Fetch (or re-verify a cached) tarball. Verification runs on BOTH paths -- see rule 2.
export async function fetchAndVerify(
  tool: PinnedTool,
  cacheDir: string,
  deps: ProvisionDeps = {},
): Promise<VerifyOutcome> {
  const target = tarballPath(tool, cacheDir);

  if (existsSync(target)) {
    const cached = verifyFile(tool, target);
    if (cached.ok) return cached;
    // A cached file that fails verification is REMOVED, not reused and not left to wedge every
    // later run: a corrupted archive must cost one re-download, not permanent breakage. It is
    // still never installed from.
    try {
      rmSync(target, { force: true });
    } catch {
      return { ok: false, reason: `${cached.reason} The bad cache entry at ${target} could not be removed.` };
    }
  }

  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch (err) {
    return { ok: false, reason: `could not create the tool cache at ${cacheDir}: ${message(err)}` };
  }

  const doFetch = deps.fetch ?? globalThis.fetch;
  // Downloaded to `.part` and renamed only AFTER it verifies, so an interrupted run can never
  // leave a half-file sitting at the real path where the next run's cache check would find it.
  const part = `${target}.part`;
  try {
    const response = await doFetch(tool.url);
    if (!response.ok) {
      return {
        ok: false,
        reason: `${tool.url} returned HTTP ${response.status}, so ${tool.packageName}@${tool.version} was not installed.`,
      };
    }
    writeFileSync(part, Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    try {
      rmSync(part, { force: true });
    } catch (cleanupErr) {
      /* best effort; the verify below is what actually gates installation */
      noteCleanupFailure(part, cleanupErr);
    }
    return { ok: false, reason: `could not download ${tool.url}: ${message(err)}` };
  }

  const verified = verifyFile(tool, part);
  if (!verified.ok) {
    try {
      rmSync(part, { force: true });
    } catch (cleanupErr) {
      /* the file is not renamed into place either way, so it can never be installed from */
      noteCleanupFailure(part, cleanupErr);
    }
    return verified;
  }

  try {
    renameSync(part, target);
  } catch (err) {
    return { ok: false, reason: `could not move the verified archive into ${target}: ${message(err)}` };
  }
  return { ok: true, file: target };
}

// The `actions/cache` key for the whole toolchain, derived FROM THE PINS so it cannot drift
// from them. Bumping a version or a digest in manifest.ts changes this key, which means the
// old cache entry is simply not found rather than being restored and then failing its digest
// check for reasons nobody can see from the YAML. This is also why the key is computed here
// instead of being typed into action.yml: a hand-written key is a second copy of the pins.
export function toolchainCacheKey(tools: readonly PinnedTool[]): string {
  const material = tools.map((tool) => `${tool.id}@${tool.version}:${tool.sha256}`).join('|');
  return `autopilot-salesforce-tools-v1-${createHash('sha256').update(material).digest('hex').slice(0, 16)}`;
}

export function receiptPath(cacheDir: string): string {
  return path.join(cacheDir, RECEIPT_FILE);
}

export function writeReceipt(cacheDir: string, tools: readonly PinnedTool[]): void {
  const receipt: ProvisionReceipt = {
    tools: tools.map((tool) => ({
      id: tool.id,
      packageName: tool.packageName,
      version: tool.version,
      sha256: tool.sha256,
    })),
    verifiedAt: new Date().toISOString(),
  };
  writeFileSync(receiptPath(cacheDir), `${JSON.stringify(receipt, undefined, 2)}\n`);
}

// The receipt, or undefined when there is none / it is unreadable / it does not vouch for THE
// TOOLS THIS BUILD PINS. Undefined always means "cannot prove anything was verified".
//
// The content check is the point, not the shape check. A receipt is what makes a gate report
// its tool as `pinned` and print "checksum-verified", so a receipt-shaped file is not enough:
// a stale one left on a persistent self-hosted runner, or one written before a pin was bumped,
// would otherwise vouch for bytes nobody checked against the CURRENT manifest. So every entry
// in PINNED_TOOLS must be present at the exact version AND the exact digest this build expects.
export function readReceipt(cacheDir: string, expected: readonly PinnedTool[] = PINNED_TOOLS): ProvisionReceipt | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(receiptPath(cacheDir), 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const receipt = parsed as Partial<ProvisionReceipt>;
    if (!Array.isArray(receipt.tools) || typeof receipt.verifiedAt !== 'string') return undefined;
    const vouchedFor = receipt.tools.filter(
      (entry): entry is ProvisionReceipt['tools'][number] => typeof entry === 'object' && entry !== null,
    );
    const everyToolVouched = expected.every((tool) =>
      vouchedFor.some(
        (entry) => entry.id === tool.id && entry.version === tool.version && entry.sha256 === tool.sha256,
      ),
    );
    return everyToolVouched ? (receipt as ProvisionReceipt) : undefined;
  } catch {
    return undefined;
  }
}

// Remove any receipt already sitting in the cache. Called at the START of provisioning, so a
// run that fails midway cannot leave a PREVIOUS run's receipt behind to vouch for a toolchain
// that is no longer installed.
export function clearReceipt(cacheDir: string): void {
  try {
    rmSync(receiptPath(cacheDir), { force: true });
  } catch (err) {
    /* a receipt that cannot be removed is caught by readReceipt's content check anyway */
    noteCleanupFailure(receiptPath(cacheDir), err);
  }
}

// ---------------------------------------------------------------------------
// Gate-time resolution
// ---------------------------------------------------------------------------

// Where the `sf` the gate is about to run came from. `pinned` means this run's provisioning
// step verified the manifest digest and installed from those exact bytes. `ambient` means an
// `sf` was already on the machine: it still RUNS -- refusing a working tool because we did not
// install it ourselves would turn every self-hosted Salesforce runner into a permanent skip --
// but the gate says so in its findings, because "which tool produced this verdict" is the
// first question asked of a surprising one.
export type ToolProvenance = 'pinned' | 'ambient';

export type SfCliResolution =
  | { kind: 'ready'; bin: string; provenance: ToolProvenance; version?: string }
  | { kind: 'absent'; reason: string };

export interface ResolveEnv {
  [key: string]: string | undefined;
}

// Resolve the `sf` executable for a gate run. Deliberately does NOT fall back to searching the
// filesystem: either the provisioning step named it, or it is on PATH under its own name.
export function resolveSfCli(env: ResolveEnv, cacheDir?: string): SfCliResolution {
  const provisionDir = cacheDir ?? env[PROVISION_DIR_ENV];
  const named = env[SF_BIN_ENV];

  if (named !== undefined && named.trim() !== '') {
    if (!existsSync(named)) {
      return {
        kind: 'absent',
        reason:
          `${SF_BIN_ENV} names "${named}", but nothing is there. The Salesforce toolchain did not ` +
          `finish provisioning, so this gate ran no analysis at all -- it is reported as skipped ` +
          `rather than passed.`,
      };
    }
    const receipt = provisionDir !== undefined ? readReceipt(provisionDir) : undefined;
    // A receipt proves the digest was checked. Without one we still run the binary, but we do
    // not get to CALL it pinned.
    return { kind: 'ready', bin: named, provenance: receipt ? 'pinned' : 'ambient' };
  }

  return {
    kind: 'absent',
    reason:
      `no Salesforce CLI is available: ${SF_BIN_ENV} is unset and no verified toolchain was ` +
      `provisioned (${PROVISION_DIR_ENV} ${provisionDir === undefined ? 'is unset' : `= "${provisionDir}"`}). ` +
      `The gate asserted nothing and is reported as skipped, never as a pass.`,
  };
}

// ---------------------------------------------------------------------------
// External runtimes
// ---------------------------------------------------------------------------

// Java and Python are NOT provisioned here -- they are runner-image facts, and shipping a JDK
// through this cache would be a far larger surface than the analysis is worth. But their
// ABSENCE has to be caught, and caught HERE rather than left to the tool, because that is a
// live false-green path: Code Analyzer without a JVM does not fail loudly, it reports the
// engines it COULD run and says nothing about `pmd`/`sfge`. The document then parses fine, the
// violation list is short, and the gate passes having skipped the entire Apex static analysis.
// So each required runtime is probed directly and a missing one is reported by name, with the
// engines it took down.
export interface MissingRuntime {
  runtime: ExternalRuntime;
  detail: string;
}

export async function probeRuntimes(
  tool: PinnedTool,
  cwd: string,
  exec: typeof runCommand = runCommand,
): Promise<MissingRuntime[]> {
  const missing: MissingRuntime[] = [];
  for (const runtime of tool.externalRuntimes) {
    try {
      // `-version` for java (which prints to stderr and is the spelling every JDK accepts),
      // `--version` for python3.
      const args = runtime.id === 'java' ? ['-version'] : ['--version'];
      const { exitCode } = await exec(runtime.id, args, cwd, { timeoutMs: 60_000 });
      if (exitCode !== 0) {
        missing.push({ runtime, detail: `\`${runtime.id}\` exited ${exitCode}` });
      }
    } catch (err) {
      // A spawn failure (ENOENT) is the ordinary "not installed" case.
      missing.push({ runtime, detail: `\`${runtime.id}\` could not be run: ${message(err)}` });
    }
  }
  return missing;
}

// Is a runtime that one of the REQUESTED engines needs missing? An engine we did not ask for
// is not a reason to withhold a verdict -- a repo with no Flows does not need Python.
export function blockingRuntimeGaps(
  missing: readonly MissingRuntime[],
  requestedEngines: readonly string[],
): MissingRuntime[] {
  return missing.filter((gap) => gap.runtime.neededBy.some((engine) => requestedEngines.includes(engine)));
}

export function describeRuntimeGaps(gaps: readonly MissingRuntime[]): string {
  return gaps
    .map(
      (gap) =>
        `${gap.runtime.id} >= ${gap.runtime.minVersion} is required by the ${gap.runtime.neededBy.join('/')} ` +
        `engine(s) but is not usable on this runner (${gap.detail})`,
    )
    .join('; ');
}

// The install prefix's `bin/`, for the provisioning CLI and its tests.
export function binDirOf(prefix: string): string {
  return path.join(prefix, 'bin');
}

export function isExecutableFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
