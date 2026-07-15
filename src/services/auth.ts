/**
 * Auth service: registration, login, refresh-token rotation, logout.
 *
 * Access tokens are stateless JWTs (15 min). Refresh tokens are opaque, stored
 * hashed in `refresh_tokens`, and ROTATED on every use: the old token is revoked
 * and a new one issued in the same transaction. Reusing a revoked token (a sign
 * of theft) is rejected.
 */
import { pool, withTransaction } from "../db";
import { Errors } from "../errors";
import { hashPassword, verifyPassword } from "../auth/password";
import { signAccessToken } from "../auth/jwt";
import { generateRefreshToken, hashRefreshToken } from "../auth/tokens";
import { env } from "../env";
import type { RegisterInput, LoginInput } from "../schemas";

export interface PublicUser {
  id: string;
  email: string;
  fullName: string;
  role: string;
  permissions: string[];
}

export interface AuthTokens {
  accessToken: string;
  accessTokenExpiresIn: number; // seconds
  refreshToken: string; // opaque; returned so the route can set the cookie
  refreshTokenExpiresAt: Date;
}

async function loadPermissions(role: string): Promise<string[]> {
  const { rows } = await pool.query<{ permissions: string[] }>(
    `SELECT permissions FROM roles WHERE name = $1`,
    [role],
  );
  return rows[0]?.permissions ?? [];
}

async function issueTokens(user: PublicUser): Promise<AuthTokens> {
  const accessToken = await signAccessToken(user);
  const refreshToken = generateRefreshToken();
  const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  await pool.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
    [user.id, hashRefreshToken(refreshToken), expiresAt],
  );

  return {
    accessToken,
    accessTokenExpiresIn: env.ACCESS_TOKEN_TTL_MIN * 60,
    refreshToken,
    refreshTokenExpiresAt: expiresAt,
  };
}

export async function register(input: RegisterInput): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const exists = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [input.email]);
  if (exists.rowCount && exists.rowCount > 0) {
    throw Errors.conflict("Email is already registered.");
  }

  const passwordHash = await hashPassword(input.password);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO users (email, password_hash, full_name, role) VALUES ($1, $2, $3, $4) RETURNING id`,
    [input.email, passwordHash, input.fullName, input.role],
  );

  const user: PublicUser = {
    id: rows[0]!.id,
    email: input.email,
    fullName: input.fullName,
    role: input.role,
    permissions: await loadPermissions(input.role),
  };
  return { user, tokens: await issueTokens(user) };
}

export async function login(input: LoginInput): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const { rows } = await pool.query<{
    id: string;
    email: string;
    password_hash: string;
    full_name: string;
    role: string;
  }>(`SELECT id, email, password_hash, full_name, role FROM users WHERE email = $1`, [input.email]);

  const row = rows[0];
  // Always run a verify (even when the user is missing) to avoid leaking which
  // emails exist via response timing.
  const ok = row
    ? await verifyPassword(input.password, row.password_hash)
    : await verifyPassword(input.password, "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidin");
  if (!row || !ok) throw Errors.unauthorized("Invalid email or password.");

  const user: PublicUser = {
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    permissions: await loadPermissions(row.role),
  };
  return { user, tokens: await issueTokens(user) };
}

/**
 * Rotate a refresh token: validate the presented token, revoke it, and issue a
 * fresh access+refresh pair — all in one transaction so a token can never be
 * spent twice.
 */
export async function refresh(presentedToken: string): Promise<{ user: PublicUser; tokens: AuthTokens }> {
  const tokenHash = hashRefreshToken(presentedToken);

  return withTransaction(async (tx) => {
    const { rows } = await tx.query<{
      id: string;
      user_id: string;
      revoked_at: Date | null;
      expires_at: Date;
    }>(
      `SELECT id, user_id, revoked_at, expires_at
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [tokenHash],
    );
    const stored = rows[0];
    if (!stored) throw Errors.unauthorized("Invalid refresh token.");
    if (stored.revoked_at) throw Errors.unauthorized("Refresh token has been revoked.");
    if (stored.expires_at.getTime() <= Date.now()) throw Errors.unauthorized("Refresh token expired.");

    // Revoke the old token (rotation).
    await tx.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1`, [stored.id]);

    const userRows = await tx.query<{ id: string; email: string; full_name: string; role: string }>(
      `SELECT id, email, full_name, role FROM users WHERE id = $1`,
      [stored.user_id],
    );
    const u = userRows.rows[0];
    if (!u) throw Errors.unauthorized("User no longer exists.");

    const permRows = await tx.query<{ permissions: string[] }>(
      `SELECT permissions FROM roles WHERE name = $1`,
      [u.role],
    );
    const user: PublicUser = {
      id: u.id,
      email: u.email,
      fullName: u.full_name,
      role: u.role,
      permissions: permRows.rows[0]?.permissions ?? [],
    };

    // Issue the new pair inside the same transaction.
    const accessToken = await signAccessToken(user);
    const newRefresh = generateRefreshToken();
    const expiresAt = new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
    await tx.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, replaced_token_id)
       VALUES ($1, $2, $3, $4)`,
      [user.id, hashRefreshToken(newRefresh), expiresAt, stored.id],
    );

    const tokens: AuthTokens = {
      accessToken,
      accessTokenExpiresIn: env.ACCESS_TOKEN_TTL_MIN * 60,
      refreshToken: newRefresh,
      refreshTokenExpiresAt: expiresAt,
    };
    return { user, tokens };
  });
}

/** Revoke the presented refresh token (logout). Idempotent. */
export async function logout(presentedToken: string): Promise<void> {
  await pool.query(
    `UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL`,
    [hashRefreshToken(presentedToken)],
  );
}
