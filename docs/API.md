# Dokumentasi API — POS Hono

REST API kasir (Point of Sale) sederhana, dibikin pakai **Bun + Hono +
PostgreSQL**. Yang penting di sini: login/autentikasi (JWT + refresh token),
RBAC (role & permission), dan endpoint **checkout** yang aman — nggak bakal
oversell stok dan nggak bakal nge-charge dobel.

> Catatan: semua duit di sini bentuknya **angka bulat rupiah** (misal `18000`
> artinya Rp 18.000). Sengaja nggak pakai koma/desimal biar nggak ada rupiah
> yang ilang gara-gara pembulatan float.

---

## 1. Cara jalanin server

```bash
bun install
bun run src/migrate.ts     # bikin tabel + isi data awal (role, user, produk). Aman diulang kok
bun run dev                # http://localhost:3000
bun run seed:demo 20000    # (opsional) isi 20 ribu transaksi demo buat nyobain paginasi/dashboard
```

> Data demo transaksi bisa dihapus lagi dengan
> `DELETE FROM transactions WHERE idempotency_key LIKE 'demo-%';`

Postgres-nya diasumsiin udah jalan di `localhost:5432`, database `pos_hono`
(kalau beda, tinggal ganti `DATABASE_URL` di file `.env`).

### Akun buat nyobain (udah otomatis dibikin pas migrate)

| Email | Password | Role | Bisa ngapain aja |
|-------|----------|------|------------------|
| `admin@pos.test` | `Admin123!` | admin | products:read, products:write, checkout:create, reports:read |
| `kasir@pos.test` | `Kasir123!` | cashier | products:read, checkout:create |

---

## 2. Cara pakai di Postman

1. Import file `docs/pos-hono.postman_collection.json` ke Postman.
2. Jalanin **Auth → Login (admin)** dulu. Token-nya bakal otomatis kesimpan ke
   variable koleksi, jadi request lain tinggal pakai `{{accessToken}}` — nggak
   usah copy-paste token manual.
3. Refresh token disimpen di **cookie httpOnly**, dan Postman ngurusin cookie ini
   otomatis. Jadi **Refresh token** sama **Logout** langsung jalan tanpa ribet.
4. Mau ngetes RBAC? Login sebagai kasir, terus coba **Create product** —
   harusnya kena `403` karena kasir nggak punya izin buat bikin produk.

---

## 3. Format umum

### Kalau sukses
```json
{ "data": { ... }, "meta": { ... } }   // meta cuma muncul pas list data
```

### Kalau error
Semua error bentuknya sama, biar gampang di-handle:
```json
{ "error": { "code": "STRING", "message": "STRING", "details": { } } }
```

### Arti kode status
| Status | Artinya |
|--------|---------|
| 200 | Aman, berhasil |
| 201 | Data baru kebuat |
| 204 | Berhasil, tapi nggak ada isi (contohnya logout) |
| 400 | Request-nya salah/nggak valid |
| 401 | Belum login / token-nya nggak bener |
| 402 | Uang bayarnya kurang dari total |
| 403 | Udah login sih, tapi izinnya nggak cukup |
| 404 | Datanya nggak ketemu |
| 409 | Bentrok (datanya dobel / stok kurang) |
| 429 | Kebanyakan request, dikasih jeda dulu |

### Soal login (autentikasi)
Endpoint yang dikunci butuh header ini:
```
Authorization: Bearer <accessToken>
```
- **Access token**: JWT, umurnya pendek (maks 15 menit), isinya `role` +
  `permissions`.
- **Refresh token**: token acak, disimpen dalam bentuk **hash** di DB, dikirim
  lewat cookie `httpOnly; SameSite=Strict`. Tiap dipakai, langsung **diganti
  baru** (yang lama otomatis dimatiin) — ini biar aman kalau sampai bocor.

---

## 4. Endpoint Auth

