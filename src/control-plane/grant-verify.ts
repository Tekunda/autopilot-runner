// Signature verification for ExecutionGrants — the half of the grant protocol the thin
// runner (src/runner/**) needs. Split out from ./grant.ts so the runner, and its standalone
// distribution (src/packaging/build-runner-dist.ts -> runner-dist/), can verify a grant
// without pulling in issuance: ./grant.ts's issueGateGrant depends on the licensed pack
// registry (../packs/registry.ts), which must never ship to customer CI (AGENTS.md, "split
// plane"; issue #129). Ed25519: the runner only ever needs the public verify key.
//
// Verification is THREE checks, not one. (1) the signature, against one of the keys this
// repository trusts -- selected by the grant's signed `keyId` when it carries one, which is what
// makes a key rotation a list of two PEMs in one secret rather than a coordinated cutover.
// (2) the BINDING: the grant's signed tenantId/repoId must match the environment actually
// executing it, threaded in by the caller as data (GrantEnvironment) so this stays a pure
// function. Before that check a signed, unexpired grant lifted from any log ran in any repository
// that trusted the same key. (3) expiry, as before.

import { createHash, createPublicKey, verify as cryptoVerify, KeyObject } from 'node:crypto';

import { sameRepoId } from '../contracts/types.ts';
import type { ExecutionGrant } from '../contracts/types.ts';

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

// Accept a live KeyObject or raw PEM/DER material so callers can load keys
// from config however they like without this module depending on how.
export type KeyInput = KeyObject | string | Buffer;

export function toPublicKey(key: KeyInput): KeyObject {
  return key instanceof KeyObject ? key : createPublicKey(key);
}

// Recursively rebuild a value with every object's keys in sorted order, so serialization is
// deterministic regardless of insertion order -- at EVERY depth. A plain
// `JSON.stringify(payload, Object.keys(payload).sort())` would not do: an array replacer is
// applied as an allowlist to nested objects too, so it drops any property whose name isn't a
// top-level key -- leaving nested content (gatePolicy, gateSpecs elements, mcp.servers)
// UNSIGNED. Sorting keys into a fresh structure and stringifying without a replacer signs the
// whole grant, so tampering with any nested field fails verification.
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) sorted[key] = sortDeep(source[key]);
    return sorted;
  }
  return value;
}

// Deterministic byte encoding of everything but `sig`, so issuing (./grant.ts) and
// verifying always hash the same bytes regardless of key insertion order. Exported so
// issueGrant() hashes identically without duplicating this.
export function canonicalize(payload: Omit<ExecutionGrant, 'sig'>): Buffer {
  return Buffer.from(JSON.stringify(sortDeep(payload)), 'utf8');
}

// The identity of a signing key, as carried in a grant's signed `keyId`: the first 16 base64url
// characters of sha256 over the key's SPKI DER encoding. Derived from the PUBLIC half, so the
// control plane (which holds the private key) and the runner (which holds only the public one)
// compute the identical value without exchanging anything but the key itself.
//
// 16 base64url chars is ~96 bits, which is not a collision-resistance claim and does not need to
// be: `keyId` is a SELECTOR, never a credential. It only says which of the handful of keys a repo
// already trusts should check the signature; the signature is what authorizes. A tampered keyId
// can at worst point at the wrong trusted key, and the signature then fails.
export function grantKeyId(key: KeyInput): string {
  const der = toPublicKey(key).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('base64url').slice(0, 16);
}

// The executing environment a grant is checked AGAINST. Passed in as data on purpose: verifyGrant
// stays a pure function of (grant, keys, now, expectation), so it is testable without a process
// environment and the runner's env reading lives in exactly one place
// (src/runner/action-entry.ts, runnerEnvironment). Every field is optional and an absent one is
// simply not checked -- a caller that knows nothing about its environment gets exactly the
// pre-binding behavior.
export interface GrantEnvironment {
  /** `owner/repo` of the repository this run is executing in (GitHub Actions: GITHUB_REPOSITORY). */
  repository?: string;
  /** The tenant this runner belongs to, when the workflow declares one. */
  tenantId?: string;
}

// Split one or more concatenated PEM blocks into individual keys. The runner's `verify-key` input
// is a single string, so a ROTATION (the outgoing key still covering in-flight grants while the
// incoming one starts signing fresh ones) is expressed by putting BOTH public keys in that one
// secret -- no workflow edit, no new input, no coordination window. A single-key secret parses to
// a one-element list and behaves exactly as before.
export function parseVerifyKeys(pem: string): string[] {
  const blocks = pem.match(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g);
  return blocks ?? (pem.trim() ? [pem.trim()] : []);
}

