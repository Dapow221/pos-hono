/**
 * Midtrans client — Snap API over plain fetch (no SDK).
 *
 * Snap returns a hosted payment page (`redirect_url`) that accepts QRIS,
 * cards, e-wallets, and bank transfer, so one integration covers every method.
 * Webhook authenticity is a SHA-512 over order_id + status_code + gross_amount
 * + server key, exactly as Midtrans documents.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../env";
import { AppError } from "../errors";

export function midtransConfigured(): boolean {
  return Boolean(env.MIDTRANS_SERVER_KEY);
}

function snapBaseUrl(): string {
  return env.MIDTRANS_IS_PRODUCTION
    ? "https://app.midtrans.com/snap/v1"
    : "https://app.sandbox.midtrans.com/snap/v1";
}

function authHeader(): string {
  // Midtrans uses HTTP Basic with the server key as username and no password.
  return `Basic ${Buffer.from(`${env.MIDTRANS_SERVER_KEY}:`).toString("base64")}`;
}

export interface SnapCharge {
  /** Snap token (frontend can embed it in the Snap JS popup). */
  token: string;
  /** Hosted payment page the customer can open or be redirected to. */
  redirectUrl: string;
}

export interface SnapItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

export async function createSnapTransaction(args: {
  orderId: string;
  grossAmount: number;
  items: SnapItem[];
  customerEmail?: string;
  expiryMinutes: number;
}): Promise<SnapCharge> {
  const res = await fetch(`${snapBaseUrl()}/transactions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: authHeader(),
    },
    body: JSON.stringify({
      transaction_details: { order_id: args.orderId, gross_amount: args.grossAmount },
      // Midtrans REQUIRES item_details to sum exactly to gross_amount, so the
      // caller must include discount/tax/rounding as adjustment lines.
      item_details: args.items.map((i) => ({
        id: i.id,
        name: i.name.slice(0, 50),
        price: i.price,
        quantity: i.quantity,
      })),
      ...(args.customerEmail ? { customer_details: { email: args.customerEmail } } : {}),
      expiry: { unit: "minutes", duration: args.expiryMinutes },
    }),
  });

  const body = (await res.json().catch(() => null)) as
    | { token?: string; redirect_url?: string; error_messages?: string[] }
    | null;

  if (!res.ok || !body?.token || !body.redirect_url) {
    throw new AppError(502, "GATEWAY_ERROR", "Midtrans rejected the payment request.", {
      provider: "midtrans",
      status: res.status,
      errors: body?.error_messages,
    });
  }
  return { token: body.token, redirectUrl: body.redirect_url };
}

/**
 * Verify a Midtrans HTTP notification. signature_key must equal
 * sha512(order_id + status_code + gross_amount + server_key).
 */
export function verifyMidtransSignature(n: {
  order_id: string;
  status_code: string;
  gross_amount: string;
  signature_key: string;
}): boolean {
  const expected = createHash("sha512")
    .update(n.order_id + n.status_code + n.gross_amount + env.MIDTRANS_SERVER_KEY)
    .digest();
  const given = Buffer.from(n.signature_key, "hex");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
