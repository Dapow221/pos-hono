import { withTransaction, type Tx } from "../db";
import { Errors } from "../errors";
import { recordSaleMovements } from "./inventory";
import {
  TAX_RATE_PERCENT,
  ROUNDING_STEP,
  percentageOf,
  clampPercent,
  roundToNearest,
  type Rupiah,
} from "../money";
import type { CheckoutInput } from "../schemas";
import type { Payment, Transaction, TransactionLine } from "../types";

export interface CheckoutResult {
  transaction: Transaction;
  /** True when this Idempotency-Key was seen before and we replayed the sale. */
  isReplay: boolean;
}

/**
 * Superset of the public checkout body: gateway finalization records tenders
 * like "midtrans"/"xendit" that the public schema deliberately rejects.
 */
export interface CheckoutRequest {
  items: CheckoutInput["items"];
  discount?: CheckoutInput["discount"];
  payments: Payment[];
  cashierId?: string | null;
}

export async function processCheckout(
  input: CheckoutRequest,
  idempotencyKey: string,
): Promise<CheckoutResult> {
  return withTransaction(async (tx) => {
    const replay = await findTransactionByKey(tx, idempotencyKey);
    if (replay) return { transaction: replay, isReplay: true };

    const productIds = [...mergeQuantities(input.items).keys()];
    const products = await lockProducts(tx, productIds);
    const cart = priceCart(products, input);

    const amountPaid: Rupiah = input.payments.reduce((sum, p) => sum + p.amount, 0);
    if (amountPaid < cart.grandTotal) {
      throw Errors.insufficientPayment({
        grandTotal: cart.grandTotal,
        amountPaid,
        shortfall: cart.grandTotal - amountPaid,
      });
    }
    const change: Rupiah = amountPaid - cart.grandTotal;

    for (const line of cart.lines) {
      await tx.query(`UPDATE products SET stock = stock - $1 WHERE id = $2`, [line.quantity, line.productId]);
    }

    const transaction = await insertTransaction(tx, {
      idempotencyKey,
      cashierId: input.cashierId ?? null,
      ...cart,
      payments: input.payments,
      amountPaid,
      change,
    });

    // Same transaction as the stock cut, so the kartu stok always reconciles.
    await recordSaleMovements(tx, {
      lines: cart.lines,
      receiptNo: transaction.receiptNo,
      cashierId: input.cashierId ?? null,
    });

    return { transaction, isReplay: false };
  });
}

export interface PricedCart {
  lines: TransactionLine[];
  subtotal: Rupiah;
  discount: Rupiah;
  tax: Rupiah;
  rounding: Rupiah;
  grandTotal: Rupiah;
}

/**
 * Price a cart against a set of product rows: build lines, check stock, apply
 * the discount, tax, and Rp 100 rounding ("pembulatan", kept as its own line so
 * the receipt explains it). This is the ONE pricing function — counter checkout
 * and gateway payments both go through it, so their totals can never diverge.
 */
export function priceCart(
  products: Map<string, ProductRow>,
  input: Pick<CheckoutRequest, "items" | "discount">,
): PricedCart {
  const wanted = mergeQuantities(input.items);

  const lines: TransactionLine[] = [];
  const stockProblems: Array<{ productId: string; requested: number; available: number }> = [];
  for (const [productId, quantity] of wanted) {
    const product = products.get(productId);
    if (!product) throw Errors.notFound(`Product ${productId} not found.`);
    if (product.stock < quantity) {
      stockProblems.push({ productId, requested: quantity, available: product.stock });
      continue;
    }
    lines.push({
      productId,
      sku: product.sku,
      name: product.name,
      unitPrice: product.price,
      quantity,
      subtotal: product.price * quantity,
    });
  }
  if (stockProblems.length > 0) throw Errors.insufficientStock(stockProblems);

  const subtotal: Rupiah = lines.reduce((sum, l) => sum + l.subtotal, 0);

  let discount: Rupiah = 0;
  if (input.discount) {
    discount =
      input.discount.type === "percentage"
        ? percentageOf(subtotal, clampPercent(input.discount.value))
        : Math.round(input.discount.value);
    discount = Math.min(discount, subtotal);
  }
  const taxableBase: Rupiah = subtotal - discount;

  const tax: Rupiah = percentageOf(taxableBase, TAX_RATE_PERCENT);

  const grandTotalRaw: Rupiah = taxableBase + tax;
  const grandTotal: Rupiah = roundToNearest(grandTotalRaw, ROUNDING_STEP);
  const rounding: Rupiah = grandTotal - grandTotalRaw;

  return { lines, subtotal, discount, tax, rounding, grandTotal };
}

