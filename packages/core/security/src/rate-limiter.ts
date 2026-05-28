/**
 * In-process token-bucket rate limiter.
 *
 * Each `resource` (e.g. `"user:abc"`, `"tool:http"`) gets its own bucket.
 * `check(resource)` returns whether the request is allowed and consumes one
 * token if so.  Tokens refill at `refillRate` per `windowMs`.
 */
export interface RateLimitResult {
  allowed:    boolean;
  remaining:  number;
  resetAt:    number;   // ms epoch when the bucket will be full again
}

interface Bucket {
  tokens:      number;
  lastRefillMs: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  private readonly maxTokens:  number;
  private readonly refillRate: number;  // tokens per windowMs
  private readonly windowMs:   number;
  constructor(maxTokens: number, refillRate: number, windowMs: number) {
    this.maxTokens  = maxTokens;
    this.refillRate = refillRate;
    this.windowMs   = windowMs;
  }

  check(resource: string): RateLimitResult {
    const now    = Date.now();
    let bucket   = this.buckets.get(resource);

    if (!bucket) {
      bucket = { tokens: this.maxTokens, lastRefillMs: now };
      this.buckets.set(resource, bucket);
    }

    // Refill proportionally to elapsed time
    const elapsed  = now - bucket.lastRefillMs;
    const refilled = (elapsed / this.windowMs) * this.refillRate;
    bucket.tokens  = Math.min(this.maxTokens, bucket.tokens + refilled);
    bucket.lastRefillMs = now;

    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;

    const tokensNeeded = 1 - bucket.tokens;
    const msUntilToken = tokensNeeded > 0
      ? (tokensNeeded / this.refillRate) * this.windowMs
      : 0;

    return {
      allowed,
      remaining: Math.floor(bucket.tokens),
      resetAt:   now + Math.ceil(msUntilToken),
    };
  }

  reset(resource: string): void {
    this.buckets.delete(resource);
  }
}
