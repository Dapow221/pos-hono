/**
 * User management service.
 *
 * PINs power the fast cashier-switch screen: pick your name, type your PIN.
 * They are bcrypt-hashed exactly like passwords — the plaintext PIN is never
 * stored and never returned by any endpoint.
 */
import { pool } from "../db";
import { Errors } from "../errors";
import { hashPassword } from "../auth/password";
import type { CreateUserInput } from "../schemas";
import type { Pagination } from "../pagination";

export interface Page<T> {
  rows: T[];
  total: number;
}

export interface UserWithPin {
  id: string;
  fullName: string;
  role: string;
}

export interface AdminUserView {
  id: string;
  email: string;
  fullName: string;
  role: string;
  hasPin: boolean;
  createdAt: string;
}

/** Set (or replace) a user's quick-switch PIN. */
export async function setUserPin(userId: string, pin: string): Promise<void> {
  const pinHash = await hashPassword(pin);
  const { rowCount } = await pool.query(`UPDATE users SET pin_hash = $1 WHERE id = $2`, [
    pinHash,
    userId,
  ]);
  if (rowCount === 0) throw Errors.notFound(`User ${userId} not found.`);
}

/**
 * All users that have a PIN set — the cashier-selection screen. This feeds the
 * PUBLIC lock screen, so it deliberately excludes emails and anything else
 * that isn't already visible on a staff picker.
 */
export async function listUsersWithPin(page: Pagination): Promise<Page<UserWithPin>> {
  const [{ rows }, count] = await Promise.all([
    pool.query<{ id: string; full_name: string; role: string }>(
      `SELECT id, full_name, role
         FROM users
        WHERE pin_hash IS NOT NULL
        ORDER BY full_name
        LIMIT $1 OFFSET $2`,
      [page.limit, page.offset],
    ),
    pool.query(`SELECT COUNT(*) AS total FROM users WHERE pin_hash IS NOT NULL`),
  ]);
  return {
    rows: rows.map((r) => ({ id: r.id, fullName: r.full_name, role: r.role })),
    total: Number(count.rows[0].total),
  };
}

/** Admin-provisioned user. Unlike /auth/register: any role, optional PIN, no session. */
export async function createUser(input: CreateUserInput): Promise<AdminUserView> {
  const exists = await pool.query(`SELECT 1 FROM users WHERE email = $1`, [input.email]);
  if (exists.rowCount && exists.rowCount > 0) {
    throw Errors.conflict("Email is already registered.");
  }

  const passwordHash = await hashPassword(input.password);
  const pinHash = input.pin ? await hashPassword(input.pin) : null;
  const { rows } = await pool.query<{ id: string; created_at: Date }>(
    `INSERT INTO users (email, password_hash, full_name, role, pin_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, created_at`,
    [input.email, passwordHash, input.fullName, input.role, pinHash],
  );

  return {
    id: rows[0]!.id,
    email: input.email,
    fullName: input.fullName,
    role: input.role,
    hasPin: input.pin !== undefined,
    createdAt: rows[0]!.created_at.toISOString(),
  };
}

/** Every account, for the admin staff screen. Hashes never leave the DB. */
export async function listUsers(page: Pagination): Promise<Page<AdminUserView>> {
  const [{ rows }, count] = await Promise.all([
    pool.query<{
      id: string;
      email: string;
      full_name: string;
      role: string;
      has_pin: boolean;
      created_at: Date;
    }>(
      `SELECT id, email, full_name, role, pin_hash IS NOT NULL AS has_pin, created_at
         FROM users
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2`,
      [page.limit, page.offset],
    ),
    pool.query(`SELECT COUNT(*) AS total FROM users`),
  ]);
  return {
    rows: rows.map((r) => ({
      id: r.id,
      email: r.email,
      fullName: r.full_name,
      role: r.role,
      hasPin: r.has_pin,
      createdAt: r.created_at.toISOString(),
    })),
    total: Number(count.rows[0].total),
  };
}
