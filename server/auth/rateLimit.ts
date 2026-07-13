/**
 * Sliding-window rate limiter — in-memory, per-process.
 *
 * A general-purpose throttle keyed by an arbitrary string. The bucket key is
 * chosen by the caller (e.g. a client IP) so abusive callers can be slowed
 * without penalising everyone.
 *
 * Storage is a `Map<key, number[]>` of attempt timestamps. Old entries fall
 * out of the window lazily on each access; `consume()` additionally runs an
 * opportunistic full prune — every `PRUNE_INTERVAL` calls, or as soon as the
 * map exceeds `PRUNE_SIZE_THRESHOLD` keys — so attacker-controlled
 * `(ip, email)` keys that go quiet cannot grow the map unbounded in a
 * long-lived process. The common path stays allocation-free: one counter
 * bump and a size check.
 *
 * Why in-memory instead of Redis or a DB table?
 *   - The CMS deploys as a single Bun process (the SQLite trade-off applies
 *     equally to PG-backed deployments — admin login is rare, single-writer).
 *   - No external dep, no extra container.
 *   - Counter loss on restart is acceptable: an attacker who waits for a
 *     restart still has to start over from scratch on the next attempt set.
 */

interface RateLimitDecision {
  ok: boolean
  /** When `ok === false`, ms until the oldest in-window attempt expires. */
  retryAfterMs: number
  /** Remaining slots in the current window (0 when blocked). */
  remaining: number
}

interface Bucket {
  /** Attempt timestamps in ms-since-epoch, oldest first. */
  attempts: number[]
}

interface RateLimiterOptions {
  /** Maximum allowed attempts per window. */
  limit: number
  /** Sliding window duration in milliseconds. */
  windowMs: number
}

export class RateLimiter {
  /** `consume()` calls between opportunistic prune sweeps. */
  static readonly PRUNE_INTERVAL = 1024
  /** Bucket count that forces a prune sweep on the next `consume()`. */
  static readonly PRUNE_SIZE_THRESHOLD = 4096

  private readonly buckets = new Map<string, Bucket>()
  private readonly options: RateLimiterOptions
  private callsSincePrune = 0

  constructor(options: RateLimiterOptions) {
    if (options.limit < 1) throw new Error('RateLimiter: limit must be >= 1')
    if (options.windowMs < 1) throw new Error('RateLimiter: windowMs must be >= 1')
    this.options = options
  }

  /**
   * Record an attempt against `key` and return whether it is allowed under
   * the current sliding window. Rejected attempts are NOT recorded
   * (sliding-window-log semantics): the window stays anchored to accepted
   * attempts, so a spamming client can neither grow its bucket unboundedly
   * nor push back the moment its oldest accepted attempt ages out.
   *
   * Pass `now` explicitly in tests; production callers omit it.
   */
  consume(key: string, now: number = Date.now()): RateLimitDecision {
    // Opportunistic housekeeping (see module header). Runs BEFORE the bucket
    // lookup so this call can never push onto a bucket the sweep just
    // deleted. Pruning only drops fully-aged-out attempts, which the
    // per-bucket filter below ignores anyway — limit decisions are unchanged.
    this.callsSincePrune += 1
    if (
      this.callsSincePrune >= RateLimiter.PRUNE_INTERVAL ||
      this.buckets.size > RateLimiter.PRUNE_SIZE_THRESHOLD
    ) {
      this.callsSincePrune = 0
      this.prune(now)
    }

    const { limit, windowMs } = this.options
    const cutoff = now - windowMs

    let bucket = this.buckets.get(key)
    if (!bucket) {
      bucket = { attempts: [] }
      this.buckets.set(key, bucket)
    }

    // Drop attempts that have aged out of the window.
    if (bucket.attempts.length > 0 && bucket.attempts[0]! <= cutoff) {
      bucket.attempts = bucket.attempts.filter((t) => t > cutoff)
    }

    if (bucket.attempts.length >= limit) {
      const oldest = bucket.attempts[0]!
      return {
        ok: false,
        retryAfterMs: oldest + windowMs - now,
        remaining: 0,
      }
    }

    bucket.attempts.push(now)
    return {
      ok: true,
      retryAfterMs: 0,
      remaining: limit - bucket.attempts.length,
    }
  }

  /** Reset the bucket for `key` — call on successful login to give the user a fresh quota. */
  reset(key: string): void {
    this.buckets.delete(key)
  }

  /**
   * Drop empty / fully-aged-out buckets. Invoked opportunistically from
   * `consume()`; the per-call filter there already prevents stale data from
   * affecting decisions, so pruning only frees memory — it never changes a
   * limit decision.
   */
  prune(now: number = Date.now()): void {
    const cutoff = now - this.options.windowMs
    for (const [key, bucket] of this.buckets) {
      bucket.attempts = bucket.attempts.filter((t) => t > cutoff)
      if (bucket.attempts.length === 0) this.buckets.delete(key)
    }
  }

  /** Diagnostics — number of unique keys currently tracked. */
  size(): number {
    return this.buckets.size
  }
}
