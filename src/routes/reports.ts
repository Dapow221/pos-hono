/** Report routes — thin controllers: guard → parse range → query service → respond. */
import { Hono } from "hono";
import { requirePermission, type AuthEnv } from "../middleware/auth";
import { PERMISSIONS } from "../auth/rbac";
import { reportRangeSchema } from "../schemas";
import {
  REPORT_TIMEZONE,
  resolveRange,
  getSummary,
  getSalesByDay,
  getTopProducts,
  getPaymentMethods,
  getLowStock,
  getRecentTransactions,
  type ReportRange,
} from "../services/reports";

const route = new Hono<AuthEnv>();

// Every report endpoint requires reports:read (admin).
route.use("*", requirePermission(PERMISSIONS.REPORTS_READ));

function parseRange(query: Record<string, string | undefined>): ReportRange {
  return resolveRange(reportRangeSchema.parse({ from: query.from, to: query.to }));
}

/** Clamp an optional numeric query param into [1, max], falling back to `fallback`. */
function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw ?? fallback);
  if (!Number.isInteger(n) || n < 1) return fallback;
  return Math.min(n, max);
}

const rangeMeta = (range: ReportRange) => ({ ...range, timezone: REPORT_TIMEZONE });

// GET /v1/reports/summary?from&to — headline numbers for the dashboard cards.
route.get("/summary", async (c) => {
  const range = parseRange(c.req.query());
  return c.json({ data: await getSummary(range), meta: rangeMeta(range) });
});

// GET /v1/reports/sales-by-day?from&to — zero-filled daily series for charts.
route.get("/sales-by-day", async (c) => {
  const range = parseRange(c.req.query());
  const data = await getSalesByDay(range);
  return c.json({ data, meta: { ...rangeMeta(range), count: data.length } });
});

// GET /v1/reports/top-products?from&to&limit — best sellers by revenue.
route.get("/top-products", async (c) => {
  const range = parseRange(c.req.query());
  const limit = clampLimit(c.req.query("limit"), 10, 100);
  const data = await getTopProducts(range, limit);
  return c.json({ data, meta: { ...rangeMeta(range), count: data.length } });
});

// GET /v1/reports/payment-methods?from&to — cash/card/qris breakdown.
route.get("/payment-methods", async (c) => {
  const range = parseRange(c.req.query());
  const data = await getPaymentMethods(range);
  return c.json({ data, meta: { ...rangeMeta(range), count: data.length } });
});

// GET /v1/reports/low-stock?threshold&limit — restock alerts (not range-based).
route.get("/low-stock", async (c) => {
  const threshold = clampLimit(c.req.query("threshold"), 10, 1_000_000);
  const limit = clampLimit(c.req.query("limit"), 100, 100);
  const data = await getLowStock(threshold, limit);
  return c.json({ data, meta: { threshold, count: data.length } });
});

// GET /v1/reports/recent-transactions?limit — latest sales feed (not range-based).
route.get("/recent-transactions", async (c) => {
  const limit = clampLimit(c.req.query("limit"), 10, 50);
  const data = await getRecentTransactions(limit);
  return c.json({ data, meta: { count: data.length } });
});

export default route;
