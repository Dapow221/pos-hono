/**
 * Zod schemas — validation at the HTTP boundary.
 *
 * Nothing reaches the checkout service until it has passed these schemas, so the
 * service can trust its input (positive quantities, known payment methods, a
 * discount that is structurally valid). This is "parse, don't validate".
 */
import { z } from "zod";

// Cart shape shared by counter checkout and gateway payments: same items, same
// discount rules, so both paths price a sale identically.
const cartItemsSchema = z
  .array(
    z.object({
      productId: z.string().min(1),
      quantity: z.number().int().positive().max(1000),
    }),
  )
  .min(1, "A sale needs at least one item.")
  .max(100, "A single sale is capped at 100 line items.");

// Optional order-level discount: either a percentage (0–100) or a fixed amount.
const discountSchema = z
  .discriminatedUnion("type", [
    z.object({ type: z.literal("percentage"), value: z.number().min(0).max(100) }),
    z.object({ type: z.literal("fixed"), value: z.number().int().nonnegative() }),
  ])
  .optional();

export const checkoutSchema = z
  .object({
    items: cartItemsSchema,
    discount: discountSchema,

    // One or more tenders — supports split payment (e.g. part cash, part card).
    payments: z
      .array(
        z.object({
          method: z.enum(["cash", "card", "qris"]),
          amount: z.number().int().nonnegative(),
        }),
      )
      .min(1, "At least one payment is required."),

    cashierId: z.string().min(1).optional(),
  })
  .strict();

export type CheckoutInput = z.infer<typeof checkoutSchema>;

// ─── Gateway payments (Midtrans / Xendit) ───────────────────────────────────

/**
 * A gateway payment carries the cart, not an amount: the server prices the sale
 * itself (same rules as checkout), so a client can never charge the customer a
 * different total than the sale is worth.
 */
export const createPaymentSchema = z
  .object({
    provider: z.enum(["midtrans", "xendit"]),
    items: cartItemsSchema,
    discount: discountSchema,
    // Shown on the Xendit invoice / Midtrans page; optional.
    customerEmail: z.string().email().optional(),
  })
  .strict();

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

/** Midtrans HTTP notification — only the fields we act on; extras are ignored. */
export const midtransNotificationSchema = z.object({
  order_id: z.string().min(1),
  status_code: z.string().min(1),
  gross_amount: z.string().min(1),
  signature_key: z.string().min(1),
  transaction_status: z.string().min(1),
  fraud_status: z.string().optional(),
});

/** Xendit invoice callback — only the fields we act on; extras are ignored. */
export const xenditInvoiceCallbackSchema = z.object({
  external_id: z.string().min(1),
  status: z.string().min(1),
  paid_amount: z.number().optional(),
});

export type MidtransNotification = z.infer<typeof midtransNotificationSchema>;
export type XenditInvoiceCallback = z.infer<typeof xenditInvoiceCallbackSchema>;

// ─── Auth ─────────────────────────────────────────────────────────────────

export const registerSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(8, "Password must be at least 8 characters.").max(72),
    fullName: z.string().min(1).max(120),
    // Self-registration always creates a cashier; admins are provisioned by seed.
    role: z.literal("cashier").default("cashier"),
  })
  .strict();

export const loginSchema = z
  .object({
    email: z.string().email(),
    password: z.string().min(1),
  })
  .strict();

/** Quick-switch PIN: 4–6 digits. Hashed with bcrypt before it touches the DB. */
export const setPinSchema = z
  .object({
    pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4-6 digits."),
  })
  .strict();

/** Admin-provisioned user: created from the staff screen, no session issued. */
export const createUserSchema = z
  .object({
    email: z.string().email(),
    fullName: z.string().min(1).max(120),
    password: z.string().min(8, "Password must be at least 8 characters.").max(72),
    role: z.enum(["cashier", "admin"]).default("cashier"),
    // Optionally set the quick-switch PIN in the same request.
    pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4-6 digits.").optional(),
  })
  .strict();

