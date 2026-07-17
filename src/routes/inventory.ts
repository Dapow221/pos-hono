/**
 * Inventory routes — barang masuk, stock opname, adjustments, kartu stok.
 * All admin-only (products:write): these move stock, same trust level as
 * editing products. Every write bumps the report cache (low-stock feeds on it).
 */
import { Hono } from "hono";
import {
  goodsInSchema,
  movementFilterSchema,
  opnameSchema,
  stockAdjustmentSchema,
} from "../schemas";
import {
  adjustStock,
  applyOpname,
  listMovements,
  receiveGoods,
} from "../services/inventory";
import { requirePermission, type AuthEnv } from "../middleware/auth";
import { PERMISSIONS } from "../auth/rbac";
import { parsePagination, pageMeta } from "../pagination";
import { bumpReportsCacheVersion } from "../cache";
import { Errors } from "../errors";

const route = new Hono<AuthEnv>();

route.use("*", requirePermission(PERMISSIONS.PRODUCTS_WRITE));

async function parseBody(c: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  return await c.req.json().catch(() => {
    throw Errors.validation("Request body must be valid JSON.");
  });
}

// POST /v1/inventory/goods-in — barang masuk from a supplier.
route.post("/goods-in", async (c) => {
  const input = goodsInSchema.parse(await parseBody(c));
  const levels = await receiveGoods(input, c.get("user").sub);
  await bumpReportsCacheVersion();
  return c.json({ data: levels, meta: { count: levels.length } }, 201);
});

// POST /v1/inventory/opname — reconcile counted stock; returns the variance report.
route.post("/opname", async (c) => {
  const input = opnameSchema.parse(await parseBody(c));
  const variances = await applyOpname(input, c.get("user").sub);
  await bumpReportsCacheVersion();
  const adjusted = variances.filter((v) => v.difference !== 0).length;
  return c.json({ data: variances, meta: { counted: variances.length, adjusted } }, 201);
});

// POST /v1/inventory/adjustment — manual correction with a reason.
route.post("/adjustment", async (c) => {
  const input = stockAdjustmentSchema.parse(await parseBody(c));
  const level = await adjustStock(input, c.get("user").sub);
  await bumpReportsCacheVersion();
  return c.json({ data: level }, 201);
});

// GET /v1/inventory/movements?productId&type&from&to&limit&offset — kartu stok.
route.get("/movements", async (c) => {
  const query = c.req.query();
  const present = Object.fromEntries(Object.entries(query).filter(([, v]) => v !== ""));
  const filters = movementFilterSchema.parse(present);
  const page = parsePagination(query, { defaultLimit: 25 });
  const { rows, total } = await listMovements(filters, page);
  return c.json({ data: rows, meta: pageMeta(total, page, rows.length) });
});

export default route;
