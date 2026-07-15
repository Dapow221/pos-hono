/**
 * Redis report cache — Bun's native client, zero npm dependencies.
 *
 * Fail-open by design: every operation swallows Redis errors and returns
 * null/no-op, so a dead Redis degrades to "no cache" instead of 500s.
 *
 * Invalidation is O(1): cache keys embed a version counter that checkout and
 * product writes bump. A bump makes every old key unreachable immediately;
 * the orphans simply age out via their TTL.
 */
import { RedisClient } from "bun";
import { env } from "./env";

function makeClient(): RedisClient {
  // No offline queue: while Redis is down, commands throw immediately instead
  // of buffering for 10s — the middleware then skips the cache for that request.
  return new RedisClient(env.REDIS_URL, {
    enableOfflineQueue: false,
    connectionTimeout: 1000,
  });
}

let client = makeClient();
client.connect().catch(() => {}); // initial dial; failures go through ensureConnected

/** Hard budget per cache op: slower than this and the DB path wins anyway. */
const OP_TIMEOUT_MS = 300;

/**
 * A closed client can't be revived, so recovery = dial a FRESH client in the
 * background (throttled) and swap it in once it connects. Requests meanwhile
 * fail fast and skip the cache.
 */
const RECONNECT_THROTTLE_MS = 5000;
let connecting = false;
let lastConnectAttempt = 0;

function ensureConnected(): void {
  const now = Date.now();
  if (client.connected || connecting || now - lastConnectAttempt < RECONNECT_THROTTLE_MS) return;
  lastConnectAttempt = now;
  connecting = true;
  const fresh = makeClient();
  fresh
    .connect()
    .then(() => {
      client.close();
      client = fresh;
    })
    .catch(() => fresh.close()) // stays down — next failed op tries again
    .finally(() => {
      connecting = false;
    });
}

function withTimeout<T>(op: Promise<T>): Promise<T> {
  return Promise.race([
    op,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Redis op exceeded ${OP_TIMEOUT_MS}ms`)), OP_TIMEOUT_MS),
    ),
  ]);
}

const VERSION_KEY = "v1:reports:ver";
/** Orphaned entries (after a version bump) linger at most this long. */
export const REPORTS_CACHE_TTL_SEC = 300;
/** The version counter itself is tiny but still gets a TTL — no immortal keys. */
const VERSION_TTL_SEC = 30 * 24 * 3600;

let warnedDown = false;
function warnOnce(err: unknown): void {
  if (warnedDown) return;
  warnedDown = true;
  console.error("Redis unavailable — report cache disabled:", err instanceof Error ? err.message : err);
}

/** Current cache generation, or null when Redis is unreachable (= skip cache). */
export async function reportsCacheVersion(): Promise<string | null> {
  try {
    const ver = (await withTimeout(client.get(VERSION_KEY))) ?? "0";
    warnedDown = false;
    return ver;
  } catch (err) {
    warnOnce(err);
    ensureConnected();
    return null;
  }
}

/** Invalidate all cached reports. Called after checkout / product writes. */
export async function bumpReportsCacheVersion(): Promise<void> {
  try {
    await withTimeout(client.incr(VERSION_KEY));
    await withTimeout(client.expire(VERSION_KEY, VERSION_TTL_SEC));
  } catch (err) {
    warnOnce(err);
  }
}

export async function cacheGet(key: string): Promise<string | null> {
  try {
    return await withTimeout(client.get(key));
  } catch (err) {
    warnOnce(err);
    return null;
  }
}

export async function cacheSet(key: string, value: string, ttlSec: number): Promise<void> {
  try {
    await withTimeout(client.send("SET", [key, value, "EX", String(ttlSec)]));
  } catch (err) {
    warnOnce(err);
  }
}
