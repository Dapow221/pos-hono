/**
 * Authentication + authorization middleware.
 *
 * `requireAuth` validates the Bearer access token and attaches the payload to
 * the context. `requirePermission` additionally checks the token carries a
 * given permission. Handlers stay thin and never parse tokens themselves.
 */
import type { MiddlewareHandler } from "hono";
import { verifyAccessToken, type AccessTokenPayload } from "../auth/jwt";
import type { Permission } from "../auth/rbac";
import { AppError } from "../errors";

// Typed context variables so `c.get("user")` is fully typed downstream.
export type AuthEnv = { Variables: { user: AccessTokenPayload } };

function extractBearer(header: string | undefined): string {
  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError(401, "UNAUTHORIZED", "Missing or malformed Authorization header.");
  }
  return header.slice("Bearer ".length).trim();
}

export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  const token = extractBearer(c.req.header("Authorization"));
  let payload: AccessTokenPayload;
  try {
    payload = await verifyAccessToken(token);
  } catch {
    throw new AppError(401, "UNAUTHORIZED", "Invalid or expired access token.");
  }
  c.set("user", payload);
  await next();
};

export function requirePermission(permission: Permission): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const token = extractBearer(c.req.header("Authorization"));
    let payload: AccessTokenPayload;
    try {
      payload = await verifyAccessToken(token);
    } catch {
      throw new AppError(401, "UNAUTHORIZED", "Invalid or expired access token.");
    }
    if (!payload.permissions.includes(permission)) {
      throw new AppError(403, "FORBIDDEN", `Missing required permission: ${permission}`);
    }
    c.set("user", payload);
    await next();
  };
}
