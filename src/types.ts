/** Shared domain types (the shape of a completed sale). */
import type { Rupiah } from "./money";

export interface TransactionLine {
  productId: string;
  sku: string;
  name: string;
  unitPrice: Rupiah;
  quantity: number;
  subtotal: Rupiah;
}

/**
 * Tender methods. cash/card/qris are taken at the counter; midtrans/xendit are
 * settled online through a gateway and only ever recorded by the webhook
 * finalizer — the public checkout schema does not accept them directly.
 */
export type PaymentMethod = "cash" | "card" | "qris" | "midtrans" | "xendit";

export interface Payment {
  method: PaymentMethod;
  amount: Rupiah;
}

export interface Transaction {
  id: string;
  receiptNo: string;
  createdAt: string;
  cashierId: string | null;
  lines: TransactionLine[];
  subtotal: Rupiah;
  discount: Rupiah;
  tax: Rupiah;
  rounding: Rupiah;
  grandTotal: Rupiah;
  payments: Payment[];
  amountPaid: Rupiah;
  change: Rupiah;
}
