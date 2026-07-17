/**
 * Gateway payments route (Midtrans / Xendit) — thin controller.
 *
 * Cashier-facing endpoints are permission-guarded like checkout. The webhook
 * endpoints are unauthenticated by nature (the gateway calls them) — each is
 * authenticated by its provider's own mechanism inside the service: Midtrans
 * by SHA-512 signature, Xendit by the shared callback token header.
 */
import { Hono } from "hono";
import {
  createPaymentSchema,
  midtransNotificationSchema,
  xenditInvoiceCallbackSchema,
} from "../schemas";
import {
  createGatewayPayment,
  getGatewayPayment,
  handleMidtransNotification,
  handleXenditCallback,
  simulateGatewayPaid,
} from "../services/payments";
import { env } from "../env";
import { Errors } from "../errors";
import { requirePermission, type AuthEnv } from "../middleware/auth";
import { PERMISSIONS } from "../auth/rbac";

const route = new Hono<AuthEnv>();

// POST /v1/payments — create a gateway charge for a cart. Same Idempotency-Key
// contract as checkout: a retried request replays the same payment link.
route.post("/", requirePermission(PERMISSIONS.CHECKOUT_CREATE), async (c) => {
  const idempotencyKey = c.req.header("Idempotency-Key");
  if (!idempotencyKey) {
    throw Errors.validation("Missing required 'Idempotency-Key' header.");
  }

  const body = await c.req.json().catch(() => {
    throw Errors.validation("Request body must be valid JSON.");
  });
  const input = createPaymentSchema.parse(body);

  const { payment, isReplay } = await createGatewayPayment(
    input,
    idempotencyKey,
    c.get("user").sub,
  );

  c.header("Idempotent-Replay", String(isReplay));
  return c.json({ data: payment }, isReplay ? 200 : 201);
});

// GET /v1/payments/{id} — status polling for the cashier screen. Once the
// webhook lands, `status` flips to "paid" and `transactionId` links the sale.
route.get("/:id", requirePermission(PERMISSIONS.CHECKOUT_CREATE), async (c) => {
  const payment = await getGatewayPayment(c.req.param("id"));
  return c.json({ data: payment });
});

// POST /v1/payments/{id}/simulate — DEV ONLY: mark a payment as paid without a
// real webhook, so the whole flow can be tested from the /demo page locally.
// Hidden (404) outside development so it can never fake a sale in production.
route.post("/:id/simulate", requirePermission(PERMISSIONS.CHECKOUT_CREATE), async (c) => {
  if (env.NODE_ENV !== "development") {
    throw Errors.notFound("Not found.");
  }
  const payment = await simulateGatewayPaid(c.req.param("id"));
  return c.json({ data: payment });
});

// POST /v1/payments/webhooks/midtrans — Midtrans HTTP notification.
route.post("/webhooks/midtrans", async (c) => {
  const body = await c.req.json().catch(() => {
    throw Errors.validation("Webhook body must be valid JSON.");
  });
  const result = await handleMidtransNotification(midtransNotificationSchema.parse(body));
  return c.json({ data: { received: true, result } });
});

// POST /v1/payments/webhooks/xendit — Xendit invoice callback.
route.post("/webhooks/xendit", async (c) => {
  const body = await c.req.json().catch(() => {
    throw Errors.validation("Webhook body must be valid JSON.");
  });
  const result = await handleXenditCallback(
    c.req.header("x-callback-token"),
    xenditInvoiceCallbackSchema.parse(body),
  );
  return c.json({ data: { received: true, result } });
});

export default route;
