/** Checkout route — thin controller around the checkout service. */
import { Hono } from "hono";
import { checkoutSchema } from "../schemas";
import { processCheckout } from "../services/checkout";
import { bumpReportsCacheVersion } from "../cache";
import { Errors } from "../errors";
import { requirePermission, type AuthEnv } from "../middleware/auth";
import { PERMISSIONS } from "../auth/rbac";

const route = new Hono<AuthEnv>();

// POST /v1/checkout — requires checkout:create.
// Requires an `Idempotency-Key` header so retries are safe (no double charge).
route.post("/", requirePermission(PERMISSIONS.CHECKOUT_CREATE), async (c) => {
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey) {
    throw Errors.validation("Missing required 'Idempotency-Key' header.");
  }

  const body = await c.req.json().catch(() => {
    throw Errors.validation("Request body must be valid JSON.");
  });

  // Zod parses at the boundary; the service trusts its input from here on.
  // The cashier is always the authenticated user, not a client-supplied value.
  const input = { ...checkoutSchema.parse(body), cashierId: c.get("user").sub };

  const { transaction, isReplay } = await processCheckout(input, idempotencyKey);

  // A new sale changes every report; a replay changes nothing.
  if (!isReplay) await bumpReportsCacheVersion();

  c.header("Idempotent-Replay", String(isReplay));
  // 201 Created for a new sale, 200 OK when we replayed an existing one.
  return c.json({ data: transaction }, isReplay ? 200 : 201);
});

export default route;