/** PIN login: the cashier-switch screen sends the picked user's id + their PIN. */
export const pinLoginSchema = z
  .object({
    // Must be a UUID: a malformed id would otherwise error inside Postgres.
    userId: z.uuid(),
    pin: z.string().regex(/^\d{4,6}$/, "PIN must be 4-6 digits."),
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type SetPinInput = z.infer<typeof setPinSchema>;
export type PinLoginInput = z.infer<typeof pinLoginSchema>;

// ─── Product write ──────────────────────────────────────────────────────────

export const createProductSchema = z
  .object({
    id: z.string().min(1).max(64),
    sku: z.string().min(1).max(64),
    name: z.string().min(1).max(160),
    price: z.number().int().nonnegative(),
    stock: z.number().int().nonnegative(),
  })
  .strict();

export const updateProductSchema = z
  .object({
    sku: z.string().min(1).max(64).optional(),
    name: z.string().min(1).max(160).optional(),
    price: z.number().int().nonnegative().optional(),
    stock: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, "At least one field is required.");

export type CreateProductInput = z.infer<typeof createProductSchema>;
export type UpdateProductInput = z.infer<typeof updateProductSchema>;

// ─── Inventory (stock opname, barang masuk, penyesuaian) ────────────────────

/** Goods received from a supplier: only positive quantities, optional cost. */
export const goodsInSchema = z
  .object({
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          quantity: z.number().int().positive().max(100_000),
          unitCost: z.number().int().nonnegative().optional(),
        }),
      )
      .min(1, "Goods-in needs at least one line.")
      .max(100),
    supplier: z.string().trim().min(1).max(120).optional(),
    note: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

/** Stock opname: the physically counted quantity per product. */
export const opnameSchema = z
  .object({
    counts: z
      .array(
        z.object({
          productId: z.string().min(1),
          counted: z.number().int().nonnegative().max(1_000_000),
        }),
      )
      .min(1, "An opname needs at least one count.")
      .max(200),
    note: z.string().trim().min(1).max(300).optional(),
  })
  .strict();

/** Manual correction (waste, breakage, found stock): signed quantity + reason. */
export const stockAdjustmentSchema = z
  .object({
    productId: z.string().min(1),
    quantity: z
      .number()
      .int()
      .refine((v) => v !== 0, "Quantity cannot be zero.")
      .refine((v) => Math.abs(v) <= 100_000, "Quantity is out of range."),
    reason: z.string().trim().min(1).max(300),
  })
  .strict();

export const MOVEMENT_TYPES = ["sale", "goods_in", "adjustment", "opname"] as const;

/** Filters for the stock ledger. */
export const movementFilterSchema = z.object({
  productId: z.string().min(1).optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export type GoodsInInput = z.infer<typeof goodsInSchema>;
export type OpnameInput = z.infer<typeof opnameSchema>;
export type StockAdjustmentInput = z.infer<typeof stockAdjustmentSchema>;
export type MovementFilterInput = z.infer<typeof movementFilterSchema>;

// ─── Pembukuan (expenses) ───────────────────────────────────────────────────

export const createExpenseSchema = z
  .object({
    category: z.string().trim().min(1).max(60),
    description: z.string().trim().min(1).max(300),
    amount: z.number().int().positive(),
    /** Store-time calendar date the money was spent. */
    spentOn: z.iso.date(),
  })
  .strict();

export const expenseFilterSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  category: z.string().trim().min(1).max(60).optional(),
});

export type CreateExpenseInput = z.infer<typeof createExpenseSchema>;
export type ExpenseFilterInput = z.infer<typeof expenseFilterSchema>;

// ─── Reports ────────────────────────────────────────────────────────────────

/** Date-range query params. Defaults (last 30 days) are applied in the service. */
export const reportRangeSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
});

export type ReportRangeInput = z.infer<typeof reportRangeSchema>;

/**
 * Transaction-log filters. All optional and combinable; unlike the chart
 * reports there is NO default date range — the unfiltered log is "all time".
 */
export const transactionFilterSchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  cashierId: z.uuid().optional(),
  receipt: z.string().trim().min(1).max(64).optional(),
});

export type TransactionFilterInput = z.infer<typeof transactionFilterSchema>;
