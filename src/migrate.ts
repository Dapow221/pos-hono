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

-- Quick-switch PIN for the cashier screen. Hashed like a password — never plaintext.
ALTER TABLE users ADD COLUMN IF NOT EXISTS pin_hash TEXT;

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

-- Newest-first pagination of the transaction log; id breaks created_at ties.
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at, id);

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

-- Online payments via Midtrans/Xendit. The cart is stored as JSONB and the sale
-- is only finalized (stock decremented, transaction created) when the gateway's
-- webhook confirms payment. external_ref is the order id we hand the gateway;
-- UNIQUE so a webhook can never be matched to two payments.
CREATE TABLE IF NOT EXISTS gateway_payments (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider         TEXT NOT NULL CHECK (provider IN ('midtrans', 'xendit')),
  external_ref     TEXT UNIQUE NOT NULL,
  provider_ref     TEXT,
  idempotency_key  TEXT UNIQUE NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'paid', 'failed', 'expired')),
  amount           INTEGER NOT NULL CHECK (amount >= 0),
  payment_url      TEXT,
  cart             JSONB NOT NULL,
  cashier_id       TEXT,
  transaction_id   UUID REFERENCES transactions(id),
  finalize_error   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_gateway_payments_status ON gateway_payments(status);

-- Kartu stok: one row per stock movement, signed quantity (sales and waste are
-- negative). Sales are written by checkout in the same DB transaction that
-- decrements stock, so the ledger can always be reconciled against stock.
CREATE TABLE IF NOT EXISTS stock_movements (
  id          BIGSERIAL PRIMARY KEY,
  product_id  TEXT NOT NULL REFERENCES products(id),
  type        TEXT NOT NULL CHECK (type IN ('sale', 'goods_in', 'adjustment', 'opname')),
  quantity    INTEGER NOT NULL,
  unit_cost   INTEGER CHECK (unit_cost >= 0),
  supplier    TEXT,
  note        TEXT,
  ref         TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements(created_at, id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);

-- Pembukuan: operating expenses (bahan baku, gaji, sewa, ...). Amounts are
-- whole rupiah like everywhere else; spent_on is the store-time calendar date.
CREATE TABLE IF NOT EXISTS expenses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category    TEXT NOT NULL,
  description TEXT NOT NULL,
  amount      INTEGER NOT NULL CHECK (amount > 0),
  spent_on    DATE NOT NULL,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expenses_spent_on ON expenses(spent_on);
`;

// id, sku, name, price (whole rupiah), stock.
// SKU prefixes: BVG = minuman, FD = makanan, SNK = camilan, DST = dessert.
const SEED: ReadonlyArray<[string, string, string, number, number]> = [
  // ── Minuman ────────────────────────────────────────────────────────────
  ["p_kopi", "BVG-001", "Kopi Susu", 18000, 50],
  ["p_teh", "BVG-002", "Teh Manis", 8000, 100],
  ["p_air", "BVG-003", "Air Mineral", 5000, 200],
  ["p_kopi_aren", "BVG-004", "Es Kopi Gula Aren", 22000, 60],
  ["p_americano", "BVG-005", "Americano", 20000, 60],
  ["p_cappuccino", "BVG-006", "Cappuccino", 25000, 60],
  ["p_latte", "BVG-007", "Cafe Latte", 26000, 60],
  ["p_matcha", "BVG-008", "Matcha Latte", 28000, 40],
  ["p_coklat_panas", "BVG-009", "Cokelat Panas", 24000, 40],
  ["p_es_teh", "BVG-010", "Es Teh Manis", 10000, 120],
  ["p_teh_tarik", "BVG-011", "Teh Tarik", 15000, 80],
  ["p_es_jeruk", "BVG-012", "Es Jeruk", 12000, 90],
  ["p_jus_alpukat", "BVG-013", "Jus Alpukat", 18000, 40],
  ["p_jus_mangga", "BVG-014", "Jus Mangga", 16000, 40],
  ["p_lemon_tea", "BVG-015", "Lemon Tea", 14000, 70],
  // ── Makanan ────────────────────────────────────────────────────────────
  ["p_roti", "FD-001", "Roti Bakar Coklat", 15000, 30],
  ["p_nasi", "FD-002", "Nasi Goreng", 25000, 20],
  ["p_mie_goreng", "FD-004", "Mie Goreng Spesial", 22000, 40],
  ["p_ayam_geprek", "FD-005", "Nasi Ayam Geprek", 28000, 35],
  ["p_ayam_penyet", "FD-006", "Ayam Penyet", 30000, 30],
  ["p_sate_ayam", "FD-007", "Sate Ayam (10 tusuk)", 35000, 25],
  ["p_soto_ayam", "FD-008", "Soto Ayam", 25000, 30],
  ["p_bakso", "FD-009", "Bakso Sapi", 20000, 45],
  ["p_gado_gado", "FD-010", "Gado-Gado", 18000, 30],
  ["p_nasi_uduk", "FD-011", "Nasi Uduk Komplit", 23000, 30],
  ["p_capcay", "FD-012", "Capcay Goreng", 24000, 25],
  ["p_nasi_rendang", "FD-013", "Nasi Rendang", 35000, 20],
  // ── Camilan ────────────────────────────────────────────────────────────
  ["p_pisang_goreng", "SNK-001", "Pisang Goreng (3 pcs)", 12000, 50],
  ["p_tahu_isi", "SNK-002", "Tahu Isi (3 pcs)", 10000, 50],
  ["p_cireng", "SNK-003", "Cireng Bumbu Rujak", 10000, 50],
  ["p_kentang_goreng", "SNK-004", "Kentang Goreng", 15000, 60],
  ["p_dimsum", "SNK-005", "Dimsum Ayam (4 pcs)", 18000, 40],
  ["p_risoles", "SNK-006", "Risoles Mayo (2 pcs)", 12000, 40],
  // ── Dessert ────────────────────────────────────────────────────────────
  ["p_martabak_mini", "DST-001", "Martabak Manis Mini", 20000, 30],
  ["p_klepon", "DST-002", "Klepon (5 pcs)", 10000, 40],
  ["p_puding_coklat", "DST-003", "Puding Coklat", 12000, 40],
  ["p_es_krim", "DST-004", "Es Krim Vanilla", 15000, 60],
  ["p_pisang_coklat", "DST-005", "Pisang Coklat Keju", 16000, 40],
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
