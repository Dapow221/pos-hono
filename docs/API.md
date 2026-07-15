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
```

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

### GET `/v1/products`  🔒 butuh `products:read`
Query opsional: `limit` (default 100, maksimal 100).

Balikannya `200`:
```json
{
  "data": [{ "id": "p_kopi", "sku": "BVG-001", "name": "Kopi Susu", "price": 18000, "stock": 50 }],
  "meta": { "count": 1, "hasMore": false }
}
```

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

## 7. Catatan keamanan & desain (biar kebayang alasannya)

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
