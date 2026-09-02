// The reason a ticket or subtask is blocked, as a TYPE rather than a convention.
//
// A block whose reason is empty, absent, or not a string is not merely an observability gap:
// the stale-block revalidation lanes select their population by matching the reason's TEXT
// (blocked-recovery.ts's `resumeEntitlementBlocked` keys on `entitlement:`, `isFindingsBlock`
// on `review not met`), so a block with no reason matches no predicate and is invisible to
// every recovery lane -- permanently unrecoverable AND unexplainable. That shipped: on
// 2026-09-02 the repo-budget gate blocked ticket 3ceac5b0-... having computed the sentence
// "budget: repo \"Tekunda/Website\" is over its configured budget cap" and then persisted a
// state with no reason at all.
//
// `BlockReason` is a branded string that only `blockReason()` can mint, and TicketState /
// SubtaskState declare their `blockedReason` at that type -- so `{ ...t, status: 'blocked',
// blockedReason: someString }` no longer compiles. The compiler, not a reviewer, enumerates
// the writers. `blockReason()` in turn cannot RETURN an empty one: a caller with nothing in
// hand gets "unknown fault, blocked at <site>", which names the code that blocked and is
// infinitely more useful than "".
//
// The write-side backstop is audit.ts's `assertBlockReasonRecorded`, which every block passes
// through on its way to durability.

declare const blockReasonBrand: unique symbol;

/** A non-empty, human-readable explanation of a block. Minted only by `blockReason()`. */
export type BlockReason = string & { readonly [blockReasonBrand]: true };

/** True for a value that can actually answer "why is this blocked?" -- i.e. a non-blank string.
 *  Deliberately runtime-checked as well as typed: a state re-hydrated from JSON (the Table
 *  document, the legacy state file) carries whatever was written before this type existed. */
export function isBlockReason(value: unknown): value is BlockReason {
  return typeof value === 'string' && value.trim().length > 0;
}

/** What a block records when its cause is genuinely unavailable. Names the code site so an
 *  operator still knows WHICH block this was, and greps to exactly one place in the source. */
export function unknownBlockReason(site: string): BlockReason {
  return `unknown fault, blocked at ${site}` as BlockReason;
}

// Renders a non-string cause without destroying it, which is the whole point -- `${err}` on a
// plain object yields "[object Object]" and throws the information away.
function coerce(cause: unknown): string {
  if (typeof cause === 'string') return cause;
  if (cause instanceof Error) return cause.message;
  if (cause === undefined || cause === null) return '';
  if (typeof cause === 'object') {
    const message = (cause as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim().length > 0) return message;
    try {
      return JSON.stringify(cause) ?? '';
    } catch {
      // Circular, or a BigInt/toJSON that throws. The constructor's contract is that it never
      // itself throws -- a block must always be recordable -- so fall through to `site`.
      return '';
    }
  }
  return String(cause);
}

/**
 * The ONLY way to mint a `BlockReason`.
 *
 * `cause` is whatever the call site has in hand -- a sentence, a caught error, a host response
 * object. `site` names the blocking code (e.g. `'gateTicket'`, `'rollup-refused'`) and is used
 * verbatim when `cause` carries nothing usable. The result is never empty and never
 * "[object Object]".
 */
export function blockReason(cause: unknown, site: string): BlockReason {
  const text = coerce(cause).trim();
  return (text.length > 0 ? text : unknownBlockReason(site)) as BlockReason;
}
