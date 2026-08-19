// Signature verification for ExecutionGrants — the half of the grant protocol the thin
// runner (src/runner/**) needs. Split out from ./grant.ts so the runner, and its standalone
// distribution (src/packaging/build-runner-dist.ts -> runner-dist/), can verify a grant
// without pulling in issuance: ./grant.ts's issueGateGrant depends on the licensed pack
// registry (../packs/registry.ts), which must never ship to customer CI (AGENTS.md, "split
// plane"; issue #129). Ed25519: the runner only ever needs the public verify key.

import { createPublicKey, verify as cryptoVerify, KeyObject } from 'node:crypto';

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

// Deterministic byte encoding of everything but `sig`, so issuing (./grant.ts) and
// verifying always hash the same bytes regardless of key insertion order. Exported so
// issueGrant() hashes identically without duplicating this.
export function canonicalize(payload: Omit<ExecutionGrant, 'sig'>): Buffer {
  return Buffer.from(JSON.stringify(payload, Object.keys(payload).sort()), 'utf8');
}

export function verifyGrant(grant: ExecutionGrant, verifyKey: KeyInput, now: Date): VerifyResult {
  const { sig, ...payload } = grant;

  let signatureValid: boolean;
  try {
    signatureValid = cryptoVerify(
      null,
      canonicalize(payload as Omit<ExecutionGrant, 'sig'>),
      toPublicKey(verifyKey),
      Buffer.from(sig, 'base64'),
    );
  } catch {
    return { ok: false, reason: 'malformed signature' };
  }
  if (!signatureValid) {
    return { ok: false, reason: 'invalid signature' };
  }

  const expiresAt = new Date(grant.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) {
    return { ok: false, reason: 'invalid expiresAt' };
  }
  if (now.getTime() >= expiresAt.getTime()) {
    return { ok: false, reason: 'expired' };
  }

  return { ok: true };
}
