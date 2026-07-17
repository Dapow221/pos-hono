/**
 * Xendit client — Invoice API over plain fetch (no SDK).
 *
 * An invoice is a hosted payment page (`invoice_url`) accepting QRIS, VA,
 * e-wallets, and cards. Webhook authenticity is a shared secret: Xendit echoes
 * the account's callback token in the `x-callback-token` header.
 */
import { timingSafeEqual } from "node:crypto";
import { env } from "../env";
import { AppError } from "../errors";

export function xenditConfigured(): boolean {
  return Boolean(env.XENDIT_SECRET_KEY && env.XENDIT_CALLBACK_TOKEN);
}

function authHeader(): string {
  // Xendit uses HTTP Basic with the secret key as username and no password.
  return `Basic ${Buffer.from(`${env.XENDIT_SECRET_KEY}:`).toString("base64")}`;
}

export interface XenditInvoice {
  /** Xendit's invoice id — kept so webhooks can be cross-checked. */
  id: string;
  /** Hosted payment page the customer can open or be redirected to. */
  invoiceUrl: string;
}

export async function createInvoice(args: {
  externalId: string;
  amount: number;
  description: string;
  customerEmail?: string;
  expiryMinutes: number;
}): Promise<XenditInvoice> {
  const res = await fetch("https://api.xendit.co/v2/invoices", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
    },
    body: JSON.stringify({
      external_id: args.externalId,
      amount: args.amount,
      description: args.description,
      currency: "IDR",
      invoice_duration: args.expiryMinutes * 60, // Xendit wants seconds
      ...(args.customerEmail ? { payer_email: args.customerEmail } : {}),
    }),
  });

  const body = (await res.json().catch(() => null)) as
    | { id?: string; invoice_url?: string; message?: string }
    | null;

  if (!res.ok || !body?.id || !body.invoice_url) {
    throw new AppError(502, "GATEWAY_ERROR", "Xendit rejected the payment request.", {
      provider: "xendit",
      status: res.status,
      message: body?.message,
    });
  }
  return { id: body.id, invoiceUrl: body.invoice_url };
}

/** Constant-time check of the `x-callback-token` webhook header. */
export function verifyXenditCallbackToken(header: string | undefined): boolean {
  if (!header || !env.XENDIT_CALLBACK_TOKEN) return false;
  const given = Buffer.from(header);
  const expected = Buffer.from(env.XENDIT_CALLBACK_TOKEN);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
