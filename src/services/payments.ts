/**
 * Gateway payment service (Midtrans / Xendit).
 *
 * Flow: create → the cart is priced server-side (same `priceCart` as checkout),
 * a pending row is stored, and the gateway returns a hosted payment URL. The
 * sale itself is only finalized — stock decremented, transaction written —
 * when the gateway's webhook confirms the money. Finalization goes through
 * `processCheckout` with a derived idempotency key, so a webhook delivered
 * twice (or racing with itself) can never create two sales.
 */
import { randomUUID } from "node:crypto";
import { pool } from "../db";
import { env } from "../env";
import { AppError, Errors } from "../errors";
import { bumpReportsCacheVersion } from "../cache";
import { priceCart, processCheckout, type ProductRow } from "./checkout";
import type { CreatePaymentInput, MidtransNotification, XenditInvoiceCallback } from "../schemas";
import {
  createSnapTransaction,
  midtransConfigured,
  verifyMidtransSignature,
} from "../gateways/midtrans";
import { createInvoice, verifyXenditCallbackToken, xenditConfigured } from "../gateways/xendit";

export type PaymentProvider = "midtrans" | "xendit";
export type GatewayPaymentStatus = "pending" | "paid" | "failed" | "expired";

export interface GatewayPaymentView {
  id: string;
  provider: PaymentProvider;
  status: GatewayPaymentStatus;
  amount: number;
  /** Hosted page (Midtrans Snap / Xendit invoice) the customer pays on. */
  paymentUrl: string | null;
  /** Gateway's own id: the Snap token (embeddable popup) / Xendit invoice id. */
  providerRef: string | null;
  /** The order id we sent to the gateway (shows up in its dashboard). */
  externalRef: string;
  /** Set once the webhook finalized the sale. */
  transactionId: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface CreateGatewayPaymentResult {
  payment: GatewayPaymentView;
  /** True when this Idempotency-Key was seen before and we replayed the payment. */
  isReplay: boolean;
}

/** The cart snapshot stored in JSONB and re-priced when the webhook lands. */
type StoredCart = Pick<CreatePaymentInput, "items" | "discount">;

export async function createGatewayPayment(
  input: CreatePaymentInput,
  idempotencyKey: string,
  cashierId: string,
): Promise<CreateGatewayPaymentResult> {
  const replay = await findByIdempotencyKey(idempotencyKey);
  if (replay) return { payment: replay, isReplay: true };

  assertProviderConfigured(input.provider);

  // Price the cart now so the customer is charged exactly what checkout would
  // charge. Stock is checked here for early feedback but only reserved at
  // finalize time — the webhook re-checks it inside the locking checkout.
  const products = await loadProducts(input.items.map((i) => i.productId));
  const cart = priceCart(products, input);

  const externalRef = `pos-${randomUUID()}`;
  const storedCart: StoredCart = { items: input.items, discount: input.discount };

  let id: string;
  try {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO gateway_payments (provider, external_ref, idempotency_key, amount, cart, cashier_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id`,
      [input.provider, externalRef, idempotencyKey, cart.grandTotal, storedCart, cashierId],
    );
    id = rows[0]!.id;
  } catch (err) {
    // Unique violation on idempotency_key = a concurrent duplicate won the race.
    if (isUniqueViolation(err)) {
      const winner = await findByIdempotencyKey(idempotencyKey);
      if (winner) return { payment: winner, isReplay: true };
    }
    throw err;
  }

  // Call the gateway AFTER the row exists, so a webhook can never reference an
  // order we have no record of. A gateway failure marks the row failed.
  let providerRef: string;
  let paymentUrl: string;
  try {
    if (input.provider === "midtrans") {
      // Midtrans validates that item_details sum to gross_amount exactly, so
      // discount/tax/rounding go in as adjustment lines (subtotal - discount
      // + tax + rounding = grandTotal by construction).
      const snap = await createSnapTransaction({
        orderId: externalRef,
        grossAmount: cart.grandTotal,
        items: [
          ...cart.lines.map((l) => ({
            id: l.productId,
            name: l.name,
            price: l.unitPrice,
            quantity: l.quantity,
          })),
          ...(cart.discount > 0
            ? [{ id: "DISCOUNT", name: "Diskon", price: -cart.discount, quantity: 1 }]
            : []),
          ...(cart.tax > 0 ? [{ id: "TAX", name: "PPN 11%", price: cart.tax, quantity: 1 }] : []),
          ...(cart.rounding !== 0
            ? [{ id: "ROUNDING", name: "Pembulatan", price: cart.rounding, quantity: 1 }]
            : []),
        ],
        customerEmail: input.customerEmail,
        expiryMinutes: env.PAYMENT_EXPIRY_MIN,
        finishRedirectUrl: env.PAYMENT_REDIRECT_URL,
      });
      providerRef = snap.token;
      paymentUrl = snap.redirectUrl;
    } else {
      const invoice = await createInvoice({
        externalId: externalRef,
        amount: cart.grandTotal,
        description: `POS sale ${externalRef}`,
        customerEmail: input.customerEmail,
        expiryMinutes: env.PAYMENT_EXPIRY_MIN,
        redirectUrl: env.PAYMENT_REDIRECT_URL,
      });
      providerRef = invoice.id;
      paymentUrl = invoice.invoiceUrl;
    }
  } catch (err) {
    await pool.query(`UPDATE gateway_payments SET status = 'failed' WHERE id = $1`, [id]);
    throw err;
  }

  await pool.query(
    `UPDATE gateway_payments SET provider_ref = $1, payment_url = $2 WHERE id = $3`,
    [providerRef, paymentUrl, id],
  );

  const payment = await getGatewayPayment(id);
  return { payment, isReplay: false };
}

export async function getGatewayPayment(id: string): Promise<GatewayPaymentView> {
  const { rows } = await pool.query(
    `SELECT id, provider, status, amount, payment_url, provider_ref, external_ref, transaction_id, created_at, paid_at
       FROM gateway_payments WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) throw Errors.notFound(`Payment ${id} not found.`);
  return toView(rows[0]);
}

/**
 * DEV ONLY (the route gates this on NODE_ENV): pretend the gateway confirmed
 * the money, so the whole flow can be exercised from the demo UI without a
 * publicly reachable webhook. Goes through the exact same finalizer.
 */
export async function simulateGatewayPaid(id: string): Promise<GatewayPaymentView> {
  const { rows } = await pool.query<{ provider: PaymentProvider; external_ref: string }>(
    `SELECT provider, external_ref FROM gateway_payments WHERE id = $1`,
    [id],
  );
  if (rows.length === 0) throw Errors.notFound(`Payment ${id} not found.`);
  await finalizePaid(rows[0]!.provider, rows[0]!.external_ref, null);
  return getGatewayPayment(id);
}

// ─── Webhooks ────────────────────────────────────────────────────────────────

/** Handle a verified-signature Midtrans notification. Returns the new status. */
export async function handleMidtransNotification(
  n: MidtransNotification,
): Promise<GatewayPaymentStatus | "ignored"> {
  if (!midtransConfigured()) {
    throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "Midtrans is not configured.");
  }
  if (!verifyMidtransSignature(n)) {
    throw Errors.unauthorized("Invalid Midtrans signature.");
  }

  const paid =
    n.transaction_status === "settlement" ||
    (n.transaction_status === "capture" && n.fraud_status === "accept");
  if (paid) {
    // gross_amount arrives as a decimal string ("125000.00") of whole rupiah.
    await finalizePaid("midtrans", n.order_id, Math.round(Number(n.gross_amount)));
    return "paid";
  }
  if (n.transaction_status === "expire") {
    await markTerminal("midtrans", n.order_id, "expired");
    return "expired";
  }
  if (["deny", "cancel", "failure"].includes(n.transaction_status)) {
    await markTerminal("midtrans", n.order_id, "failed");
    return "failed";
  }
  return "ignored"; // pending / authorize / refund states we don't act on
}

/** Handle a Xendit invoice callback after its token header has been verified. */
export async function handleXenditCallback(
  callbackToken: string | undefined,
  cb: XenditInvoiceCallback,
): Promise<GatewayPaymentStatus | "ignored"> {
  if (!xenditConfigured()) {
    throw new AppError(503, "PROVIDER_NOT_CONFIGURED", "Xendit is not configured.");
  }
  if (!verifyXenditCallbackToken(callbackToken)) {
    throw Errors.unauthorized("Invalid Xendit callback token.");
  }

  if (cb.status === "PAID" || cb.status === "SETTLED") {
    await finalizePaid("xendit", cb.external_id, cb.paid_amount ?? null);
    return "paid";
  }
  if (cb.status === "EXPIRED") {
    await markTerminal("xendit", cb.external_id, "expired");
    return "expired";
  }
  return "ignored";
}

/**
 * The money is confirmed: finalize the sale through the normal checkout engine.
 * Idempotent — a repeated webhook replays the same transaction. If finalization
 * fails (e.g. the stock sold out while the customer was paying), the payment is
 * still recorded as paid with the error attached; that is an ops problem
 * (refund), not a reason to pretend the money never arrived.
 */
async function finalizePaid(
  provider: PaymentProvider,
  externalRef: string,
  paidAmount: number | null,
): Promise<void> {
  const { rows } = await pool.query(
    `SELECT id, status, amount, cart, cashier_id
       FROM gateway_payments WHERE provider = $1 AND external_ref = $2`,
    [provider, externalRef],
  );
  if (rows.length === 0) throw Errors.notFound(`Unknown ${provider} order ${externalRef}.`);
  const row = rows[0];
  if (row.status === "paid") return; // webhook re-delivery — already done

  if (paidAmount !== null && paidAmount !== row.amount) {
    throw Errors.validation(
      `Paid amount ${paidAmount} does not match expected ${row.amount} for ${externalRef}.`,
    );
  }

  const cart = row.cart as StoredCart;
  try {
    const { transaction, isReplay } = await processCheckout(
      {
        items: cart.items,
        discount: cart.discount,
        payments: [{ method: provider, amount: row.amount }],
        cashierId: row.cashier_id,
      },
      `gw:${externalRef}`,
    );
    await pool.query(
      `UPDATE gateway_payments
          SET status = 'paid', transaction_id = $1, paid_at = now(), finalize_error = NULL
        WHERE id = $2`,
      [transaction.id, row.id],
    );
    if (!isReplay) await bumpReportsCacheVersion();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(`Gateway payment ${row.id} is paid but could not be fulfilled:`, reason);
    await pool.query(
      `UPDATE gateway_payments SET status = 'paid', paid_at = now(), finalize_error = $1 WHERE id = $2`,
      [reason, row.id],
    );
  }
}

/** Move a still-pending payment to a terminal state; never downgrades 'paid'. */
async function markTerminal(
  provider: PaymentProvider,
  externalRef: string,
  status: "failed" | "expired",
): Promise<void> {
  await pool.query(
    `UPDATE gateway_payments SET status = $1
      WHERE provider = $2 AND external_ref = $3 AND status = 'pending'`,
    [status, provider, externalRef],
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function assertProviderConfigured(provider: PaymentProvider): void {
  const ok = provider === "midtrans" ? midtransConfigured() : xenditConfigured();
  if (!ok) {
    throw new AppError(
      503,
      "PROVIDER_NOT_CONFIGURED",
      `Payment provider '${provider}' is not configured on this server.`,
    );
  }
}

async function loadProducts(productIds: string[]): Promise<Map<string, ProductRow>> {
  const { rows } = await pool.query<ProductRow>(
    `SELECT id, sku, name, price, stock FROM products WHERE id = ANY($1::text[])`,
    [productIds],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

async function findByIdempotencyKey(key: string): Promise<GatewayPaymentView | null> {
  const { rows } = await pool.query(
    `SELECT id, provider, status, amount, payment_url, provider_ref, external_ref, transaction_id, created_at, paid_at
       FROM gateway_payments WHERE idempotency_key = $1`,
    [key],
  );
  return rows.length === 0 ? null : toView(rows[0]);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}

function toView(r: {
  id: string;
  provider: PaymentProvider;
  status: GatewayPaymentStatus;
  amount: number;
  payment_url: string | null;
  provider_ref: string | null;
  external_ref: string;
  transaction_id: string | null;
  created_at: Date;
  paid_at: Date | null;
}): GatewayPaymentView {
  return {
    id: r.id,
    provider: r.provider,
    status: r.status,
    amount: r.amount,
    paymentUrl: r.payment_url,
    providerRef: r.provider_ref,
    externalRef: r.external_ref,
    transactionId: r.transaction_id,
    createdAt: r.created_at.toISOString(),
    paidAt: r.paid_at ? r.paid_at.toISOString() : null,
  };
}
