/** Product routes — thin controllers: guard → parse → query → respond. */
import { Hono } from "hono";
import { pool } from "../db";
import { Errors } from "../errors";
import { requirePermission, type AuthEnv } from "../middleware/auth";
import { PERMISSIONS } from "../auth/rbac";
import { createProductSchema, updateProductSchema } from "../schemas";
import { bumpReportsCacheVersion } from "../cache";

const route = new Hono<AuthEnv>();

// GET /v1/products — list catalogue (capped page size). Requires products:read.
route.get("/", requirePermission(PERMISSIONS.PRODUCTS_READ), async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 100), 100);
  const { rows } = await pool.query(
    `SELECT id, sku, name, price, stock FROM products ORDER BY name LIMIT $1`,
    [limit],
  );
  return c.json({ data: rows, meta: { count: rows.length, hasMore: false } });
});

// GET /v1/products/:id — single product. Requires products:read.
route.get("/:id", requirePermission(PERMISSIONS.PRODUCTS_READ), async (c) => {
  const { rows } = await pool.query(
    `SELECT id, sku, name, price, stock FROM products WHERE id = $1`,
    [c.req.param("id")],
  );
  if (rows.length === 0) throw Errors.notFound(`Product ${c.req.param("id")} not found.`);
  return c.json({ data: rows[0] });
});

// POST /v1/products — create. Requires products:write (admin).
route.post("/", requirePermission(PERMISSIONS.PRODUCTS_WRITE), async (c) => {
  const input = createProductSchema.parse(await c.req.json().catch(() => ({})));
  const dup = await pool.query(`SELECT 1 FROM products WHERE id = $1 OR sku = $2`, [input.id, input.sku]);
  if (dup.rowCount && dup.rowCount > 0) throw Errors.conflict("Product id or sku already exists.");
  const { rows } = await pool.query(
    `INSERT INTO products (id, sku, name, price, stock) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, sku, name, price, stock`,
    [input.id, input.sku, input.name, input.price, input.stock],
  );
  await bumpReportsCacheVersion(); // stock changes feed the low-stock report
  return c.json({ data: rows[0] }, 201, { Location: `/v1/products/${input.id}` });
});

// PATCH /v1/products/:id — partial update. Requires products:write (admin).
route.patch("/:id", requirePermission(PERMISSIONS.PRODUCTS_WRITE), async (c) => {
  const id = c.req.param("id");
  const input = updateProductSchema.parse(await c.req.json().catch(() => ({})));

  // Column names are safe: Zod `.strict()` guarantees keys are a subset of
  // {sku, name, price, stock}; values stay parameterized.
  const fields = Object.keys(input);
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
  const values = fields.map((f) => (input as Record<string, unknown>)[f]);

  const { rows } = await pool.query(
    `UPDATE products SET ${setClause} WHERE id = $1
     RETURNING id, sku, name, price, stock`,
    [id, ...values],
  );
  if (rows.length === 0) throw Errors.notFound(`Product ${id} not found.`);
  await bumpReportsCacheVersion();
  return c.json({ data: rows[0] });
});

export default route;
