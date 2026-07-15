/**
 * Access-token (JWT) signing and verification.
 *
 * The access token is short-lived (<= 15 min) and stateless: it carries the
 * user's id, role and resolved permissions, so authorization checks don't need
 * a DB round-trip on every request. Long-lived state lives in the opaque refresh
 * token instead (see tokens.ts).
 */
import { sign, verify } from "hono/jwt";
import { env } from "../env";

export interface AccessTokenPayload {
  sub: string; // user id
  email: string;
  role: string;
  permissions: string[];
  type: "access";
  exp: number; // seconds since epoch
  iat: number;
  // Index signature so the payload satisfies hono/jwt's JWTPayload.
  [key: string]: unknown;
}

export async function signAccessToken(
  user: { id: string; email: string; role: string; permissions: string[] },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: AccessTokenPayload = {
    sub: user.id,
    email: user.email,
    role: user.role,
    permissions: user.permissions,
    type: "access",
    iat: now,
    exp: now + env.ACCESS_TOKEN_TTL_MIN * 60,
  };
  return sign(payload, env.JWT_SECRET, "HS256");
}

export async function verifyAccessToken(token: string): Promise<AccessTokenPayload> {
  // `verify` throws on bad signature or expiry; callers translate that to 401.
  const payload = (await verify(token, env.JWT_SECRET, "HS256")) as unknown as AccessTokenPayload;
  if (payload.type !== "access") throw new Error("Wrong token type.");
  return payload;
}
