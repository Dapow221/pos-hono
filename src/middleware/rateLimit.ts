/**
 * Simple fixed-window rate limiter (in-memory).
 *
 * Used to protect auth endpoints more aggressively (login/refresh/register) per
 * the project rule of ~5 req/min per IP. In-memory is fine for a single node;
 * a multi-node deployment would back this with Redis.
 */
import type { MiddlewareHandler } from "hono";
import { AppError } from "../errors";

interface Bucket {
  count: number;
  resetAt: number; // epoch ms
}

export function rateLimit(opts: { windowMs: number; max: number }): MiddlewareHandler {
  const buckets = new Map<string, Bucket>();

  return async (c, next) => {
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";

    const now = Date.now();
    const bucket = buckets.get(ip);

    if (!bucket || now >= bucket.resetAt) {
      buckets.set(ip, { count: 1, resetAt: now + opts.windowMs });
    } else {
      bucket.count += 1;
      if (bucket.count > opts.max) {
        const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
        c.header("Retry-After", String(retryAfter));
        throw new AppError(429, "RATE_LIMITED", "Too many requests. Please slow down.", {
          retryAfterSeconds: retryAfter,
        });
      }
    }
    await next();
  };
}
