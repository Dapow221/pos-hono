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

export interface Payment {
  method: "cash" | "card" | "qris";
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
