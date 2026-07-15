#!/usr/bin/env bash
#
# One-shot VPS setup for pos-hono (bare metal: Bun + PostgreSQL + systemd).
# Target: Ubuntu 22.04/24.04 (Debian works the same). Run as root (sudo).
#
# Prerequisite: the app code is already at /opt/pos-hono (see deploy/README.md
# for the rsync command). Idempotent — safe to re-run after code updates.
set -euo pipefail

APP_DIR=/opt/pos-hono
APP_USER=pos
# Home for the pos user: bun's install cache lands here, not in the app tree.
VAR_DIR=/var/lib/pos-hono
DB_NAME=pos_hono
DB_USER=pos
PORT="${PORT:-3000}"
# Whoever invoked sudo owns the sources, so plain rsync deploys keep working.
DEPLOY_USER="${SUDO_USER:-root}"

if [[ $EUID -ne 0 ]]; then
  echo "Run this with sudo: sudo bash deploy/setup-vps.sh" >&2
  exit 1
fi
if [[ ! -f "$APP_DIR/package.json" ]]; then
  echo "App code not found at $APP_DIR — rsync it there first (see deploy/README.md)." >&2
  exit 1
fi

echo "==> Installing system packages (PostgreSQL, curl, unzip)"
apt-get update -qq
apt-get install -y -qq postgresql curl unzip ca-certificates gnupg lsb-release
systemctl enable --now postgresql

echo "==> Installing Redis (official repo — distro Redis 5 is too old for Bun's client)"
if ! command -v redis-server >/dev/null; then
  curl -fsSL https://packages.redis.io/gpg | gpg --dearmor -o /usr/share/keyrings/redis-archive-keyring.gpg
  chmod 644 /usr/share/keyrings/redis-archive-keyring.gpg
  echo "deb [signed-by=/usr/share/keyrings/redis-archive-keyring.gpg] https://packages.redis.io/deb $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/redis.list
  apt-get update -qq
  apt-get install -y -qq redis
fi
systemctl enable --now redis-server

echo "==> Installing Bun (system-wide) if missing"
if ! command -v /usr/local/bin/bun >/dev/null; then
  curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
fi
/usr/local/bin/bun --version

echo "==> Creating app user '$APP_USER' if missing"
id -u "$APP_USER" &>/dev/null || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"

echo "==> Setting up PostgreSQL role + database"
DB_PASS=$(openssl rand -hex 16)
if sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
  echo "    role '$DB_USER' already exists — keeping its existing password"
  DB_PASS="" # existing .env already holds the working DATABASE_URL
else
  sudo -u postgres psql -c "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'"
fi
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
  || sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
# gen_random_uuid() is built in from PG13; on older versions it comes from pgcrypto.
sudo -u postgres psql -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS pgcrypto"

echo "==> Writing $APP_DIR/.env (kept if it already exists)"
if [[ ! -f "$APP_DIR/.env" ]]; then
  if [[ -z "$DB_PASS" ]]; then
    echo "ERROR: role '$DB_USER' exists but $APP_DIR/.env does not — I don't know the DB password." >&2
    echo "Reset it (sudo -u postgres psql -c \"ALTER ROLE $DB_USER PASSWORD '...'\") and write .env manually." >&2
    exit 1
  fi
  cat > "$APP_DIR/.env" <<EOF
PORT=$PORT
NODE_ENV=production
DATABASE_URL=postgres://$DB_USER:$DB_PASS@localhost:5432/$DB_NAME
REDIS_URL=redis://localhost:6379
JWT_SECRET=$(openssl rand -hex 32)
ACCESS_TOKEN_TTL_MIN=15
REFRESH_TOKEN_TTL_DAYS=30
# Plain HTTP (IP-only) for now — flip to true once you serve HTTPS behind a domain.
COOKIE_SECURE=false
# Set this to your frontend's origin(s), comma-separated.
CORS_ORIGINS=http://localhost:3000
EOF
fi
echo "==> Fixing ownership (sources: $DEPLOY_USER, runtime dirs: $APP_USER)"
mkdir -p "$VAR_DIR"
chown -R "$APP_USER:$APP_USER" "$VAR_DIR"
rm -rf "$APP_DIR/.bun" # bun cache from older script versions; now lives in VAR_DIR
chown -R "$DEPLOY_USER" "$APP_DIR"
chown "root:$APP_USER" "$APP_DIR/.env"
chmod 640 "$APP_DIR/.env" # readable by the service user, not by others
mkdir -p "$APP_DIR/node_modules"
chown -R "$APP_USER:$APP_USER" "$APP_DIR/node_modules"

echo "==> Installing dependencies"
sudo -u "$APP_USER" HOME="$VAR_DIR" /usr/local/bin/bun install --frozen-lockfile --production --cwd "$APP_DIR"

echo "==> Running migration + seed (idempotent)"
(cd "$APP_DIR" && sudo -u "$APP_USER" HOME="$VAR_DIR" /usr/local/bin/bun run src/migrate.ts)

echo "==> Installing systemd service"
cp "$APP_DIR/deploy/pos-hono.service" /etc/systemd/system/pos-hono.service
systemctl daemon-reload
systemctl enable --now pos-hono
systemctl restart pos-hono

sleep 1
systemctl --no-pager --lines=5 status pos-hono || true
echo
echo "Done. Check it:  curl http://localhost:$PORT/health"
echo "Open the firewall if needed:  ufw allow $PORT/tcp"
echo "IMPORTANT: change the seeded demo passwords (admin@pos.test / kasir@pos.test) before real use."
