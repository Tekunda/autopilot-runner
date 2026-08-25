// Per-provider outage circuit breaker shared by the REST clients (notion/rest.ts,
// github/rest.ts). Classic three-state machine: CLOSED runs calls normally; K
// consecutive failures — or a burst of K failures inside a short window — flip it OPEN
// and every call fails FAST with a typed BreakerOpenError instead of touching the
// network, so a dead provider stops absorbing a request per ticket per tick (and
// operators stop getting N copies of the same error). When the cooldown lapses the
// breaker goes HALF_OPEN: exactly ONE probe call is admitted and everyone else fails
// fast until it settles — probe success closes it (full reset), a provider fault
// re-opens it with a grown cooldown. Without that single-probe gate, a cooldown
// expiring under concurrency would thunder the whole queued backlog against a possibly
// still-down provider at once. Cooldown grows exponentially per re-open and any success
// resets everything.
// Fail-open philosophy: a BreakerOpenError is an ordinary thrown error, so it flows
// through the exact paths a real API failure already takes (blocked ticket / notice) --
// nothing is swallowed here.
//
// ponytail: breaker state — including the half-open single-probe gate — is process-local,
// which is correct for today's single-replica deployment; if we ever run multiple replicas
// each will cool down independently and probe separately -- move the open/cooldown state
// behind the control plane's datastore before that happens.

export interface CircuitBreakerConfig {
  /** Provider name used in error messages and notices ("notion", "github"). */
  provider: string;
  /** Consecutive failures (or failures within burstWindowMs) that open it. Default 5. */
  threshold?: number;
  /** First cooldown once opened. Default 30s. */
  baseCooldownMs?: number;
  /** Ceiling for the exponential cooldown growth. Default 10min. */
  maxCooldownMs?: number;
  /** A burst of `threshold` failures inside this window also opens it, catching
   *  interleaved concurrent requests where "consecutive" is ill-defined. Default 60s. */
  burstWindowMs?: number;
  /**
   * Decides whether an error signals PROVIDER ill-health (counts toward opening).
   * Default: every error counts. Clients inject a classifier so caller-caused 4xx
   * responses (bad id, missing page) don't trip an outage breaker.
   */
  countsAsFailure?: (err: unknown) => boolean;
  /** Injectable clock for tests; defaults to Date.now. */
  now?: () => number;
  /**
   * Notice hooks. onOpen fires on every transition into cooldown (including a failed
   * recovery probe re-opening it, with the grown retryInMs); onClose fires once on the
   * success that recovers it. Consumers wanting strictly-one-notice-per-outage can
   * dedupe repeats; firing each transition keeps the payload actionable either way.
   */
  onOpen?: (info: { retryInMs: number }) => void;
  onClose?: () => void;
}

/** Thrown INSTEAD of making a network call while the breaker is open. Deliberately NOT
 *  one of the clients' ApiError classes, so callers can tell "provider cooling down"
 *  apart from a real API response without parsing messages. */
export class BreakerOpenError extends Error {
  readonly provider: string;
  readonly retryInMs: number;

  constructor(provider: string, retryInMs: number) {
    super(`${provider} is in outage cooldown; failing fast, retry allowed in ~${retryInMs}ms`);
    this.name = 'BreakerOpenError';
    this.provider = provider;
    this.retryInMs = retryInMs;
  }
}

export class CircuitBreaker {
  private readonly cfg: Required<Pick<CircuitBreakerConfig, 'provider' | 'threshold' | 'baseCooldownMs' | 'maxCooldownMs' | 'burstWindowMs'>> & CircuitBreakerConfig;
  // Consecutive failures since the last success -- the classic trip-wire.
  private failures = 0;
  // Failure timestamps within the burst window, trimmed as time passes.
  private recentFailureTimes: number[] = [];
  // How many times we've opened since the last success -> exponent for cooldown growth.
  private opens = 0;
  private cooldownUntil = 0;
  // HALF_OPEN marker: the single recovery probe admitted after cooldown expiry is in
  // flight; everyone else fails fast until it settles.
  private probing = false;

