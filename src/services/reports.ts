/**
 * Dashboard/report queries.
 *
 * All money aggregates come back from Postgres as BIGINT (SUM of INTEGER),
 * which pg delivers as strings — every function maps them through Number()
 * before returning. Days are bucketed in REPORT_TIMEZONE, not server time,
 * so "today's sales" means the store's today.
 */
import { pool } from "../db";
import { Errors } from "../errors";

/** The store operates in Indonesian western time; day buckets follow it. */
export const REPORT_TIMEZONE = "Asia/Jakarta";

const MAX_RANGE_DAYS = 366;
const DEFAULT_RANGE_DAYS = 30;

export interface ReportRange {
  /** Inclusive, YYYY-MM-DD in REPORT_TIMEZONE. */
  from: string;
  /** Inclusive, YYYY-MM-DD in REPORT_TIMEZONE. */
  to: string;
}

/** Shift a YYYY-MM-DD string by whole days (calendar math in UTC). */
function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function todayInStoreTime(): string {
  // en-CA formats as YYYY-MM-DD.
  return new Date().toLocaleDateString("en-CA", { timeZone: REPORT_TIMEZONE });
}

/** Apply defaults (last 30 days, ending today) and reject inverted/huge ranges. */
export function resolveRange(input: { from?: string; to?: string }): ReportRange {
  const to = input.to ?? todayInStoreTime();
  const from = input.from ?? shiftDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (from > to) throw Errors.validation("'from' must be on or before 'to'.");
  if (shiftDays(from, MAX_RANGE_DAYS) <= to) {
    throw Errors.validation(`Date range is capped at ${MAX_RANGE_DAYS} days.`);
  }
  return { from, to };
}

/** WHERE fragment shared by every range-filtered query ($1=from, $2=to). */
const IN_RANGE = `(t.created_at AT TIME ZONE '${REPORT_TIMEZONE}')::date BETWEEN $1 AND $2`;

export interface SalesSummary {
  transactions: number;
  grossRevenue: number;
  itemsSold: number;
  discountTotal: number;
  taxTotal: number;
  averageTicket: number;
}

export async function getSummary(range: ReportRange): Promise<SalesSummary> {
  const { rows } = await pool.query(
    `SELECT COUNT(*)                                   AS transactions,
            COALESCE(SUM(t.grand_total), 0)            AS gross_revenue,
            COALESCE(SUM(t.discount), 0)               AS discount_total,
            COALESCE(SUM(t.tax), 0)                    AS tax_total,
            COALESCE((SELECT SUM(l.quantity)
                        FROM transaction_lines l
                        JOIN transactions t ON t.id = l.transaction_id
                       WHERE ${IN_RANGE}), 0)          AS items_sold
       FROM transactions t
      WHERE ${IN_RANGE}`,
    [range.from, range.to],
  );
  const r = rows[0];
  const transactions = Number(r.transactions);
  const grossRevenue = Number(r.gross_revenue);
  return {
    transactions,
    grossRevenue,
    itemsSold: Number(r.items_sold),
    discountTotal: Number(r.discount_total),
    taxTotal: Number(r.tax_total),
    averageTicket: transactions === 0 ? 0 : Math.round(grossRevenue / transactions),
  };
}

export interface DailySales {
  date: string;
  transactions: number;
  revenue: number;
}

/** One row per day in the range — zero-filled so charts have no gaps. */
export async function getSalesByDay(range: ReportRange): Promise<DailySales[]> {
  const { rows } = await pool.query(
    `SELECT d.day::date::text              AS date,
            COUNT(t.id)                    AS transactions,
            COALESCE(SUM(t.grand_total),0) AS revenue
       FROM generate_series($1::date, $2::date, '1 day') AS d(day)
       LEFT JOIN transactions t
         ON (t.created_at AT TIME ZONE '${REPORT_TIMEZONE}')::date = d.day::date
      GROUP BY d.day::date
      ORDER BY d.day::date`,
    [range.from, range.to],
  );
  return rows.map((r) => ({
    date: r.date,
    transactions: Number(r.transactions),
    revenue: Number(r.revenue),
  }));
}

export interface TopProduct {
  productId: string;
  sku: string;
  name: string;
  quantitySold: number;
  revenue: number;
}

export async function getTopProducts(range: ReportRange, limit: number): Promise<TopProduct[]> {
  const { rows } = await pool.query(
    `SELECT l.product_id, l.sku, l.name,
            SUM(l.quantity) AS quantity_sold,
            SUM(l.subtotal) AS revenue
       FROM transaction_lines l
       JOIN transactions t ON t.id = l.transaction_id
      WHERE ${IN_RANGE}
      GROUP BY l.product_id, l.sku, l.name
      ORDER BY revenue DESC, quantity_sold DESC
      LIMIT $3`,
    [range.from, range.to, limit],
  );
  return rows.map((r) => ({
    productId: r.product_id,
    sku: r.sku,
    name: r.name,
    quantitySold: Number(r.quantity_sold),
    revenue: Number(r.revenue),
  }));
}

export interface PaymentMethodBreakdown {
  method: string;
  payments: number;
  amount: number;
}

