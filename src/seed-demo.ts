/**
 * Demo data generator: realistic historical sales for dashboard/pagination demos.
 *
 * Run manually (`bun run seed:demo [count]`, default 300 — e.g.
 * `bun run seed:demo 20000`). Never part of migrate or app startup.
 * Idempotent-ish: every row is tagged with a `demo-` idempotency key and the
 * script only tops up to the requested count. Historical sales do NOT touch
 * current stock — they happened "in the past".
 *
 * Inserts are batched (multi-row VALUES, client-generated UUIDs) so 20k sales
 * with ~40k lines take seconds, not minutes.
 *
 * Wipe it all with:  DELETE FROM transactions WHERE idempotency_key LIKE 'demo-%';
 */
import { pool, withTransaction, type Tx } from "./db";
import { TAX_RATE_PERCENT, ROUNDING_STEP, percentageOf, roundToNearest } from "./money";

const TARGET = Number(process.argv[2] ?? 300);
if (!Number.isInteger(TARGET) || TARGET < 1 || TARGET > 200_000) {
  console.error("Usage: bun run seed:demo [count 1..200000]");
  process.exit(1);
}

/** Big seeds spread across a full year so 30/90/365-day report ranges all have data. */
const SPREAD_DAYS = TARGET > 2000 ? 365 : 45;
/** Sales happen during store hours, expressed in the store's UTC+7 time. */
const OPEN_HOUR = 8;
const CLOSE_HOUR = 21;
/** Rows per multi-VALUES INSERT (well under Postgres' 65535-parameter cap). */
const BATCH = 1000;

const randomInt = (min: number, max: number): number =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const pick = <T>(arr: readonly T[]): T => arr[randomInt(0, arr.length - 1)]!;

/** A random moment within store hours, `daysAgo` days back, in UTC+7. */
function randomStoreTime(daysAgo: number): Date {
  const now = new Date();
  const day = new Date(now.getTime() - daysAgo * 24 * 3600 * 1000);
  const y = day.toLocaleDateString("en-CA", { timeZone: "Asia/Jakarta" });
  const hour = randomInt(OPEN_HOUR, CLOSE_HOUR - 1);
  const minute = randomInt(0, 59);
  const second = randomInt(0, 59);
  return new Date(
    `${y}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}+07:00`,
  );
}

interface ProductRow {
  id: string;
  sku: string;
  name: string;
  price: number;
}

interface TxnRow {
  id: string;
  receiptNo: string;
  idempotencyKey: string;
  cashierId: string;
  subtotal: number;
  discount: number;
  tax: number;
  rounding: number;
  grandTotal: number;
  amountPaid: number;
  change: number;
  createdAt: Date;
}

interface LineRow {
  transactionId: string;
  productId: string;
  sku: string;
  name: string;
  unitPrice: number;
  quantity: number;
  subtotal: number;
}

interface PaymentRow {
  transactionId: string;
  method: string;
  amount: number;
}

/** Category popularity: drinks sell most, then food/snacks, desserts least. */
function weightFor(sku: string): number {
  if (sku.startsWith("BVG")) return 4;
  if (sku.startsWith("SNK")) return 2;
  if (sku.startsWith("DST")) return 1;
  return 3; // food and anything uncategorised
}

/** Pick `size` DISTINCT products, weighted by category popularity. */
function pickBasket(products: ProductRow[], size: number): ProductRow[] {
  const pool = [...products];
  const chosen: ProductRow[] = [];
  while (chosen.length < size && pool.length > 0) {
    const totalWeight = pool.reduce((sum, p) => sum + weightFor(p.sku), 0);
    let r = Math.random() * totalWeight;
    let idx = pool.length - 1;
    for (let i = 0; i < pool.length; i++) {
      r -= weightFor(pool[i]!.sku);
      if (r <= 0) {
        idx = i;
        break;
      }
    }
    chosen.push(pool.splice(idx, 1)[0]!);
  }
  return chosen;
}

