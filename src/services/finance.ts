/**
 * Pembukuan service — operating expenses and the money recap.
 *
 * Deliberately NOT double-entry accounting: a coffee bar needs expense entry,
 * a daily cash view, and "omset − pengeluaran = laba". Amounts are whole
 * rupiah; days are bucketed in store time like every report.
 */
import { pool } from "../db";
import { Errors } from "../errors";
import type { CreateExpenseInput, ExpenseFilterInput } from "../schemas";
import type { Pagination } from "../pagination";
import { REPORT_TIMEZONE, type ReportRange } from "./reports";

export interface Expense {
  id: string;
  category: string;
  description: string;
  amount: number;
  spentOn: string;
  createdBy: string | null;
  createdAt: string;
}

export async function createExpense(input: CreateExpenseInput, userId: string): Promise<Expense> {
  const { rows } = await pool.query(
    `INSERT INTO expenses (category, description, amount, spent_on, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, category, description, amount, spent_on::text, created_by, created_at`,
    [input.category, input.description, input.amount, input.spentOn, userId],
  );
  return mapExpense(rows[0]);
}

export async function deleteExpense(id: string): Promise<void> {
  const { rowCount } = await pool.query(`DELETE FROM expenses WHERE id = $1`, [id]);
  if (rowCount === 0) throw Errors.notFound(`Expense ${id} not found.`);
}

export interface ExpensePage {
  rows: Expense[];
  total: number;
  amountTotal: number;
}

export async function listExpenses(
  filters: ExpenseFilterInput,
  page: Pagination,
): Promise<ExpensePage> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  if (filters.from) {
    params.push(filters.from);
    conditions.push(`e.spent_on >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    conditions.push(`e.spent_on <= $${params.length}`);
  }
  if (filters.category) {
    params.push(filters.category);
    conditions.push(`e.category = $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const [{ rows }, totals] = await Promise.all([
    pool.query(
      `SELECT e.id, e.category, e.description, e.amount, e.spent_on::text, e.created_at,
              u.full_name AS created_by
         FROM expenses e
         LEFT JOIN users u ON u.id::text = e.created_by
        ${where}
        ORDER BY e.spent_on DESC, e.created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, page.limit, page.offset],
    ),
    pool.query(
      `SELECT COUNT(*) AS total, COALESCE(SUM(e.amount), 0) AS amount_total
         FROM expenses e ${where}`,
      params,
    ),
  ]);
  return {
    rows: rows.map(mapExpense),
    total: Number(totals.rows[0].total),
    amountTotal: Number(totals.rows[0].amount_total),
  };
}

export interface FinanceDay {
  date: string;
  revenue: number;
  expenses: number;
  net: number;
}

export interface FinanceSummary {
  revenue: number;
  expenses: number;
  net: number;
  byCategory: { category: string; amount: number }[];
  days: FinanceDay[];
}

/** Omset vs pengeluaran for a range: totals, per category, zero-filled per day. */
export async function getFinanceSummary(range: ReportRange): Promise<FinanceSummary> {
  const [days, categories] = await Promise.all([
    pool.query(
      `SELECT d.day::date::text AS date,
              COALESCE(r.revenue, 0)  AS revenue,
              COALESCE(x.expenses, 0) AS expenses
         FROM generate_series($1::date, $2::date, '1 day') AS d(day)
         LEFT JOIN (
           SELECT (created_at AT TIME ZONE '${REPORT_TIMEZONE}')::date AS day,
                  SUM(grand_total) AS revenue
             FROM transactions
            GROUP BY 1
         ) r ON r.day = d.day::date
         LEFT JOIN (
           SELECT spent_on AS day, SUM(amount) AS expenses
             FROM expenses
            GROUP BY 1
         ) x ON x.day = d.day::date
        ORDER BY d.day::date`,
      [range.from, range.to],
    ),
    pool.query(
      `SELECT category, SUM(amount) AS amount
         FROM expenses
        WHERE spent_on BETWEEN $1 AND $2
        GROUP BY category
        ORDER BY amount DESC`,
      [range.from, range.to],
    ),
  ]);

  const dayRows: FinanceDay[] = days.rows.map((r) => ({
    date: r.date,
    revenue: Number(r.revenue),
    expenses: Number(r.expenses),
    net: Number(r.revenue) - Number(r.expenses),
  }));
  const revenue = dayRows.reduce((sum, d) => sum + d.revenue, 0);
  const expenses = dayRows.reduce((sum, d) => sum + d.expenses, 0);
  return {
    revenue,
    expenses,
    net: revenue - expenses,
    byCategory: categories.rows.map((r) => ({ category: r.category, amount: Number(r.amount) })),
    days: dayRows,
  };
}

function mapExpense(r: {
  id: string;
  category: string;
  description: string;
  amount: number;
  // Always selected as spent_on::text — a JS Date here would shift the
  // calendar day when the server timezone is ahead of UTC.
  spent_on: string;
  created_by?: string | null;
  created_at: Date;
}): Expense {
  return {
    id: r.id,
    category: r.category,
    description: r.description,
    amount: r.amount,
    spentOn: r.spent_on,
    createdBy: r.created_by ?? null,
    createdAt: r.created_at.toISOString(),
  };
}
