/**
 * Demo data generator: ~300 realistic historical sales for dashboard demos.
 *
 * Run manually (`bun run seed:demo`) — never part of migrate or app startup.
 * Idempotent: every row is tagged with a `demo-` idempotency key, and the
 * script exits early if the target count is already present. Historical sales
 * do NOT touch current stock — they happened "in the past".
 *
 * Wipe it all with:  DELETE FROM transactions WHERE idempotency_key LIKE 'demo-%';
 */
import { pool, withTransaction } from "./db";
import { TAX_RATE_PERCENT, ROUNDING_STEP, percentageOf, roundToNearest } from "./money";

const TARGET = 300;
const SPREAD_DAYS = 45;
/** Sales happen during store hours, expressed in the store's UTC+7 time. */
const OPEN_HOUR = 8;
const CLOSE_HOUR = 21;

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

async function main(): Promise<void> {
  const existing = await pool.query(
    `SELECT COUNT(*) AS n FROM transactions WHERE idempotency_key LIKE 'demo-%'`,
  );
  if (Number(existing.rows[0].n) >= TARGET) {
    console.log(`Demo data already present (${existing.rows[0].n} rows) — nothing to do.`);
    await pool.end();
    return;
  }

  const { rows: products } = await pool.query<ProductRow>(
    `SELECT id, sku, name, price FROM products ORDER BY id`,
  );
  const { rows: cashiers } = await pool.query<{ id: string }>(`SELECT id FROM users`);
  if (products.length === 0 || cashiers.length === 0) {
    throw new Error("Run migrate first: demo data needs seeded products and users.");
  }

  await withTransaction(async (tx) => {
    for (let i = 0; i < TARGET; i++) {
      // 1–4 distinct products, weighted toward small baskets.
      const basketSize = pick([1, 1, 1, 2, 2, 3, 4]);
      const chosen = [...products].sort(() => Math.random() - 0.5).slice(0, basketSize);
      const lines = chosen.map((p) => {
        const quantity = randomInt(1, 3);
        return { ...p, quantity, subtotal: p.price * quantity };
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
      // and the occasional split payment.
      let payments: Array<{ method: string; amount: number }>;
      const roll = Math.random();
      if (roll < 0.6) {
        const paid = Math.ceil(grandTotal / 10000) * 10000 || 10000;
        payments = [{ method: "cash", amount: paid }];
      } else if (roll < 0.8) {
        payments = [{ method: "qris", amount: grandTotal }];
      } else if (roll < 0.9) {
        payments = [{ method: "card", amount: grandTotal }];
      } else {
        const cashPart = roundToNearest(Math.floor(grandTotal / 2), ROUNDING_STEP);
        payments = [
          { method: "cash", amount: cashPart },
          { method: "qris", amount: grandTotal - cashPart },
        ];
      }
      const amountPaid = payments.reduce((sum, p) => sum + p.amount, 0);
      const change = amountPaid - grandTotal;

      // Recent days are busier: bias the day offset toward now.
      const daysAgo = Math.floor(Math.pow(Math.random(), 1.4) * SPREAD_DAYS);
      const createdAt = randomStoreTime(daysAgo);

      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO transactions
           (receipt_no, idempotency_key, cashier_id, subtotal, discount, tax, rounding,
            grand_total, amount_paid, change, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id`,
        [
          `RCP-DEMO-${String(i).padStart(4, "0")}`,
          `demo-${i}`,
          pick(cashiers).id,
          subtotal,
          discount,
          tax,
          rounding,
          grandTotal,
          amountPaid,
          change,
          createdAt,
        ],
      );
      const transactionId = inserted.rows[0]!.id;

      for (const line of lines) {
        await tx.query(
          `INSERT INTO transaction_lines (transaction_id, product_id, sku, name, unit_price, quantity, subtotal)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [transactionId, line.id, line.sku, line.name, line.price, line.quantity, line.subtotal],
        );
      }
      for (const payment of payments) {
        await tx.query(
          `INSERT INTO payments (transaction_id, method, amount) VALUES ($1,$2,$3)`,
          [transactionId, payment.method, payment.amount],
        );
      }
    }
  });

  console.log(`Seeded ${TARGET} demo transactions across the last ${SPREAD_DAYS} days.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
