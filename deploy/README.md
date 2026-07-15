# Deploying pos-hono to a VPS (bare metal: Bun + PostgreSQL + systemd)

Target: Ubuntu 22.04/24.04 VPS, serving plain HTTP on an IP (no domain yet).

## 1. Create the app directory on the VPS

```sh
ssh <user>@<VPS_IP> 'sudo mkdir -p /opt/pos-hono && sudo chown $USER /opt/pos-hono'
```

## 2. Copy the code from your machine

From the project root on your laptop:

```sh
rsync -av --exclude node_modules --exclude .env --exclude .git \
  ./ <user>@<VPS_IP>:/opt/pos-hono/
```

## 3. Run the setup script on the VPS

```sh
ssh <user>@<VPS_IP>
sudo bash /opt/pos-hono/deploy/setup-vps.sh
```

The script is idempotent. It:

- installs PostgreSQL and Bun (system-wide, `/usr/local/bin/bun`)
- creates a `pos` system user, a `pos` DB role (random password) and the `pos_hono` database
- writes `/opt/pos-hono/.env` with a generated 64-char `JWT_SECRET` (kept if it already exists)
- runs `bun install` and the idempotent migration/seed (`src/migrate.ts`)
- installs and starts the `pos-hono` systemd service

## 4. Open the port and verify

```sh
sudo ufw allow 3000/tcp        # skip if you don't use ufw
curl http://<VPS_IP>:3000/health   # → {"status":"ok"}
```

## 5. After it's up — do these

- **Change the seeded demo passwords** (`admin@pos.test` / `Admin123!`, `kasir@pos.test` / `Kasir123!`).
- **Set `CORS_ORIGINS`** in `/opt/pos-hono/.env` to your real frontend origin, then `sudo systemctl restart pos-hono`.
- **Add a domain + HTTPS before production.** On plain HTTP the refresh-token cookie runs with `COOKIE_SECURE=false`, which is not safe on the open internet. When you get a domain: point DNS at the VPS, put Caddy or nginx in front with TLS, set `COOKIE_SECURE=true`, and restart.

## Day-2 operations

```sh
sudo systemctl status pos-hono          # is it running
sudo journalctl -u pos-hono -f          # live logs
sudo systemctl restart pos-hono         # after config changes
```

**Deploying an update:** rerun step 2 (rsync), then on the VPS:

```sh
sudo bash /opt/pos-hono/deploy/setup-vps.sh   # reinstalls deps, re-migrates, restarts
```
