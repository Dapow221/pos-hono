/**
 * App entry: wires routes, security headers, and ONE centralized error handler.
 * Handlers never format their own error responses — they throw AppError (or Zod
 * throws), and `app.onError` converts everything to the standard envelope.
 */
import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { ZodError } from "zod";
import { env } from "./env";
import { AppError } from "./errors";
import authRoute from "./routes/auth";
import productsRoute from "./routes/products";
import checkoutRoute from "./routes/checkout";

const app = new Hono();

app.use("*", logger());
app.use("*", secureHeaders());
// Explicit CORS allowlist (never "*" with credentials) so the refresh cookie works.
app.use("*", cors({ origin: env.CORS_ORIGINS, credentials: true }));

app.get("/health", (c) => c.json({ status: "ok" }));
app.route("/v1/auth", authRoute);
app.route("/v1/products", productsRoute);
app.route("/v1/checkout", checkoutRoute);

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ error: { code: err.code, message: err.message, details: err.details } }, err.statusCode as 400);
  }
  if (err instanceof ZodError) {
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: "Request validation failed.", details: err.flatten() } },
      400,
    );
  }
  // Unexpected (programmer) error: log full detail, return a generic message.
  console.error(err);
  return c.json({ error: { code: "INTERNAL_ERROR", message: "Something went wrong." } }, 500);
});

console.log(`POS API listening on http://localhost:${env.PORT}`);

export default {
  port: env.PORT,
  fetch: app.fetch,
};