> Semua endpoint `/v1/auth/*` dibatasin **5 request per menit per IP**. Kalau
> kebanyakan nyoba (misal salah password terus), bakal kena `429` sebentar.

### POST `/v1/auth/register`
Daftar user baru. Otomatis jadi role `cashier`.

Yang dikirim:
```json
{ "email": "kasir.baru@pos.test", "password": "Rahasia123!", "fullName": "Kasir Baru" }
```
Balikannya `201` (sama kayak login) + cookie refresh token kepasang.

| Error | Kapan munculnya |
|-------|-----------------|
| 400 | email-nya ngaco / password kurang dari 8 huruf |
| 409 | email-nya udah kedaftar duluan |

---

### POST `/v1/auth/login`
Yang dikirim:
```json
{ "email": "admin@pos.test", "password": "Admin123!" }
```
Balikannya `200`:
```json
{
  "data": {
    "user": {
      "id": "uuid",
      "email": "admin@pos.test",
      "fullName": "Admin Toko",
      "role": "admin",
      "permissions": ["products:read", "products:write", "checkout:create", "reports:read"]
    },
    "accessToken": "eyJhbGci...",
    "tokenType": "Bearer",
    "expiresIn": 900
  }
}
```
Di header response, cookie `refresh_token` (httpOnly) juga ikut kepasang.

| Error | Kapan munculnya |
|-------|-----------------|
| 401 | email atau password-nya salah |

---

### POST `/v1/auth/refresh`
Nggak usah kirim body apa-apa. Dia baca cookie `refresh_token`, terus ngasih
access token baru **plus** cookie refresh baru (yang lama langsung dimatiin).

| Error | Kapan munculnya |
|-------|-----------------|
| 401 | cookie-nya nggak ada / token udah dimatiin / udah kadaluarsa |

---

### POST `/v1/auth/logout`
Matiin refresh token sama hapus cookie-nya. Balikannya `204` (kosong, nggak ada
isi).

---

### GET `/v1/auth/me`  🔒
Header: `Authorization: Bearer <accessToken>`

Balikannya `200`:
```json
{ "data": { "id": "uuid", "email": "admin@pos.test", "role": "admin", "permissions": ["..."] } }
```

---

## 5. Endpoint Products

### GET `/v1/products?limit&offset`  🔒 butuh `products:read`
Paginasi offset: `limit` (default 100, maks 100) + `offset` (default 0).
Parameter yang ngaco (bukan angka / negatif) di-fallback ke default, nggak error.

Balikannya `200`:
```json
{
  "data": [{ "id": "p_kopi", "sku": "BVG-001", "name": "Kopi Susu", "price": 18000, "stock": 50 }],
  "meta": { "total": 7, "limit": 100, "offset": 0, "hasMore": false }
}
```
Ngambil halaman berikutnya: `offset += limit` selama `hasMore` masih `true`.

### GET `/v1/products/:id`  🔒 butuh `products:read`
Balikannya `200` → `{ "data": { ... } }`, atau `404` kalau produknya nggak ada.

### POST `/v1/products`  🔒 butuh `products:write` (cuma admin)
Yang dikirim:
```json
{ "id": "p_donat", "sku": "FD-003", "name": "Donat Gula", "price": 7000, "stock": 40 }
```
Balikannya `201` + header `Location: /v1/products/p_donat`.

| Error | Kapan munculnya |
|-------|-----------------|
| 403 | role-nya nggak punya izin products:write (contoh: kasir) |
| 409 | id atau sku-nya udah ada |

### PATCH `/v1/products/:id`  🔒 butuh `products:write` (cuma admin)
Buat update sebagian aja (minimal isi satu field): `sku`, `name`, `price`,
`stock`.
```json
{ "price": 8000, "stock": 60 }
```
Balikannya `200` → data produk terbaru. `404` kalau nggak ada.

---

## 6. Endpoint Checkout (ini inti sistemnya)

### POST `/v1/checkout`  🔒 butuh `checkout:create`

