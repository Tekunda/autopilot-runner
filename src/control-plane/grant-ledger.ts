// Consume ledger for ExecutionGrants — the replay half of the grant protocol (Track G,
// docs/website-parity-plan.md): signature + expiry prove a grant is authentic and live,
// but nothing recorded that it was already EXECUTED. This ledger does: each consumption
// is recorded under the grant's id (its signed `jti`, falling back to sha256(sig) for
// legacy grants -- the same stable telemetry id both planes derive), so a SECOND
// result/telemetry for the same issued grant is flagged loudly (log + counter) instead
// of being silently reprocessed. Re-issued retries never trip it: every issueGrant call
// mints a fresh jti, which is what makes retry issuance explicit by construction.

import { createHash } from 'node:crypto';

import type { ExecutionGrant } from '../contracts/index.ts';

// The ledger's key for a grant: its signed nonce when present, else the sig-derived
// hash legacy grants were already identified by (mirrors runner prepare-stage grantId).
export function grantLedgerId(grant: ExecutionGrant): string {
  return grant.jti ?? createHash('sha256').update(grant.sig).digest('hex');
}

export class GrantLedger {
  #consumed = new Map<string, { firstSeenAt: string; replays: number }>();
  #replays = 0;
  #now: () => Date;

  // Injectable clock so tests can pin firstSeenAt; defaults to wall time.
  // (Explicit field, not a ctor parameter property -- Node strip-only TS mode rejects those.)
  constructor(now: () => Date = () => new Date()) {
    this.#now = now;
  }

  /** Grants consumed so far. */
  get size(): number {
    return this.#consumed.size;
  }

  /** Duplicate-consumption attempts seen (the replay signal, countable in tests/dashboards). */
  get replayCount(): number {
    return this.#replays;
  }

  isConsumed(grant: ExecutionGrant): boolean {
    return this.#consumed.has(grantLedgerId(grant));
  }

  /**
   * Record a grant's consumption atomically (single-threaded JS: check+record are one
   * step) and report whether it was fresh. A duplicate is NOT an error thrown here --
   * the caller decides policy -- but it is logged loudly with ids only (never secrets)
   * and counted, so a replay can't slip through silently.
   */
  markConsumed(grant: ExecutionGrant, context?: string): { fresh: boolean; id: string } {
    const id = grantLedgerId(grant);
    const prior = this.#consumed.get(id);
    if (!prior) {
      this.#consumed.set(id, { firstSeenAt: this.#now().toISOString(), replays: 0 });
      return { fresh: true, id };
    }
    prior.replays += 1;
    this.#replays += 1;
    console.error(
      `grant-ledger: REPLAYED GRANT ${id}${context ? ` (${context})` : ''} consumed again -- ` +
        `first seen ${prior.firstSeenAt}, attempt #${prior.replays + 1}`,
    );
    return { fresh: false, id };
  }

  /** Hard-fail variant for callers that must refuse work on an already-consumed grant. */
  assertFresh(grant: ExecutionGrant, context?: string): void {
    const id = grantLedgerId(grant);
    if (this.#consumed.has(id)) {
      throw new Error(`grant-ledger: grant ${id} was already consumed${context ? ` (${context})` : ''}`);
    }
  }
}