export async function getPaymentMethods(range: ReportRange): Promise<PaymentMethodBreakdown[]> {
  const { rows } = await pool.query(
    `SELECT p.method,
            COUNT(*)      AS payments,
            SUM(p.amount) AS amount
       FROM payments p
       JOIN transactions t ON t.id = p.transaction_id
      WHERE ${IN_RANGE}
      GROUP BY p.method
      ORDER BY amount DESC`,
    [range.from, range.to],
  );
  return rows.map((r) => ({
    method: r.method,
    payments: Number(r.payments),
    amount: Number(r.amount),
  }));
}

export interface LowStockProduct {
  id: string;
  sku: string;
  name: string;
  stock: number;
}

export async function getLowStock(threshold: number, limit: number): Promise<LowStockProduct[]> {
  const { rows } = await pool.query(
    `SELECT id, sku, name, stock
       FROM products
      WHERE stock <= $1
      ORDER BY stock ASC, name
      LIMIT $2`,
    [threshold, limit],
  );
  return rows;
}

export interface RecentTransaction {
  id: string;
  receiptNo: string;
  cashierId: string | null;
  grandTotal: number;
  itemCount: number;
  createdAt: string;
}

export interface TransactionRow {
  id: string;
  receiptNo: string;
  cashierName: string | null;
  grandTotal: number;
  itemCount: number;
  methods: string[];
  createdAt: string;
}

export interface TransactionPage {
  rows: TransactionRow[];
  total: number;
}

export interface TransactionFilters {
  /** Inclusive store-time dates, YYYY-MM-DD. */
  from?: string;
  to?: string;
  cashierId?: string;
  /** Substring match on the receipt number, case-insensitive. */
  receipt?: string;
}

/** Escape LIKE wildcards so a receipt search is a literal substring match. */
function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}

/**
 * Paginated transaction log for the dashboard table, newest first.
 * Filters and pagination both apply to the inner subquery, so only the
 * selected page is joined to lines/users — cost per request stays flat no
 * matter how many total transactions exist. The COUNT shares the same WHERE,
 * so `total` always describes the filtered set.
 */
export async function getTransactions(
  filters: TransactionFilters,
  limit: number,
  offset: number,
): Promise<TransactionPage> {
  if (filters.from && filters.to && filters.from > filters.to) {
    throw Errors.validation("'from' must be on or before 'to'.");
  }

  const conditions: string[] = [];
  const params: unknown[] = [];
  const storeDay = `(created_at AT TIME ZONE '${REPORT_TIMEZONE}')::date`;
  if (filters.from) {
    params.push(filters.from);
    conditions.push(`${storeDay} >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    conditions.push(`${storeDay} <= $${params.length}`);
  }
  if (filters.cashierId) {
    params.push(filters.cashierId);
    conditions.push(`cashier_id = $${params.length}`);
  }
  if (filters.receipt) {
    params.push(`%${escapeLike(filters.receipt)}%`);
    conditions.push(`receipt_no ILIKE $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const [{ rows }, count] = await Promise.all([
    pool.query(
      `SELECT t.id, t.receipt_no, t.grand_total, t.created_at,
              u.full_name AS cashier_name,
              COALESCE(SUM(l.quantity), 0) AS item_count,
              (SELECT COALESCE(array_agg(DISTINCT p.method), '{}')
                 FROM payments p WHERE p.transaction_id = t.id) AS methods
         FROM (SELECT id, receipt_no, grand_total, created_at, cashier_id
                 FROM transactions
                ${where}
                ORDER BY created_at DESC, id DESC
                LIMIT $${params.length + 1} OFFSET $${params.length + 2}) t
         LEFT JOIN users u ON u.id::text = t.cashier_id
         LEFT JOIN transaction_lines l ON l.transaction_id = t.id
        GROUP BY t.id, t.receipt_no, t.grand_total, t.created_at, u.full_name
        ORDER BY t.created_at DESC, t.id DESC`,
      [...params, limit, offset],
    ),
    pool.query(`SELECT COUNT(*) AS total FROM transactions ${where}`, params),
  ]);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      receiptNo: r.receipt_no,
      cashierName: r.cashier_name,
      grandTotal: Number(r.grand_total),
      itemCount: Number(r.item_count),
      methods: r.methods,
      createdAt: r.created_at.toISOString(),
    })),
    total: Number(count.rows[0].total),
  };
}

export interface ReportCashier {
  id: string;
  fullName: string;
}

/** Everyone who has rung at least one sale — options for the cashier filter. */
export async function getTransactionCashiers(): Promise<ReportCashier[]> {
  const { rows } = await pool.query<{ id: string; full_name: string }>(
    `SELECT u.id, u.full_name
       FROM users u
      WHERE EXISTS (SELECT 1 FROM transactions t WHERE t.cashier_id = u.id::text)
      ORDER BY u.full_name`,
  );
  return rows.map((r) => ({ id: r.id, fullName: r.full_name }));
}

export async function getRecentTransactions(limit: number): Promise<RecentTransaction[]> {
  const { rows } = await pool.query(
    `SELECT t.id, t.receipt_no, t.cashier_id, t.grand_total, t.created_at,
            COALESCE(SUM(l.quantity), 0) AS item_count
       FROM transactions t
       LEFT JOIN transaction_lines l ON l.transaction_id = t.id
      GROUP BY t.id
      ORDER BY t.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return rows.map((r) => ({
    id: r.id,
    receiptNo: r.receipt_no,
    cashierId: r.cashier_id,
    grandTotal: Number(r.grand_total),
    itemCount: Number(r.item_count),
    createdAt: r.created_at.toISOString(),
  }));
}