Header yang wajib:
```
Authorization: Bearer <accessToken>
Idempotency-Key: <string unik buat tiap transaksi>
```

Yang dikirim:
```json
{
  "items": [
    { "productId": "p_kopi", "quantity": 2 },
    { "productId": "p_nasi", "quantity": 1 }
  ],
  "discount": { "type": "percentage", "value": 10 },
  "payments": [
    { "method": "cash", "amount": 100000 }
  ]
}
```

- `items`: 1–100 baris, `quantity` harus bulat dan lebih dari 0.
- `discount` (opsional): `{ "type": "percentage", "value": 0..100 }` atau
  `{ "type": "fixed", "value": <rupiah> }`.
- `payments`: minimal 1, boleh lebih dari satu (bayar campur, misal cash +
  kartu). `method` boleh `cash`, `card`, atau `qris`.

Urutan ngitungnya: **subtotal → diskon → PPN 11% (dihitung dari harga setelah
diskon) → dibulatin ke Rp 100 terdekat → kembalian**.

Balikannya `201` (transaksi baru):
```json
{
  "data": {
    "id": "uuid",
    "receiptNo": "RCP-XXXX",
    "createdAt": "2026-06-29T13:49:05.981Z",
    "cashierId": "uuid-kasir",
    "lines": [
      { "productId": "p_kopi", "sku": "BVG-001", "name": "Kopi Susu", "unitPrice": 18000, "quantity": 2, "subtotal": 36000 },
      { "productId": "p_nasi", "sku": "FD-002", "name": "Nasi Goreng", "unitPrice": 25000, "quantity": 1, "subtotal": 25000 }
    ],
    "subtotal": 61000,
    "discount": 6100,
    "tax": 6039,
    "rounding": -39,
    "grandTotal": 60900,
    "payments": [{ "method": "cash", "amount": 100000 }],
    "amountPaid": 100000,
    "change": 39100
  }
}
```

**Soal Idempotency**: kalau kamu kirim ulang pakai `Idempotency-Key` yang sama
(misal gara-gara sinyal jelek terus di-retry), dia bakal balikin struk yang
**sama persis**, status `200`, plus header `Idempotent-Replay: true`. Jadi
nggak bikin transaksi baru — customer aman nggak kena charge dua kali.

| Error | Kapan munculnya |
|-------|-----------------|
| 400 | `Idempotency-Key` nggak diisi / body-nya ngaco |
| 402 | total bayar kurang dari tagihan (liat `details.shortfall`) |
| 403 | nggak punya izin checkout:create |
| 404 | productId-nya nggak ada |
| 409 | stok kurang (`details` nunjukin barang mana yang kurang) |

Contoh error stok kurang (`409`):
```json
{
  "error": {
    "code": "INSUFFICIENT_STOCK",
    "message": "One or more items do not have enough stock.",
    "details": [{ "productId": "p_nasi", "requested": 999, "available": 19 }]
  }
}
```

---

## 7. Endpoint Payments — bayar online via Midtrans / Xendit

Buat customer yang mau bayar lewat QRIS/e-wallet/VA/kartu online. Bedanya sama
checkout biasa: pembayarannya **asinkron** — kasir bikin tagihan dulu, customer
bayar lewat halaman gateway, terus gateway ngasih tahu server lewat **webhook**.
Baru pas webhook itu masuk, stok dipotong dan transaksi dicatat (lewat mesin
checkout yang sama, jadi anti oversell & anti dobel juga berlaku di sini).

Setup di `.env` (dua-duanya opsional — provider yang belum diisi bakal balas
`503 PROVIDER_NOT_CONFIGURED`):

```
MIDTRANS_SERVER_KEY=SB-Mid-server-xxxx   # sandbox: https://dashboard.sandbox.midtrans.com
MIDTRANS_IS_PRODUCTION=false
XENDIT_SECRET_KEY=xnd_development_xxxx   # https://dashboard.xendit.co
XENDIT_CALLBACK_TOKEN=xxxx               # Settings → Webhooks → verification token
PAYMENT_EXPIRY_MIN=30                    # umur link pembayaran (menit)
```