  constructor(config: CircuitBreakerConfig) {
    this.cfg = {
      threshold: 5,
      baseCooldownMs: 30_000,
      maxCooldownMs: 10 * 60_000,
      burstWindowMs: 60_000,
      now: Date.now,
      ...config,
    };
  }

  /** Runs `op` under the breaker. While open — or while a recovery probe is in flight —
   *  this throws BreakerOpenError without invoking op at all; a success closes and
   *  resets all state; a counted failure may open or re-open it. */
  async run<T>(op: () => Promise<T>): Promise<T> {
    const start = this.cfg.now!();
    const retryInMs = this.cooldownUntil - start;
    if (retryInMs > 0) throw new BreakerOpenError(this.cfg.provider, retryInMs);

    // HALF_OPEN: the cooldown has lapsed but a previous probe is still unsettled.
    if (this.opens > 0 && this.probing) throw new BreakerOpenError(this.cfg.provider, 0);

    const wasCooling = this.opens > 0;
    if (wasCooling) this.probing = true;
    try {
      const value = await op();
      this.settleHealthy(wasCooling);
      return value;
    } catch (err) {
      if (!this.cfg.countsAsFailure || this.cfg.countsAsFailure(err)) {
        this.recordFailure(this.cfg.now!());
      } else if (wasCooling) {
        // Recovery probe came back with a caller-caused error: the provider answered,
        // so it is demonstrably up — close instead of wedging in half-open forever.
        this.settleHealthy(wasCooling);
      }
      throw err;
    } finally {
      if (wasCooling) this.probing = false;
    }
  }

  /** Probe settled without a provider-health fault: back to CLOSED, everything reset. */
  private settleHealthy(wasCooling: boolean): void {
    // Success fully resets the classic consecutive-failure wire. The burst window is
    // deliberately NOT cleared -- it expires by time alone -- so flapping (fail, ok,
    // fail, ok...) still accumulates into a burst and opens instead of hiding behind
    // the intermittent successes forever.
    this.failures = 0;
    this.opens = 0;
    this.cooldownUntil = 0;
    if (wasCooling) this.cfg.onClose?.();
  }

  /** Queryable state for callers that poll instead of hooking callbacks. Reports open
   *  during cooldown AND while a half-open probe holds the gate (retryInMs 0 then:
   *  refusal there depends on the probe, not on a timer). */
  status(): { open: boolean; retryInMs: number } {
    const now = this.cfg.now!();
    const retryInMs = Math.max(0, this.cooldownUntil - now);
    return { open: retryInMs > 0 || this.probing, retryInMs };
  }

  private recordFailure(at: number): void {
    this.failures += 1;
    this.recentFailureTimes.push(at);
    const cutoff = at - this.cfg.burstWindowMs!;
    while (this.recentFailureTimes.length > 0 && this.recentFailureTimes[0] < cutoff) {
      this.recentFailureTimes.shift();
    }
    // Already open (a recovery probe just failed): grow the cooldown, don't recount.
    if (at < this.cooldownUntil) return;
    if (this.failures < this.cfg.threshold! && this.recentFailureTimes.length < this.cfg.threshold!) return;

    this.opens += 1;
    // Exponential per re-open: base, 2x, 4x... capped. A probe that fails lands here
    // too because `failures` was never reset by opening -- it only resets on success.
    const cooldown = Math.min(this.cfg.baseCooldownMs! * 2 ** (this.opens - 1), this.cfg.maxCooldownMs!);
    this.cooldownUntil = at + cooldown;
    // Fresh cycle: pre-open burst evidence is spent (it just opened the breaker), so the
    // next open decision starts from what happens after this cooldown.
    this.recentFailureTimes = [];
    this.cfg.onOpen?.({ retryInMs: cooldown });
  }
}