/** One synthetic sale: header + lines + tenders, priced with the real rules. */
function makeSale(
  runTag: string,
  seq: number,
  products: ProductRow[],
  cashiers: Array<{ id: string }>,
): { txn: TxnRow; lines: LineRow[]; payments: PaymentRow[] } {
  const id = crypto.randomUUID();

  // 1–4 distinct products, weighted toward small baskets.
  const basketSize = pick([1, 1, 1, 2, 2, 3, 4]);
  const chosen = pickBasket(products, basketSize);
  const lines: LineRow[] = chosen.map((p) => {
    const quantity = randomInt(1, 3);
    return {
      transactionId: id,
      productId: p.id,
      sku: p.sku,
      name: p.name,
      unitPrice: p.price,
      quantity,
      subtotal: p.price * quantity,
    };
  });
  const subtotal = lines.reduce((sum, l) => sum + l.subtotal, 0);

  // ~20% of sales carry a discount (percentage or a small fixed cut).
  let discount = 0;
  if (Math.random() < 0.2) {
    discount =
      Math.random() < 0.5
        ? percentageOf(subtotal, pick([5, 10, 15]))
        : Math.min(pick([2000, 5000]), subtotal);
  }

  const taxableBase = subtotal - discount;
  const tax = percentageOf(taxableBase, TAX_RATE_PERCENT);
  const grandTotalRaw = taxableBase + tax;
  const grandTotal = roundToNearest(grandTotalRaw, ROUNDING_STEP);
  const rounding = grandTotal - grandTotalRaw;

  // Tender mix: mostly cash (often overpaid → change), some exact qris/card,
  // the occasional split payment, and a slice of online gateway sales.
  let payments: Array<{ method: string; amount: number }>;
  const roll = Math.random();
  if (roll < 0.55) {
    const paid = Math.ceil(grandTotal / 10000) * 10000 || 10000;
    payments = [{ method: "cash", amount: paid }];
  } else if (roll < 0.72) {
    payments = [{ method: "qris", amount: grandTotal }];
  } else if (roll < 0.82) {
    payments = [{ method: "card", amount: grandTotal }];
  } else if (roll < 0.9) {
    payments = [{ method: pick(["midtrans", "xendit"]), amount: grandTotal }];
  } else {
    const cashPart = roundToNearest(Math.floor(grandTotal / 2), ROUNDING_STEP);
    payments = [
      { method: "cash", amount: cashPart },
      { method: "qris", amount: grandTotal - cashPart },
    ];
  }
  const amountPaid = payments.reduce((sum, p) => sum + p.amount, 0);

  // Recent days are busier: bias the day offset toward now.
  const daysAgo = Math.floor(Math.pow(Math.random(), 1.4) * SPREAD_DAYS);

  return {
    txn: {
      id,
      receiptNo: `RCP-D${runTag}-${seq}`,
      idempotencyKey: `demo-${runTag}-${seq}`,
      cashierId: pick(cashiers).id,
      subtotal,
      discount,
      tax,
      rounding,
      grandTotal,
      amountPaid,
      change: amountPaid - grandTotal,
      createdAt: randomStoreTime(daysAgo),
    },
    lines,
    payments: payments.map((p) => ({ transactionId: id, ...p })),
  };
}

/** Multi-row INSERT: one query per batch instead of one per row. */
async function insertBatch(tx: Tx, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  if (rows.length === 0) return;
  const width = columns.length;
  const placeholders = rows
    .map((_, r) => `(${columns.map((_, c) => `$${r * width + c + 1}`).join(",")})`)
    .join(",");
  await tx.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders}`, rows.flat());
}

async function main(): Promise<void> {
  const existing = Number(
    (await pool.query(`SELECT COUNT(*) AS n FROM transactions WHERE idempotency_key LIKE 'demo-%'`))
      .rows[0].n,
  );
  if (existing >= TARGET) {
    console.log(`Demo data already present (${existing} rows >= target ${TARGET}) — nothing to do.`);
    await pool.end();
    return;
  }
  const toCreate = TARGET - existing;

  const { rows: products } = await pool.query<ProductRow>(
    `SELECT id, sku, name, price FROM products ORDER BY id`,
  );
  const { rows: cashiers } = await pool.query<{ id: string }>(`SELECT id FROM users`);
  if (products.length === 0 || cashiers.length === 0) {
    throw new Error("Run migrate first: demo data needs seeded products and users.");
  }

  // Unique per-run tag so receipts/idempotency keys never collide with earlier runs.
  const runTag = Date.now().toString(36).toUpperCase();
  const started = Date.now();

  await withTransaction(async (tx) => {
    for (let done = 0; done < toCreate; done += BATCH) {
      const n = Math.min(BATCH, toCreate - done);
      const txns: unknown[][] = [];
      const lines: unknown[][] = [];
      const payments: unknown[][] = [];

      for (let i = 0; i < n; i++) {
        const sale = makeSale(runTag, done + i, products, cashiers);
        txns.push([
          sale.txn.id, sale.txn.receiptNo, sale.txn.idempotencyKey, sale.txn.cashierId,
          sale.txn.subtotal, sale.txn.discount, sale.txn.tax, sale.txn.rounding,
          sale.txn.grandTotal, sale.txn.amountPaid, sale.txn.change, sale.txn.createdAt,
        ]);
        for (const l of sale.lines) {
          lines.push([l.transactionId, l.productId, l.sku, l.name, l.unitPrice, l.quantity, l.subtotal]);
        }
        for (const p of sale.payments) payments.push([p.transactionId, p.method, p.amount]);
      }

      await insertBatch(tx, "transactions",
        ["id", "receipt_no", "idempotency_key", "cashier_id", "subtotal", "discount",
         "tax", "rounding", "grand_total", "amount_paid", "change", "created_at"],
        txns);
      await insertBatch(tx, "transaction_lines",
        ["transaction_id", "product_id", "sku", "name", "unit_price", "quantity", "subtotal"],
        lines);
      await insertBatch(tx, "payments", ["transaction_id", "method", "amount"], payments);

      console.log(`  ${Math.min(done + n, toCreate)}/${toCreate}…`);
    }
  });

  console.log(
    `Seeded ${toCreate} demo transactions (total ${TARGET}) across the last ${SPREAD_DAYS} days ` +
    `in ${((Date.now() - started) / 1000).toFixed(1)}s.`,
  );
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
