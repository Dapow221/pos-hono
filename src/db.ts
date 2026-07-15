/**
 * Postgres connection pool + transaction helper.
 *
 * Pool size follows the backend convention `(cores * 2) + 1`. Every query goes
 * through the pool; multi-statement work that must be atomic goes through
 * `withTransaction`, which checks out ONE client, runs BEGIN/COMMIT around the
 * callback, and ROLLBACKs on any error. This is what makes the checkout
 * all-or-nothing.
 */
import pg from "pg";
import os from "node:os";
import { env } from "./env";

const poolSize = os.cpus().length * 2 + 1;

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: poolSize,
});

export type Tx = pg.PoolClient;

/**
 * Run `fn` inside a single database transaction. The callback receives a
 * dedicated client; commit happens only if it resolves, otherwise we roll back
 * and re-throw. Nothing the callback wrote survives a failure.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
