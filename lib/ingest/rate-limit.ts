/**
 * Token-bucket rate limiter for ingest and admin Route Handlers.
 *
 * Serverless enforcement note:
 * - Login attempts (`/auth/v1/token`) are rate-limited globally across all instances by Supabase Auth.
 * - Route Handler buckets below live in Node process memory (`Map`), so on Vercel Serverless each warm
 *   function instance maintains its own bucket state. With <= 5 edge devices and a small admin team,
 *   this guards against runaway retry loops or accidental floods hitting a warm instance, while
 *   cryptographic bearer/session authentication (`sha256Hex` device key lookup, `timingSafeEqual`
 *   admin token, or Supabase Auth JWT) protects every cold or warm invocation.
 * - If strict cross-instance rate limiting is ever needed, replace `buckets` with Upstash Redis
 *   (`@upstash/ratelimit`).
 */
export interface RateLimitOptions {
  capacity?: number;
  refillPerSec?: number;
  now?: number;
}

const DEFAULT_CAPACITY = 60;
const DEFAULT_REFILL_PER_S = 1;
const MAX_BUCKETS = 5_000;

const buckets = new Map<string, { tokens: number; last: number }>();

export function rateLimit(
  key: string,
  nowOrOpts: number | RateLimitOptions = Date.now(),
): { ok: boolean; retryAfterS: number } {
  const opts: RateLimitOptions =
    typeof nowOrOpts === "number" ? { now: nowOrOpts } : nowOrOpts;
  const now = opts.now ?? Date.now();
  const capacity = opts.capacity ?? DEFAULT_CAPACITY;
  const refillPerSec = opts.refillPerSec ?? DEFAULT_REFILL_PER_S;

  if (buckets.size >= MAX_BUCKETS && !buckets.has(key)) {
    const oldestKey = buckets.keys().next().value;
    if (oldestKey !== undefined) buckets.delete(oldestKey);
  }

  const b = buckets.get(key) ?? { tokens: capacity, last: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.last) / 1000) * refillPerSec);
  b.last = now;
  const ok = b.tokens >= 1;
  if (ok) b.tokens -= 1;
  buckets.set(key, b);
  return { ok, retryAfterS: ok ? 0 : Math.max(1, Math.ceil((1 - b.tokens) / refillPerSec)) };
}

export function extractClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const realIp = req.headers.get("x-real-ip")?.trim();
  if (realIp) return realIp;
  return "unknown";
}

export function _resetRateLimits(): void {
  buckets.clear();
}