Jangan lupa daftarin URL webhook di dashboard masing-masing:
- Midtrans → Payment Notification URL: `https://<server>/v1/payments/webhooks/midtrans`
- Xendit → Invoices callback: `https://<server>/v1/payments/webhooks/xendit`

### POST `/v1/payments`  🔒 butuh `checkout:create`

Header wajib sama kayak checkout: `Authorization` + `Idempotency-Key`.

Yang dikirim (perhatiin: **nggak ada field `amount`** — server yang ngitung
totalnya pakai aturan harga yang sama persis kayak checkout, jadi client nggak
bisa nagih customer beda dari harga aslinya):
```json
{
  "provider": "midtrans",
  "items": [{ "productId": "p_kopi", "quantity": 2 }],
  "discount": { "type": "percentage", "value": 10 },
  "customerEmail": "budi@example.com"
}
```

- `provider`: `midtrans` (halaman Snap) atau `xendit` (invoice).
- `items` + `discount`: aturannya sama persis kayak checkout.
- `customerEmail` (opsional): muncul di halaman pembayaran.

Balikannya `201`:
```json
{
  "data": {
    "id": "uuid",
    "provider": "midtrans",
    "status": "pending",
    "amount": 35900,
    "paymentUrl": "https://app.sandbox.midtrans.com/snap/v4/redirection/…",
    "providerRef": "token-snap-atau-id-invoice",
    "externalRef": "pos-…",
    "transactionId": null,
    "createdAt": "2026-07-16T12:00:00.000Z",
    "paidAt": null
  }
}
```

Kasih `paymentUrl` ke customer (buka link / tampilin QR-nya). Idempotency-nya
sama kayak checkout: kirim ulang pakai key yang sama → balikin payment yang
sama, `200`, header `Idempotent-Replay: true`.

> Buat frontend: kalau provider-nya `midtrans`, `providerRef` itu **Snap
> token** — bisa langsung dipakai `window.snap.pay(providerRef, {...})` biar
> popup pembayarannya kebuka di dalam halaman kamu sendiri (butuh `snap.js` +
> client key Midtrans, yang memang public). Kalau `xendit`, `providerRef` itu
> id invoice-nya; pakai `paymentUrl` buat redirect/iframe.

### GET `/v1/payments/{id}`  🔒 butuh `checkout:create`

Buat polling dari layar kasir. Begitu customer bayar dan webhook-nya masuk,
`status` berubah jadi `paid` dan `transactionId` keisi (itu id transaksi di
`/v1/checkout`, lengkap sama struknya). Status yang mungkin: `pending`,
`paid`, `failed`, `expired`.

### POST `/v1/payments/{id}/simulate`  🔒 butuh `checkout:create` — **khusus development**

Nandain payment sebagai lunas **tanpa** webhook beneran — buat ngetes dari
frontend lokal, soalnya gateway nggak bisa nembak `localhost`. Lewat jalur
finalisasi yang sama persis kayak webhook asli (stok kepotong, transaksi
kebikin, idempotent). Cuma aktif kalau `NODE_ENV=development`; di production
endpoint ini balas `404`, jadi nggak mungkin dipakai buat malsuin penjualan.

Balikannya `200` dengan payment yang udah `paid` + `transactionId` keisi.

### POST `/v1/payments/webhooks/midtrans` dan `/v1/payments/webhooks/xendit`

Ini yang dipanggil **gateway**, bukan frontend — jadi nggak pakai Bearer token.
Keamanannya pakai mekanisme masing-masing provider:
- Midtrans: `signature_key` diverifikasi (SHA-512 dari `order_id` +
  `status_code` + `gross_amount` + server key). Salah → `401`.
- Xendit: header `x-callback-token` harus cocok sama `XENDIT_CALLBACK_TOKEN`.
  Salah → `401`.

