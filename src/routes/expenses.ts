/**
 * Expense routes (pembukuan) — admin-only via finance:manage.
 * Writes bump the report cache so /v1/reports/finance never serves stale money.
 */
import { Hono } from "hono";
import { createExpenseSchema, expenseFilterSchema } from "../schemas";
import { createExpense, deleteExpense, listExpenses } from "../services/finance";
import { requirePermission, type AuthEnv } from "../middleware/auth";
import { PERMISSIONS } from "../auth/rbac";
import { parsePagination, pageMeta } from "../pagination";
import { bumpReportsCacheVersion } from "../cache";
import { Errors } from "../errors";

const route = new Hono<AuthEnv>();

route.use("*", requirePermission(PERMISSIONS.FINANCE_MANAGE));

// POST /v1/expenses — record an operating expense.
route.post("/", async (c) => {
  const body = await c.req.json().catch(() => {
    throw Errors.validation("Request body must be valid JSON.");
  });
  const expense = await createExpense(createExpenseSchema.parse(body), c.get("user").sub);
  await bumpReportsCacheVersion();
  c.header("Location", `/v1/expenses/${expense.id}`);
  return c.json({ data: expense }, 201);
});

// GET /v1/expenses?from&to&category&limit&offset — newest first.
route.get("/", async (c) => {
  const query = c.req.query();
  const present = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ""));
  const filters = expenseFilterSchema.parse(present);
  const page = parsePagination(query, { defaultLimit: 25 });
  const { rows, total, amountTotal } = await listExpenses(filters, page);
  return c.json({ data: rows, meta: { ...pageMeta(total, page, rows.length), amountTotal } });
});

// DELETE /v1/expenses/{id} — remove a mistaken entry.
route.delete("/:id", async (c) => {
  const id = c.req.param("id");
  // Guard the UUID shape here: a malformed id would otherwise error inside Postgres.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw Errors.notFound(`Expense ${id} not found.`);
  }
  await deleteExpense(id);
  await bumpReportsCacheVersion();
  return c.body(null, 204);
});

export default route;
