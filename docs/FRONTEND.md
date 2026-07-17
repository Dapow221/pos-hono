# POS API — Frontend Handoff

Everything you need to build the frontend against the live API.

- **Base URL:** `http://103.28.52.139:3000` (plain HTTP for now; HTTPS + domain coming later)
- **Full API docs:** [`docs/API.md`](./API.md) (request/response detail per endpoint)
- **Postman:** import [`docs/pos-hono.postman_collection.json`](./pos-hono.postman_collection.json), run **Auth → Login (admin)** first — the token is stored in a collection variable and every other request uses it automatically.

## Test accounts (already seeded)

| Account | Login | Can access |
|---------|-------|------------|
| Admin | `admin@pos.test` / `Admin123!` | everything, incl. reports |
| Cashier | `kasir@pos.test` / `Kasir123!` | products (read), checkout — **no reports** |

## Conventions (apply everywhere)

- **Money is integer rupiah.** `18000` means Rp 18.000. No decimals, ever. Format on display only.
- **Auth header:** `Authorization: Bearer <accessToken>` on every protected call.
- **Response envelope:**
  ```json
  // success                          // error — always this shape
  { "data": ..., "meta": { ... } }    { "error": { "code": "STRING", "message": "...", "details": ... } }
  ```
- **Status codes:** 400 validation, 401 bad/expired token, 402 underpayment, 403 role lacks permission, 404 not found, 409 conflict/out-of-stock, 429 rate-limited.

## Endpoints

### Auth
- `POST /v1/auth/login` `{ email, password }` → `{ data: { user, accessToken } }`. The `user` object includes `role` and `permissions[]` — **drive UI visibility off `permissions`**, not the role name.
- `POST /v1/auth/register` — self-registration always creates a cashier.
- `POST /v1/auth/refresh`, `POST /v1/auth/logout`, `GET /v1/auth/me`.
- Access token (JWT) expires in **15 minutes** — see [gotchas](#gotchas--integration-notes) about refresh.

### Products
- `GET /v1/products?limit=100` (max 100), `GET /v1/products/:id` — any logged-in user.
- `POST /v1/products`, `PATCH /v1/products/:id` — admin only (`products:write`).

### Checkout
`POST /v1/checkout` — requires header **`Idempotency-Key: <uuid>`**. Generate a fresh UUID per sale attempt and **reuse it on retry** (network error, timeout): the same key can never create two sales; a replay returns `200` with the original receipt (`Idempotent-Replay: true` header) instead of `201`.

```json
{
  "items": [{ "productId": "p_kopi", "quantity": 2 }],
  "discount": { "type": "percentage", "value": 10 },      // optional; or { "type": "fixed", "value": 5000 }
  "payments": [{ "method": "cash", "amount": 50000 }]     // cash | card | qris — split payments allowed
}
```

Handle these errors in the checkout UI:
- `402 INSUFFICIENT_PAYMENT` — `details: { grandTotal, amountPaid, shortfall }`
- `409 INSUFFICIENT_STOCK` — `details: [{ productId, requested, available }]`

The response receipt contains `subtotal`, `discount`, `tax` (11% PPN), `rounding` (grand total rounded to nearest Rp 100), `grandTotal`, `amountPaid`, `change`, and full line items.

### Dashboard reports (admin only — `reports:read`)

Range endpoints take optional `?from=YYYY-MM-DD&to=YYYY-MM-DD` (inclusive, default **last 30 days**, max 366). Days are bucketed in **Asia/Jakarta** (echoed in `meta.timezone`).

| Endpoint | Use for |
|----------|---------|
| `GET /v1/reports/summary` | Stat cards: `transactions`, `grossRevenue`, `itemsSold`, `discountTotal`, `taxTotal`, `averageTicket` |
| `GET /v1/reports/sales-by-day` | Line/bar chart — zero-filled, one point per day, no gaps |
| `GET /v1/reports/top-products?limit=10` | Best-sellers table (`quantitySold`, `revenue`) |
| `GET /v1/reports/payment-methods` | Donut chart: per-method `payments` count + `amount` |
| `GET /v1/reports/low-stock?threshold=10` | Restock alert list (no date range) |
| `GET /v1/reports/recent-transactions?limit=10` | Activity feed (no date range) |

Responses are Redis-cached (~12 ms) and invalidated automatically after every sale or product change — poll freely, the data is never stale. `X-Cache: HIT/MISS` header shows cache status.

The server already holds **~300 demo transactions across the last 45 days**, so charts render with realistic data immediately.

## Gotchas / integration notes

1. **CORS is an explicit allowlist** and currently only allows `http://localhost:3000`. Send your dev origin (e.g. `http://localhost:5173`) to the backend so it can be added — until then, browser calls from other origins will fail.
2. **Silent refresh doesn't work cross-origin yet.** The refresh token lives in a `SameSite=Strict` httpOnly cookie, so `POST /v1/auth/refresh` only works when the frontend is served from the same origin as the API. Until both sit behind one domain: catch `401`, redirect to login. Never store tokens in `localStorage`; keep the access token in memory.
3. **Auth endpoints are rate-limited** more aggressively than the rest — expect `429` with a `Retry-After` header if you hammer login in dev (hot-reload loops).
4. **Demo data is server-only and disposable** — don't hardcode anything against specific receipts/IDs.