Webhook aman dikirim berulang: pembayaran yang udah `paid` nggak diproses dua
kali (idempotency key turunan `gw:<externalRef>` di mesin checkout).

Kasus langka: customer udah bayar tapi stoknya keburu abis dijual kasir lain.
Duitnya tetep dicatat (`status: "paid"`) tapi `transactionId`-nya kosong dan
alasannya kesimpen di kolom `finalize_error` — itu sinyal buat refund manual,
bukan alesan buat pura-pura duitnya nggak masuk.

| Error | Kapan munculnya |
|-------|-----------------|
| 400 | `Idempotency-Key` nggak diisi / body ngaco / jumlah bayar dari gateway nggak cocok |
| 401 | signature/callback token webhook salah |
| 404 | productId nggak ada, payment id nggak ada, atau webhook nyebut order yang nggak dikenal |
| 409 | stok kurang pas bikin tagihan |
| 502 | gateway-nya nolak request (key salah, dsb.) |
| 503 | provider belum dikonfigurasi di `.env` |

---

## 8. Endpoint Reports (buat dashboard) 🔒 butuh `reports:read` (cuma admin)

Semua endpoint di bawah ini read-only, khusus buat nyuplai data dashboard.
Endpoint yang berbasis rentang tanggal nerima query opsional `from` dan `to`
(format `YYYY-MM-DD`, dua-duanya inklusif). Kalau nggak diisi, default-nya
**30 hari terakhir**. Rentangnya dibatasi maksimal 366 hari.

> Soal "hari": transaksi dikelompokkan per tanggal **Asia/Jakarta** (WIB),
> bukan timezone server. Jadi "penjualan hari ini" ya bener-bener hari ini
> versi toko. Timezone-nya ikut kebawa di `meta.timezone`.

> Soal cache: semua response reports di-cache di **Redis** (maks 5 menit), dan
> otomatis di-invalidate tiap ada checkout baru atau perubahan produk — jadi
> datanya nggak pernah basi. Cek header `X-Cache: HIT/MISS` buat liat kerjanya.
> Kalau Redis-nya mati, endpoint tetap jalan normal (langsung ke Postgres).

### GET `/v1/reports/summary?from&to`
Angka-angka utama buat kartu di atas dashboard.
```json
{
  "data": {
    "transactions": 11, "grossRevenue": 237400, "itemsSold": 17,
    "discountTotal": 12200, "taxTotal": 23518, "averageTicket": 21582
  },
  "meta": { "from": "2026-06-16", "to": "2026-07-15", "timezone": "Asia/Jakarta" }
}
```

### GET `/v1/reports/sales-by-day?from&to`
Deret harian buat grafik. Hari yang nggak ada penjualan tetap muncul dengan
angka nol, jadi grafiknya nggak bolong.
```json
{ "data": [{ "date": "2026-07-13", "transactions": 6, "revenue": 129800 }], "meta": { "...": "..." } }
```

### GET `/v1/reports/top-products?from&to&limit`
Produk terlaris, diurutkan dari revenue terbesar. `limit` default 10, maks 100.
```json
{ "data": [{ "productId": "p_kopi", "sku": "BVG-001", "name": "Kopi Susu", "quantitySold": 7, "revenue": 126000 }] }
```

### GET `/v1/reports/payment-methods?from&to`
Rincian metode bayar (cash/card/qris): jumlah pembayaran + totalnya.
```json
{ "data": [{ "method": "cash", "payments": 11, "amount": 395000 }] }
```

### GET `/v1/reports/low-stock?threshold&limit`
Produk yang stoknya udah di bawah/sama dengan `threshold` (default 10) —
buat alert restock. Nggak pakai rentang tanggal.
```json
{ "data": [{ "id": "p_teh", "sku": "BVG-002", "name": "Teh Manis", "stock": 0 }], "meta": { "threshold": 10, "count": 1 } }
```

