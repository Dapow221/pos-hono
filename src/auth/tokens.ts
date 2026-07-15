/**
 * Opaque refresh tokens.
 *
 * A refresh token is 32 random bytes (hex). We store only its SHA-256 hash in
 * the DB — so a database leak doesn't hand an attacker usable tokens — together
 * with user_id, expires_at and revoked_at. Tokens are rotated on every use.
 */
import { randomBytes, createHash } from "node:crypto";

export function generateRefreshToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashRefreshToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