/** Sum quantities for repeated productIds so each product is locked once. */
function mergeQuantities(items: CheckoutRequest["items"]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const item of items) {
    merged.set(item.productId, (merged.get(item.productId) ?? 0) + item.quantity);
  }
  return merged;
}

export interface ProductRow {
  id: string;
  sku: string;
  name: string;
  price: number;
  stock: number;
}

/**
 * Lock and load the requested products in ONE query. `FOR UPDATE` holds a write
 * lock on each row until the surrounding transaction ends — this is what
 * serializes concurrent checkouts of the same item. ORDER BY id keeps the lock
 * acquisition order stable, which avoids deadlocks between two checkouts that
 * share products.
 */
async function lockProducts(tx: Tx, productIds: string[]): Promise<Map<string, ProductRow>> {
  const { rows } = await tx.query<ProductRow>(
    `SELECT id, sku, name, price, stock
       FROM products
      WHERE id = ANY($1::text[])
      ORDER BY id
        FOR UPDATE`,
    [productIds],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function findTransactionByKey(tx: Tx, idempotencyKey: string): Promise<Transaction | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM transactions WHERE idempotency_key = $1`,
    [idempotencyKey],
  );
  if (rows.length === 0) return null;
  return loadTransaction(tx, rows[0]!.id);
}

interface InsertArgs {
  idempotencyKey: string;
  cashierId: string | null;
  lines: TransactionLine[];
  subtotal: number;
  discount: number;
  tax: number;
  rounding: number;
  grandTotal: number;
  payments: Payment[];
  amountPaid: number;
  change: number;
}

async function insertTransaction(tx: Tx, args: InsertArgs): Promise<Transaction> {
  const receiptNo = `RCP-${Date.now().toString(36).toUpperCase()}`;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO transactions
       (receipt_no, idempotency_key, cashier_id, subtotal, discount, tax, rounding, grand_total, amount_paid, change)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      receiptNo,
      args.idempotencyKey,
      args.cashierId,
      args.subtotal,
      args.discount,
      args.tax,
      args.rounding,
      args.grandTotal,
      args.amountPaid,
      args.change,
    ],
  );
  const transactionId = rows[0]!.id;

  for (const line of args.lines) {
    await tx.query(
      `INSERT INTO transaction_lines (transaction_id, product_id, sku, name, unit_price, quantity, subtotal)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [transactionId, line.productId, line.sku, line.name, line.unitPrice, line.quantity, line.subtotal],
    );
  }
  for (const payment of args.payments) {
    await tx.query(
      `INSERT INTO payments (transaction_id, method, amount) VALUES ($1,$2,$3)`,
      [transactionId, payment.method, payment.amount],
    );
  }

  return loadTransaction(tx, transactionId);
}

/** Re-read a full transaction (header + lines + payments) into the API shape. */
async function loadTransaction(tx: Tx, id: string): Promise<Transaction> {
  const header = await tx.query(
    `SELECT id, receipt_no, cashier_id, subtotal, discount, tax, rounding, grand_total,
            amount_paid, change, created_at
       FROM transactions WHERE id = $1`,
    [id],
  );
  const h = header.rows[0];
  const lines = await tx.query(
    `SELECT product_id, sku, name, unit_price, quantity, subtotal
       FROM transaction_lines WHERE transaction_id = $1 ORDER BY id`,
    [id],
  );
  const payments = await tx.query(
    `SELECT method, amount FROM payments WHERE transaction_id = $1 ORDER BY id`,
    [id],
  );
  return {
    id: h.id,
    receiptNo: h.receipt_no,
    createdAt: h.created_at.toISOString(),
    cashierId: h.cashier_id,
    lines: lines.rows.map((r) => ({
      productId: r.product_id,
      sku: r.sku,
      name: r.name,
      unitPrice: r.unit_price,
      quantity: r.quantity,
      subtotal: r.subtotal,
    })),
    subtotal: h.subtotal,
    discount: h.discount,
    tax: h.tax,
    rounding: h.rounding,
    grandTotal: h.grand_total,
    payments: payments.rows.map((r) => ({ method: r.method, amount: r.amount })),
    amountPaid: h.amount_paid,
    change: h.change,
  };
}