### GET `/v1/reports/transactions?limit&offset&from&to&cashierId&receipt`
Log transaksi lengkap buat tabel di dashboard, urut dari yang terbaru.
Pakai pagination offset (`limit` default 25, maks 100; `offset` default 0).
`meta.total` + `meta.hasMore` dipakai buat ngambil semua halaman.

Filter (semuanya opsional, boleh digabung — beda sama report lain, log ini
**nggak** punya default rentang tanggal, tanpa filter artinya sepanjang masa):
- `from` / `to`: tanggal inklusif `YYYY-MM-DD` (hari versi Asia/Jakarta).
- `cashierId`: UUID kasir (ambil daftarnya dari `/v1/reports/cashiers`).
- `receipt`: potongan nomor struk, case-insensitive (misal `MRNS`).

`meta.total` selalu ngikutin hasil yang udah difilter — jadi pagination di
frontend tetap bener.
```json
{
  "data": [{
    "id": "…", "receiptNo": "RCP-…", "cashierName": "Admin Toko",
    "grandTotal": 20000, "itemCount": 1, "methods": ["cash"],
    "createdAt": "2026-07-15T16:51:37.545Z"
  }],
  "meta": { "total": 42, "limit": 25, "offset": 0, "hasMore": true }
}
```
Catatan: `methods` bisa berisi `cash`/`card`/`qris` ataupun `midtrans`/`xendit`
(buat penjualan yang dibayar lewat gateway).

| Error | Kapan munculnya |
|-------|-----------------|
| 400 | format tanggal salah, `from` > `to`, atau `cashierId` bukan UUID |

### GET `/v1/reports/cashiers`
Semua user yang pernah nyatet minimal satu transaksi — buat isi dropdown
filter kasir di dashboard.
```json
{ "data": [{ "id": "uuid", "fullName": "Anya Putri" }], "meta": { "count": 1 } }
```

### GET `/v1/reports/recent-transactions?limit`
Transaksi terbaru buat feed aktivitas di dashboard. `limit` default 10, maks 50.
```json
{ "data": [{ "id": "…", "receiptNo": "RCP-…", "cashierId": "…", "grandTotal": 3900, "itemCount": 1, "createdAt": "2026-07-13T12:49:35.659Z" }] }
```

| Error | Kapan munculnya |
|-------|-----------------|
| 400 | format tanggal salah, `from` > `to`, atau rentangnya lebih dari 366 hari |
| 403 | role-nya nggak punya izin reports:read (contoh: kasir) |

---

## 9. Endpoint Users — PIN kasir

Buat layar "pilih kasir" di POS: tiap kasir punya PIN pendek buat gonta-ganti
user cepat di satu perangkat. PIN-nya di-hash pakai bcrypt (sama kayak
password) — nggak pernah disimpen atau dibalikin dalam bentuk asli.

### POST `/v1/users`  🔒 butuh `users:manage` (cuma admin)

Admin bikin akun staf baru dari layar Staff — beda sama `/v1/auth/register`:
bisa pilih role, bisa langsung set PIN, dan **nggak** nge-set sesi/cookie baru
(admin tetap login sebagai dirinya).

```json
{
  "email": "anya@ratio.test",
  "fullName": "Anya Putri",
  "password": "AnyaRatio1!",
  "role": "cashier",
  "pin": "1234"
}
```

- `role`: `cashier` (default) atau `admin`. `pin` (opsional): 4–6 digit.
- Balikannya `201` + header `Location`:
```json
{ "data": { "id": "uuid", "email": "anya@ratio.test", "fullName": "Anya Putri", "role": "cashier", "hasPin": true, "createdAt": "…" } }
```

| Error | Kapan munculnya |
|-------|-----------------|
| 400 | email ngaco / password < 8 huruf / PIN bukan 4–6 digit |
| 403 | bukan admin (nggak punya users:manage) |
| 409 | email udah kedaftar |

### GET `/v1/users?limit&offset`  🔒 butuh `users:manage` (cuma admin)

