/**
 * Schema + seed. Idempotent: safe to run repeatedly (`bun run src/migrate.ts`).
 *
 * Money columns are INTEGER rupiah. `transactions.idempotency_key` carries a
 * UNIQUE constraint — that's the database-level guarantee that the same retried
 * checkout can never create two sales, even under a race.
 */
import { pool } from "./db";
import { ROLE_PERMISSIONS } from "./auth/rbac";
import { hashPassword } from "./auth/password";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS roles (
  name         TEXT PRIMARY KEY,
  permissions  TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL REFERENCES roles(name),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash         TEXT UNIQUE NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  replaced_token_id  UUID REFERENCES refresh_tokens(id),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user_id ON refresh_tokens(user_id);

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,
  sku         TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  price       INTEGER NOT NULL CHECK (price >= 0),
  stock       INTEGER NOT NULL CHECK (stock >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_no       TEXT UNIQUE NOT NULL,
  idempotency_key  TEXT UNIQUE NOT NULL,
  cashier_id       TEXT,
  subtotal         INTEGER NOT NULL,
  discount         INTEGER NOT NULL,
  tax              INTEGER NOT NULL,
  rounding         INTEGER NOT NULL,
  grand_total      INTEGER NOT NULL,
  amount_paid      INTEGER NOT NULL,
  change           INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS transaction_lines (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  product_id      TEXT NOT NULL REFERENCES products(id),
  sku             TEXT NOT NULL,
  name            TEXT NOT NULL,
  unit_price      INTEGER NOT NULL,
  quantity        INTEGER NOT NULL CHECK (quantity > 0),
  subtotal        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lines_transaction_id ON transaction_lines(transaction_id);

CREATE TABLE IF NOT EXISTS payments (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  method          TEXT NOT NULL,
  amount          INTEGER NOT NULL CHECK (amount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_payments_transaction_id ON payments(transaction_id);
`;

const SEED: ReadonlyArray<[string, string, string, number, number]> = [
  ["p_kopi", "BVG-001", "Kopi Susu", 18000, 50],
  ["p_teh", "BVG-002", "Teh Manis", 8000, 100],
  ["p_roti", "FD-001", "Roti Bakar Coklat", 15000, 30],
  ["p_nasi", "FD-002", "Nasi Goreng", 25000, 20],
  ["p_air", "BVG-003", "Air Mineral", 5000, 200],
];

// Demo accounts (change passwords before any real use).
const SEED_USERS: ReadonlyArray<[string, string, string, string]> = [
  // email, password, fullName, role
  ["admin@pos.test", "Admin123!", "Admin Toko", "admin"],
  ["kasir@pos.test", "Kasir123!", "Kasir Satu", "cashier"],
];

async function main(): Promise<void> {
  await pool.query(SCHEMA);

  // Roles + permissions (kept in sync with src/auth/rbac.ts).
  for (const [name, permissions] of Object.entries(ROLE_PERMISSIONS)) {
    await pool.query(
      `INSERT INTO roles (name, permissions) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE SET permissions = EXCLUDED.permissions`,
      [name, permissions],
    );
  }

  // Demo users (idempotent: skip if the email already exists).
  for (const [email, password, fullName, role] of SEED_USERS) {
    const passwordHash = await hashPassword(password);
    await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role) VALUES ($1,$2,$3,$4)
       ON CONFLICT (email) DO NOTHING`,
      [email, passwordHash, fullName, role],
    );
  }

  for (const [id, sku, name, price, stock] of SEED) {
    // ON CONFLICT DO NOTHING keeps the seed idempotent and never resets stock.
    await pool.query(
      `INSERT INTO products (id, sku, name, price, stock) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [id, sku, name, price, stock],
    );
  }
  console.log(
    "Migration complete. Seeded",
    Object.keys(ROLE_PERMISSIONS).length,
    "roles,",
    SEED_USERS.length,
    "users,",
    SEED.length,
    "products.",
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
