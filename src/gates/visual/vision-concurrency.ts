// A process-wide FIFO gate on how many vision-model calls are in flight at once. The two vision
// gates (design-review, visual-qa) run concurrently within a site and each contributes at most one
// serial in-flight call, so a net max of 2 hits the Anthropic vision model simultaneously -- which
// self-inflicts a 429 and turns both gates into an infra SKIP. A shared limiter of 1 serializes
// them. Sites run sequentially, so no cross-site coordination is needed and one process-wide
// limiter suffices.

export interface VisionLimiter {
  run<T>(fn: () => Promise<T>): Promise<T>;
}

// A FIFO concurrency gate: run() admits up to `limit` fns at once and queues the rest. Because it
// SERIALIZES, calling limiter.run re-entrantly on the SAME limiter while it is at cap self-deadlocks
// (the inner call parks forever behind the outer one that is waiting on it) -- fine for the vision
// use where each judge call is a leaf, but a caller of the exported primitive must not nest.
export function createLimiter(limit: number): VisionLimiter {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`createLimiter: limit must be a positive integer, got ${limit}`);
  }
  // `active` counts permits currently HELD -- either running, or handed off to a waiter that has not
  // yet resumed. It never dips below the number of live holders, which is what closes the late-arriver
  // race: a caller that sees `active >= limit` always parks, because a released permit is TRANSFERRED
  // straight to the next waiter (active unchanged) rather than decremented-then-re-incremented, so
  // there is no window between a release and a resume in which `active` reads below the cap.
  let active = 0;
  const waiters: Array<() => void> = [];
  return {
    async run<T>(fn: () => Promise<T>): Promise<T> {
      if (active >= limit) {
        // Park until a releaser hands us its permit; on resume we already HOLD it -- do not increment.
        await new Promise<void>((resolve) => waiters.push(resolve));
      } else {
        active++;
      }
      try {
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
