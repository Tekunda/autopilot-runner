// A process-wide FIFO gate on how many vision-model calls are in flight at once. The two vision
// gates (design-review, visual-qa) run concurrently within a site and each contributes at most one
// serial in-flight call, so a net max of 2 hits the Anthropic vision model simultaneously -- which
// self-inflicts a 429 and turns both gates into an infra SKIP. A shared limiter of 1 serializes
// them. Sites run sequentially, so no cross-site coordination is needed and one process-wide
// limiter suffices.

export interface VisionLimiter {
  // `opts.minIntervalMs` (default 0) paces successive STARTS at least that many ms apart, on TOP of
  // the concurrency cap -- concurrency stops parallel bursts, pacing stops serial bursts (successive
  // heavy calls that each start the instant the last finished still burst past account ITPM). It is
  // latched by MONOTONIC MAX across calls, so once any caller asks for an interval it stays in force.
  run<T>(fn: () => Promise<T>, opts?: { minIntervalMs?: number }): Promise<T>;
}

// A FIFO concurrency gate: run() admits up to `limit` fns at once and queues the rest. Because it
// SERIALIZES, calling limiter.run re-entrantly on the SAME limiter while it is at cap self-deadlocks
// (the inner call parks forever behind the outer one that is waiting on it) -- fine for the vision
// use where each judge call is a leaf, but a caller of the exported primitive must not nest.
//
// `deps` (a test-injection seam only; the singleton uses real defaults) overrides the clock and the
// sleeper so pacing is exercised on a fake clock with no real timers.
export function createLimiter(
  limit: number,
  deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): VisionLimiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`createLimiter: limit must be a positive integer, got ${limit}`);
  }
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  // `active` counts permits currently HELD -- either running, or handed off to a waiter that has not
  // yet resumed. It never dips below the number of live holders, which is what closes the late-arriver
  // race: a caller that sees `active >= limit` always parks, because a released permit is TRANSFERRED
  // straight to the next waiter (active unchanged) rather than decremented-then-re-incremented, so
  // there is no window between a release and a resume in which `active` reads below the cap.
  let active = 0;
  const waiters: Array<() => void> = [];
  // Throughput pacing state (interval 0 = off = byte-identical to no pacing). `nextAllowedStart` is
  // the earliest clock time the next fn may START; `effectiveIntervalMs` is the monotonic-max of
  // every minIntervalMs any caller has asked for over this limiter's lifetime. Process-lifetime and
  // single-tenant-per-process: one tenant runs per runner, sites serve-and-gate sequentially, so a
  // stale floor never crosses tenants.
  let nextAllowedStart = 0;
  let effectiveIntervalMs = 0;
  return {
    async run<T>(fn: () => Promise<T>, opts?: { minIntervalMs?: number }): Promise<T> {
      if (active >= limit) {
        // Park until a releaser hands us its permit; on resume we already HOLD it -- do not increment.
        await new Promise<void>((resolve) => waiters.push(resolve));
      } else {
        active++;
      }
      try {
        // START-based pacing: reserve the next slot SYNCHRONOUSLY (before any await), so two callers
        // that resume in the same tick can't both read the same `nextAllowedStart` and start together.
        // Reserving at START (not call-END) also neutralizes the judge's own Retry-After waits: a
        // retry burns wall-time PAST nextAllowedStart, so the next call waits 0 rather than double-
        // counting. Do NOT advance nextAllowedStart inside a retry loop or move this to call-end.
        const iv = (effectiveIntervalMs = Math.max(effectiveIntervalMs, opts?.minIntervalMs ?? 0));
        if (iv > 0) {
          const t = now();
          const start = Math.max(t, nextAllowedStart);
          nextAllowedStart = start + iv;
          if (start > t) await sleep(start - t);
        }
        return await fn();
      } finally {
        // Transfer the permit to the next waiter (active stays put); decrement only if none waits.
        const next = waiters.shift();
        if (next) next();
        else active--;
      }
    },
  };
}

export const DEFAULT_VISION_CONCURRENCY = 1;
export const defaultVisionLimiter = createLimiter(DEFAULT_VISION_CONCURRENCY);
