/**
 * Zod schemas — validation at the HTTP boundary.
 *
 * Nothing reaches the checkout service until it has passed these schemas, so the
 * service can trust its input (positive quantities, known payment methods, a
 * discount that is structurally valid). This is "parse, don't validate".
 */
import { z } from "zod";

export const checkoutSchema = z
  .object({
    items: z
      .array(
        z.object({
          productId: z.string().min(1),
          quantity: z.number().int().positive().max(1000),
        }),
      )
      .min(1, "A sale needs at least one item.")
      .max(100, "A single sale is capped at 100 line items."),

    // Optional order-level discount: either a percentage (0–100) or a fixed amount.
    discount: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("percentage"), value: z.number().min(0).max(100) }),
        z.object({ type: z.literal("fixed"), value: z.number().int().nonnegative() }),
      ])
      .optional(),

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

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;

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