// The keys worth trying for this grant. A grant that names a `keyId` is checked ONLY against the
// key with that id: during a rotation that turns "signed by a key this repo was never given" into
// a precise, actionable message instead of a bare "invalid signature" -- the difference between a
// five-minute and a five-hour rotation incident. A legacy grant with no keyId is tried against
// every configured key, exactly as a single-key install behaved before.
function selectKeys(grant: ExecutionGrant, keys: readonly KeyInput[]): { keys: KeyInput[]; reason?: string } {
  // Separate "this key is not the one" from "this is not a key". A verify-key secret that holds
  // nothing importable is a configuration fault, and reporting it as a signature problem sends the
  // reader looking at the control plane instead of at the secret.
  const usable: KeyInput[] = [];
  for (const key of keys) {
    try {
      toPublicKey(key);
      usable.push(key);
    } catch {
      // not importable -- counted by exclusion below
    }
  }
  if (usable.length === 0) return { keys: [], reason: 'malformed verify key' };
  if (!grant.keyId) return { keys: usable };
  const matched = usable.filter((key) => grantKeyId(key) === grant.keyId);
  if (matched.length === 0) {
    return {
      keys: [],
      reason:
        `grant is signed by key "${grant.keyId}", which this repository does not trust ` +
        `(${usable.length} verify key(s) configured: ${usable.map(grantKeyId).join(', ')}) ` +
        '-- check AUTOPILOT_GRANT_VERIFY_KEY',
    };
  }
  return { keys: matched };
}

// Does the signature check out against any of the candidate keys? Returns the failure reason, or
// undefined when one key verified it. Split out of verifyGrant, which had grown past the
// complexity budget: this is the half with the loop and the two-way "malformed vs invalid" verdict.
function signatureFailureReason(bytes: Buffer, sig: string, keys: readonly KeyInput[]): string | undefined {
  let signature: Buffer;
  try {
    signature = Buffer.from(sig, 'base64');
  } catch {
    return 'malformed signature'; // `sig` absent or not a string
  }

  let threw = 0;
  for (const key of keys) {
    try {
      if (cryptoVerify(null, bytes, toPublicKey(key), signature)) return undefined;
    } catch {
      // A signature of the wrong length, or a key this runner cannot use for this algorithm: try
      // the rest of the list before deciding, so one bad block in a rotating secret cannot veto a
      // grant the other key would have accepted.
      threw += 1;
    }
  }
  // "Malformed" only if NO key could even attempt the check. If any key reached a clean verdict
  // and said no, the grant is a forgery, not a malformed one -- and during a rotation, where one
  // key may throw while another cleanly rejects, calling that "malformed" would send the reader
  // to inspect the secret instead of the grant.
  return threw === keys.length ? 'malformed signature' : 'invalid signature';
}

// Is this grant bound to the environment it is executing in? Returns the failure reason, or
// undefined when it belongs here. Checked by verifyGrant AFTER the signature (so a forged grant
// still reads as a forgery) and BEFORE expiry (a grant in the wrong repository is wrong regardless
// of how long it has left). The compared values are the SIGNED ones, so a grant cannot be
// re-pointed at another repo or tenant without breaking the signature.
function bindingFailureReason(grant: ExecutionGrant, environment?: GrantEnvironment): string | undefined {
  // Case-insensitively, via sameRepoId: the signed repoId carries the tenant config's spelling and
  // GITHUB_REPOSITORY carries GitHub's, and anything stricter rejects a legitimate grant over a
  // capitalization difference.
  if (environment?.repository && !sameRepoId(grant.repoId, environment.repository)) {
    return `grant is scoped to repository "${grant.repoId}" but is executing in "${environment.repository}"`;
  }
  if (environment?.tenantId && grant.tenantId !== environment.tenantId) {
    return `grant is scoped to tenant "${grant.tenantId}" but is executing as tenant "${environment.tenantId}"`;
  }
  return undefined;
}

// Verify a grant's signature, its binding to the executing environment, and its expiry.
//
// `verifyKey` accepts one key or a LIST (see parseVerifyKeys). More than one key is what makes a
// signing-key rotation a non-event for a tenant: grants issued under the outgoing key stay
// verifiable while the incoming one takes over.
//
// `environment` is the BINDING half, and it is what stops a captured grant from being a portable
// credential. Signature and expiry only prove a grant is authentic and live, never that it belongs
// HERE -- without this check any signed grant lifted from any log ran in any repository that
// trusted the same key.
export function verifyGrant(
  grant: ExecutionGrant,
  verifyKey: KeyInput | readonly KeyInput[],
  now: Date,
  environment?: GrantEnvironment,
): VerifyResult {
  const { sig, ...payload } = grant;
  const all = Array.isArray(verifyKey) ? (verifyKey as readonly KeyInput[]) : [verifyKey as KeyInput];
  if (all.length === 0) return { ok: false, reason: 'no verify key configured' };

  const selected = selectKeys(grant, all);
  if (selected.keys.length === 0) return { ok: false, reason: selected.reason ?? 'no verify key configured' };

  const signatureFailure = signatureFailureReason(canonicalize(payload as Omit<ExecutionGrant, 'sig'>), sig, selected.keys);
  if (signatureFailure) return { ok: false, reason: signatureFailure };

  const bindingFailure = bindingFailureReason(grant, environment);
  if (bindingFailure) return { ok: false, reason: bindingFailure };

  const expiresAt = new Date(grant.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    return { ok: false, reason: 'invalid expiresAt' };
  }
  if (now.getTime() >= expiresAt.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true };
}
