/**
 * Inventory service — barang masuk, stock opname, manual adjustments, and the
 * stock ledger (kartu stok).
 *
 * Every mutation locks the product rows (SELECT ... FOR UPDATE), updates stock,
 * and writes a signed stock_movements row in the SAME transaction — so the
 * ledger always reconciles against products.stock, even under concurrency.
 */
import { withTransaction, pool, type Tx } from "../db";
import { Errors } from "../errors";
import type {
  GoodsInInput,
  OpnameInput,
  StockAdjustmentInput,
  MovementFilterInput,
} from "../schemas";
import type { Pagination } from "../pagination";
import { REPORT_TIMEZONE } from "./reports";

export interface StockLevel {
  productId: string;
  name: string;
  stock: number;
}

export interface OpnameVariance {
  productId: string;
  name: string;
  systemStock: number;
  counted: number;
  difference: number;
}

export interface StockMovement {
  id: number;
  productId: string;
  sku: string;
  name: string;
  type: string;
  quantity: number;
  unitCost: number | null;
  supplier: string | null;
  note: string | null;
  ref: string | null;
  createdBy: string | null;
  createdAt: string;
}

async function lockProducts(
  tx: Tx,
  ids: string[],
): Promise<Map<string, { name: string; stock: number }>> {
  const { rows } = await tx.query<{ id: string; name: string; stock: number }>(
    `SELECT id, name, stock FROM products WHERE id = ANY($1) FOR UPDATE`,
    [ids],
  );
  const found = new Map(rows.map((r) => [r.id, { name: r.name, stock: r.stock }]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw Errors.notFound(`Product(s) not found: ${missing.join(", ")}.`);
  }
  return found;
}

async function insertMovement(
  tx: Tx,
  m: {
    productId: string;
    type: "sale" | "goods_in" | "adjustment" | "opname";
    quantity: number;
    unitCost?: number | null;
    supplier?: string | null;
    note?: string | null;
    ref?: string | null;
    createdBy?: string | null;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO stock_movements
       (product_id, type, quantity, unit_cost, supplier, note, ref, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      m.productId,
      m.type,
      m.quantity,
      m.unitCost ?? null,
      m.supplier ?? null,
      m.note ?? null,
      m.ref ?? null,
      m.createdBy ?? null,
    ],
  );
}

/** Barang masuk: add received quantities and record them on the ledger. */
export async function receiveGoods(input: GoodsInInput, userId: string): Promise<StockLevel[]> {
  return withTransaction(async (tx) => {
    const ids = input.items.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) {
      throw Errors.validation("Each product may appear only once per goods-in.");
    }
    const products = await lockProducts(tx, ids);

    const levels: StockLevel[] = [];
    for (const item of input.items) {
      const { rows } = await tx.query<{ stock: number }>(
        `UPDATE products SET stock = stock + $1 WHERE id = $2 RETURNING stock`,
        [item.quantity, item.productId],
      );
      await insertMovement(tx, {
        productId: item.productId,
        type: "goods_in",
        quantity: item.quantity,
        unitCost: item.unitCost,
        supplier: input.supplier,
        note: input.note,
        createdBy: userId,
      });
      levels.push({
        productId: item.productId,
        name: products.get(item.productId)!.name,
        stock: rows[0]!.stock,
      });
    }
    return levels;
  });
}

/**
 * Stock opname: reconcile counted stock against the system. Products whose
 * count matches are untouched; differences become 'opname' movements and the
 * stock is set to the counted value. Returns the variance report.
 */
export async function applyOpname(input: OpnameInput, userId: string): Promise<OpnameVariance[]> {
  return withTransaction(async (tx) => {
    const ids = input.counts.map((c) => c.productId);
    if (new Set(ids).size !== ids.length) {
      throw Errors.validation("Each product may appear only once per opname.");
    }
    const products = await lockProducts(tx, ids);

    const variances: OpnameVariance[] = [];
    for (const count of input.counts) {
      const current = products.get(count.productId)!;
      const difference = count.counted - current.stock;
      variances.push({
        productId: count.productId,
        name: current.name,
        systemStock: current.stock,
        counted: count.counted,
        difference,
      });
      if (difference === 0) continue;

      await tx.query(`UPDATE products SET stock = $1 WHERE id = $2`, [
        count.counted,
        count.productId,
      ]);
      await insertMovement(tx, {
        productId: count.productId,
        type: "opname",
        quantity: difference,
        note: input.note,
        createdBy: userId,
      });
    }
    return variances;
  });
}

/** Manual correction (waste, breakage, found stock). Stock may never go negative. */
export async function adjustStock(
  input: StockAdjustmentInput,
  userId: string,
): Promise<StockLevel> {
  return withTransaction(async (tx) => {
    const products = await lockProducts(tx, [input.productId]);
    const current = products.get(input.productId)!;
    const next = current.stock + input.quantity;
    if (next < 0) {
      throw Errors.validation(
        `Adjustment would make stock negative (current ${current.stock}, change ${input.quantity}).`,
      );
    }
    await tx.query(`UPDATE products SET stock = $1 WHERE id = $2`, [next, input.productId]);
    await insertMovement(tx, {
      productId: input.productId,
      type: "adjustment",
      quantity: input.quantity,
      note: input.reason,
      createdBy: userId,
    });
    return { productId: input.productId, name: current.name, stock: next };
  });
}

/** Ledger rows written by checkout, in the same transaction as the stock cut. */
export async function recordSaleMovements(
  tx: Tx,
  args: {
    lines: { productId: string; quantity: number }[];
    receiptNo: string;
    cashierId: string | null;
  },
): Promise<void> {
  for (const line of args.lines) {
    await insertMovement(tx, {
      productId: line.productId,
      type: "sale",
      quantity: -line.quantity,
      ref: args.receiptNo,
      createdBy: args.cashierId,
    });
  }
}

export interface MovementPage {
  rows: StockMovement[];
  total: number;
}

/** Kartu stok, newest first, filterable by product/type/date. */
export async function listMovements(
  filters: MovementFilterInput,
  page: Pagination,
): Promise<MovementPage> {
  const conditions: string[] = [];
  const params: unknown[] = [];
  const storeDay = `(m.created_at AT TIME ZONE '${REPORT_TIMEZONE}')::date`;
  if (filters.productId) {
    params.push(filters.productId);
    conditions.push(`m.product_id = $${params.length}`);
  }
  if (filters.type) {
    params.push(filters.type);
    conditions.push(`m.type = $${params.length}`);
  }
  if (filters.from) {
    params.push(filters.from);
    conditions.push(`${storeDay} >= $${params.length}`);
  }
  if (filters.to) {
    params.push(filters.to);
    conditions.push(`${storeDay} <= $${params.length}`);
  }
  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const [{ rows }, count] = await Promise.all([
    pool.query(
      `SELECT m.id, m.product_id, p.sku, p.name, m.type, m.quantity, m.unit_cost,
              m.supplier, m.note, m.ref, m.created_at,
              u.full_name AS created_by
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id::text = m.created_by
        ${where}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, page.limit, page.offset],
    ),
    pool.query(`SELECT COUNT(*) AS total FROM stock_movements m ${where}`, params),
  ]);
  return {
    rows: rows.map((r) => ({
      id: Number(r.id),
      productId: r.product_id,
      sku: r.sku,
      name: r.name,
      type: r.type,
      quantity: r.quantity,
      unitCost: r.unit_cost,
      supplier: r.supplier,
      note: r.note,
      ref: r.ref,
      createdBy: r.created_by,
      createdAt: r.created_at.toISOString(),
    })),
    total: Number(count.rows[0].total),
  };
}
