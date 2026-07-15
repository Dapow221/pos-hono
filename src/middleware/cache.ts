/**
 * Response cache middleware for the report endpoints.
 *
 * Key shape: v1:reports:{version}:{path}?{sorted query} — sorting the params
 * makes ?from=a&to=b and ?to=b&from=a share one entry. Runs after the auth
 * guard, so unauthorized requests never touch the cache. Only 200s are stored.
 */
import type { MiddlewareHandler } from "hono";
import { cacheGet, cacheSet, reportsCacheVersion, REPORTS_CACHE_TTL_SEC } from "../cache";

export function reportsCache(ttlSec = REPORTS_CACHE_TTL_SEC): MiddlewareHandler {
  return async (c, next) => {
    const version = await reportsCacheVersion();
    if (version === null) return next(); // Redis down — serve straight from Postgres.

    const query = Object.entries(c.req.query())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join("&");
    const key = `v1:reports:${version}:${c.req.path}?${query}`;

    const hit = await cacheGet(key);
    if (hit !== null) {
      return c.body(hit, 200, {
        "Content-Type": "application/json; charset=UTF-8",
        "X-Cache": "HIT",
      });
    }

    await next();

    if (c.res.status === 200) {
      await cacheSet(key, await c.res.clone().text(), ttlSec);
      c.res.headers.set("X-Cache", "MISS");
    }
  };
}
