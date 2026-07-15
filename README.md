# POS Hono

A small but production-shaped **point-of-sale REST API**: **Bun + Hono +
PostgreSQL** (raw `pg`, parameterized SQL, TypeScript strict). It demonstrates a
clean backend: JWT auth with rotating refresh tokens, RBAC, rate limiting, and a
transactional checkout engine that is safe under concurrency and retries.

## Features

- **Auth** — register / login / refresh / logout / me. JWT access tokens
  (≤15 min) + opaque refresh tokens stored hashed in the DB, rotated on every
  use, delivered via `httpOnly; SameSite=Strict` cookie. bcrypt cost 12.
- **RBAC** — `roles` table with a permissions array; route guards check
  *permissions*, never hardcoded role strings. Seeded `admin` and `cashier`.
- **Rate limiting** — auth endpoints capped at 5 req/min/IP (`429 + Retry-After`).
- **Checkout engine** — `POST /v1/checkout`: row-locked stock (`SELECT … FOR
  UPDATE`, anti-oversell), single DB transaction (atomic), integer-rupiah money
  math (discount → 11% tax → round to Rp 100), and idempotency keys
  (anti double-charge).
- **Hardening** — security headers, CORS allowlist, Zod validation at every
  boundary, centralized error handler, env validated at startup.

## Run

```bash
bun install
bun run src/migrate.ts     # tables + seed (roles, users, products) — idempotent
bun run dev                # http://localhost:3000
```

Postgres expected on `localhost:5432`, database `pos_hono` (override via
`DATABASE_URL` in `.env`; an `.env` with a generated `JWT_SECRET` is included).

### Demo accounts

| Email | Password | Role |
|-------|----------|------|
| `admin@pos.test` | `Admin123!` | admin |
| `kasir@pos.test` | `Kasir123!` | cashier |

## Docs

- **`docs/API.md`** — full API reference (in Bahasa Indonesia).
- **`docs/pos-hono.postman_collection.json`** — import into Postman. Login auto-
  saves the access token; refresh cookie is handled automatically.

## Project layout

```
src/
  index.ts                 Hono app: routes + CORS + security headers + error handler
  env.ts                   Zod-validated env (crashes at startup if misconfigured)
  db.ts                    pg Pool + withTransaction() (BEGIN/COMMIT/ROLLBACK)
  migrate.ts               Schema + seed (roles, users, products)
  money.ts                 Integer-rupiah math
  schemas.ts               Zod request schemas
  errors.ts                AppError + typed error factory
  types.ts                 Domain types
  auth/
    password.ts            bcrypt (cost 12) via Bun.password
    jwt.ts                 access-token sign/verify (HS256)
    tokens.ts              opaque refresh token generate/hash
    rbac.ts                permission catalogue + role→permission map
  middleware/
    auth.ts                requireAuth / requirePermission
    rateLimit.ts           fixed-window limiter
  services/
    auth.ts                register / login / refresh (rotation) / logout
    checkout.ts            ⭐ processCheckout — the transactional checkout engine
  routes/
    auth.ts                /v1/auth/*
    products.ts            /v1/products  (GET read, POST/PATCH write)
    checkout.ts            /v1/checkout
```

> The interview "complex case" walkthrough (question #2) — script in Bahasa
> Indonesia — will be added later, built around `src/services/checkout.ts`.
