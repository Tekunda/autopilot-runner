// Content integrity for bytes the runner downloads before it executes them.
//
// The runner does not bundle the licensed pack gates (see ./pack-bundle.ts); it fetches them at
// run time. Fetching CODE over the network from inside a job that holds the customer's
// credentials is a trust boundary, and the only
// thing on the runner's side of it is this: the expected digest travels in the SIGNED
// ExecutionGrant, so it cannot be swapped by whoever serves the bytes, and the bytes are
// checked against it BEFORE they are parsed, written to disk, or imported.
//
// Deliberately tiny and dependency-free (node:crypto only, like the rest of the runner):
// this is the one thing standing between "the control plane vouched for these bytes" and
// "this process imports them", so it must be readable end to end in one screen.

import { createHash, timingSafeEqual } from 'node:crypto';

/** A lowercase hex sha256 digest -- the only checksum form this module accepts. */
export const SHA256_HEX_RE = /^[0-9a-f]{64}$/;

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX_RE.test(value);
}

/** sha256 of `data`, as lowercase hex. Strings are hashed as UTF-8. */
export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).digest('hex');
}

export type ChecksumResult =
  | { ok: true; digest: string }
  // `reason` is safe to log and to put in an operator-facing message: it names only the two
  // digests and never the payload, the URL, or any credential used to fetch it.
  | { ok: false; reason: string; digest?: string };

// Verifies `data` against an EXPECTED lowercase-hex sha256.
//
// Fails closed in both directions: a malformed expectation is a failure, not a skipped check
// ("no checksum" must never read as "checksum passed"). Returns a result rather than throwing
// so callers decide the failure mode -- the pack-bundle loader turns it into a distinct,
// stage-failing error.
//
// The comparison is timing-safe, but be honest about what that buys HERE: nothing, today. The
// expectation travels in the grant, so anyone positioned to time this already holds it, and
// the mismatch branch prints both digests anyway. It is used because a constant-time compare
// is the right default for a digest check and costs one call -- not because a side channel is
// being closed. Do not cite it as a mitigation.
export function verifySha256(data: Uint8Array | string, expected: unknown): ChecksumResult {
  if (!isSha256Hex(expected)) {
    return { ok: false, reason: `expected checksum is not a lowercase hex sha256 digest (got ${describe(expected)})` };
  }

  const digest = sha256Hex(data);
  // Both are 64 lowercase hex chars by construction, so the buffers are always the same
  // length and timingSafeEqual can never throw here.
  const equal = timingSafeEqual(Buffer.from(digest, 'utf8'), Buffer.from(expected, 'utf8'));
  if (!equal) {
    return { ok: false, reason: `checksum mismatch: expected sha256 ${expected}, got ${digest}`, digest };
  }
  return { ok: true, digest };
}

// A short, non-leaking description of a bad expectation. Never echoes the whole value: a
// mis-wired config could put a credential where a digest belongs, and this string is logged.
function describe(value: unknown): string {
  if (typeof value !== 'string') return typeof value;
  return `a ${value.length}-character string`;
}