Semua akun, buat layar manajemen staf. Hash password/PIN nggak pernah ikut.
Paginasi offset: `limit` (default 20, maks 100) + `offset`.

```json
{
  "data": [{ "id": "uuid", "email": "anya@ratio.test", "fullName": "Anya Putri", "role": "cashier", "hasPin": true, "createdAt": "…" }],
  "meta": { "total": 9, "limit": 20, "offset": 0, "hasMore": false }
}
```

### PUT `/v1/users/{id}/pin`  🔒 butuh `users:manage` (cuma admin)

```json
{ "pin": "123456" }
```

- `pin`: 4–6 digit angka. Ngirim lagi = ganti PIN lama (replace).
- Balikannya `204` (kosong). `404` kalau user id-nya nggak ada, `403` kalau
  bukan admin.
- Catatan: permission `users:manage` baru masuk ke token pas **login ulang**
  setelah `bun run src/migrate.ts` (permissions kebawa di dalam JWT).

### GET `/v1/users/with-pin?limit&offset` — publik (tanpa token)

Semua user yang udah punya PIN — datanya buat layar pemilihan kasir (lock
screen), yang memang tampil **sebelum** ada yang login. Karena publik,
balikannya sengaja minim: cuma nama + role, **tanpa email**. Paginasi offset:
`limit` (default 100, maks 100) + `offset`.

```json
{
  "data": [
    { "id": "uuid", "fullName": "Kasir Satu", "role": "cashier" }
  ],
  "meta": { "total": 3, "limit": 100, "offset": 0, "hasMore": false }
}
```

PIN-nya sendiri **nggak pernah** ikut kebalikin — verifikasi PIN dilakukan
server-side (hash compare), bukan di client.

### POST `/v1/auth/pin-login` — tanpa token (ini pintu masuknya)

Login cepat buat layar ganti kasir: pilih user dari `/v1/users/with-pin`,
ketik PIN, dapet sesi lengkap (accessToken + refresh cookie) — persis kayak
login email/password.

```json
{ "userId": "uuid-dari-with-pin", "pin": "123456" }
```

- Balikannya sama kayak `POST /v1/auth/login` (`data.user` + `data.accessToken`,
  refresh token kepasang di cookie httpOnly).
- `401` kalau PIN salah / user-nya nggak punya PIN (pesannya sengaja disamain
  biar nggak bocor yang mana yang salah). `400` kalau `userId` bukan UUID.
- Kena rate limit auth yang sama: **5 request/menit per IP** — nebak-nebak PIN
  6 digit bakal kena 429 duluan.

Alur lengkap layar kasir: `GET /v1/users/with-pin` (pakai token perangkat) →
user milih namanya → `POST /v1/auth/pin-login` → token baru buat kasir itu.

---

## 10. Catatan keamanan & desain (biar kebayang alasannya)

- **Anti oversell**: pas checkout, stok dikunci pakai `SELECT ... FOR UPDATE` di
  dalam satu transaksi DB. Jadi kalau dua kasir rebutan stok terakhir bareng,
  cuma satu yang lolos — nggak bakal jadi minus.
- **All-or-nothing**: satu checkout dibungkus satu transaksi (BEGIN/COMMIT/
  ROLLBACK). Kalau gagal di tengah jalan, semuanya dibatalin — nggak ada stok
  kepotong tapi transaksinya nggak kesimpen.
- **Anti charge dobel**: pakai `Idempotency-Key` + UNIQUE constraint di DB.
- **Password**: di-hash pakai bcrypt cost 12. **Refresh token**: disimpen dalam
  bentuk hash (SHA-256), bukan token aslinya.
- **Header keamanan** nyala di semua response; **CORS** pakai daftar izin (bukan
  bintang `*`); semua query SQL **parameterized** (anti SQL injection); dan
  konfigurasi `.env` dicek dulu pakai Zod pas server nyala — kalau ada yang
  salah, server langsung berhenti biar ketauan dari awal.
