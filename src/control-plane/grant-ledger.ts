// Consume ledger for ExecutionGrants — the replay half of the grant protocol (Track G,
// docs/website-parity-plan.md): signature + expiry prove a grant is authentic and live,
// but nothing recorded that it was already EXECUTED. This ledger does: each consumption
// is recorded under the grant's id (its signed `jti`, falling back to sha256(sig) for
// legacy grants -- the same stable telemetry id both planes derive), so a SECOND
// result/telemetry for the same issued grant is flagged loudly (log + counter) instead
// of being silently reprocessed. Re-issued retries never trip it: every issueGrant call
// mints a fresh jti, which is what makes retry issuance explicit by construction.
//
// SCOPE -- DETECTION ONLY, NOT PREVENTION. Every production caller records and continues;
// none refuses. Two structural reasons, both open (see the Track G open-edge table):
//   1. Runner side (finalize-stage.ts) holds a per-PROCESS ledger. Each Actions step is a
//      fresh Node process, so a captured grant re-dispatched into a NEW job meets an empty
//      ledger and executes in full -- agent push, PR open, gate report and all.
//   2. Control-plane side (telemetry-ingest.ts) only ever ledgers grants IT minted and
//      dispatched, each with a fresh jti. A grant replayed straight at the customer's
//      workflow_dispatch endpoint never reaches this ledger at all, and by the time any
//      telemetry could, the stage has already run.
// Real refusal needs the runner to consult a durable cross-process ledger before executing
// -- a control-plane-gated dispatch check that does not exist yet.

import { createHash } from 'node:crypto';

import type { ExecutionGrant } from '../contracts/index.ts';

// The ledger's key for a grant: its signed nonce when present, else the sig-derived
// hash legacy grants were already identified by (mirrors runner prepare-stage grantId).
export function grantLedgerId(grant: ExecutionGrant): string {
  return grant.jti ?? createHash('sha256').update(grant.sig).digest('hex');
}

// Detection window bound: past this many stored ids the OLDEST is dropped, so memory and
// any persisted snapshot stay bounded. A grant older than the window loses replay detection
// by definition -- grants are single-stage and short-lived, so 10k ids is far beyond any
// live replay risk.
export const GRANT_LEDGER_CAP = 10_000;

export interface GrantLedgerRecord {
  firstSeenAt: string;
  replays: number;
}

export class GrantLedger {
  #consumed = new Map<string, GrantLedgerRecord>();
  #replays = 0;
  #cap: number;
  #now: () => Date;

  // Injectable clock so tests can pin firstSeenAt; defaults to wall time.
  // (Explicit field, not a ctor parameter property -- Node strip-only TS mode rejects those.)
  constructor(now: () => Date = () => new Date(), options?: { cap?: number }) {
    this.#now = now;
    this.#cap = options?.cap ?? GRANT_LEDGER_CAP;
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
   * step) and report whether it was fresh. A duplicate is NOT an error thrown here, and
   * NO production caller acts on `fresh: false` beyond logging: the duplicate's work
   * proceeds exactly as the first one's did. What this buys is the loud line (ids only,
   * never secrets) and the counter -- a replay is visible, not stopped. See the module
   * header for why refusing here would not prevent one.
   */
  markConsumed(grant: ExecutionGrant, context?: string): { fresh: boolean; id: string } {
    const id = grantLedgerId(grant);
    const prior = this.#consumed.get(id);
    if (!prior) {
      // Bounded window: at cap, evict the oldest record (Map preserves insertion order).
      if (this.#consumed.size >= this.#cap) {
        const oldest = this.#consumed.keys().next().value;
        if (oldest !== undefined) this.#consumed.delete(oldest);
      }
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

  /** Every stored record, oldest first — the exact form persistence round-trips. */
  entries(): [string, GrantLedgerRecord][] {
    return [...this.#consumed];
  }

  /**
   * Reload persisted records (oldest first). The total replay count is derived from the
   * per-id replays rather than carried separately: every duplicate consumption increments
   * exactly one record's counter, so the sum IS the lifetime count.
   */
  restore(entries: Iterable<[string, GrantLedgerRecord]>): void {
    for (const [id, rec] of entries) this.#consumed.set(id, rec);
    this.#replays = [...this.#consumed.values()].reduce((n, r) => n + r.replays, 0);
  }
}
