/**
 * Rate limiting utilities for API routes.
 * Provides in-memory rate limiting with configurable windows and limits.
 */

/**
 * Rate limit configuration options.
 */
export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window */
  limit: number;
  /** Time window in milliseconds */
  windowMs: number;
}

/**
 * Rate limit check result.
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Number of remaining requests in the window */
  remaining: number;
  /** Timestamp when the rate limit resets */
  resetTime: number;
  /** Seconds until rate limit resets (for Retry-After header) */
  retryAfter: number;
}

/**
 * Internal storage for rate limit tracking.
 */
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

/**
 * In-memory rate limit store.
 * Note: This resets on server restart. For production, consider Redis.
 */
const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Default rate limit configuration.
 * 100 requests per minute per IP.
 */
const DEFAULT_CONFIG: RateLimitConfig = {
  limit: 100,
  windowMs: 60 * 1000,
};

/**
 * Cleans up expired entries from the rate limit store.
 * Called periodically to prevent memory leaks.
 */
function cleanupExpiredEntries(): void {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetTime <= now) {
      rateLimitStore.delete(key);
    }
  }
}

/**
 * Checks rate limit for a given identifier (typically IP address).
 *
 * @param identifier - Unique identifier for the client (IP address, user ID, etc.)
 * @param config - Rate limit configuration
 * @returns Rate limit check result
 * @example
 * ```typescript
 * const result = checkRateLimit(request.ip, { limit: 10, windowMs: 60000 });
 * if (!result.allowed) {
 *   return new Response("Too many requests", {
 *     status: 429,
 *     headers: { "Retry-After": result.retryAfter.toString() }
 *   });
 * }
 * ```
 */
export function checkRateLimit(
  identifier: string,
  config: Partial<RateLimitConfig> = {}
): RateLimitResult {
  const { limit, windowMs } = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();
  const key = identifier;

  const entry = rateLimitStore.get(key);

  if (!entry || entry.resetTime <= now) {
    const resetTime = now + windowMs;
    rateLimitStore.set(key, { count: 1, resetTime });

    return {
      allowed: true,
      remaining: limit - 1,
      resetTime,
      retryAfter: 0,
    };
  }

  entry.count += 1;
  const allowed = entry.count <= limit;
  const remaining = Math.max(0, limit - entry.count);
  const retryAfter = allowed ? 0 : Math.ceil((entry.resetTime - now) / 1000);

  return {
    allowed,
    remaining,
    resetTime: entry.resetTime,
    retryAfter,
  };
}

/**
 * Creates a rate limiter with the specified configuration.
 * Returns a function that can be called with an identifier to check rate limits.
 *
 * @param config - Rate limit configuration
 * @returns Rate limit check function
 * @example
 * ```typescript
 * const apiLimiter = createRateLimiter({ limit: 100, windowMs: 60000 });
 * const authLimiter = createRateLimiter({ limit: 5, windowMs: 300000 });
 *
 * // In API route:
 * const result = apiLimiter(request.ip);
 * ```
 */
export function createRateLimiter(
  config: Partial<RateLimitConfig> = {}
): (identifier: string) => RateLimitResult {
  return (identifier: string) => checkRateLimit(identifier, config);
}

/**
 * Resets rate limit for a specific identifier.
 * Useful for testing or when a user authenticates.
 *
 * @param identifier - The identifier to reset
 */
export function resetRateLimit(identifier: string): void {
  rateLimitStore.delete(identifier);
}

/**
 * Gets the current rate limit status for an identifier without incrementing.
 *
 * @param identifier - The identifier to check
 * @param config - Rate limit configuration
 * @returns Current rate limit status or null if no limit exists
 */
export function getRateLimitStatus(
  identifier: string,
  config: Partial<RateLimitConfig> = {}
): RateLimitResult | null {
  const { limit } = { ...DEFAULT_CONFIG, ...config };
  const now = Date.now();
  const entry = rateLimitStore.get(identifier);

  if (!entry || entry.resetTime <= now) {
    return null;
  }

  return {
    allowed: entry.count < limit,
    remaining: Math.max(0, limit - entry.count),
    resetTime: entry.resetTime,
    retryAfter: Math.ceil((entry.resetTime - now) / 1000),
  };
}

// Cleanup expired entries every minute
if (typeof setInterval !== "undefined" && process.env.NODE_ENV !== "test") {
  setInterval(cleanupExpiredEntries, 60 * 1000);
}
