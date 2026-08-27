#!/usr/bin/env bash
# One-time install of the planes WhatsApp bot on the Losali VPS.
# Run as the `ubuntu` user. Idempotent — safe to re-run.
set -euo pipefail

REPO_URL="${PLANES_REPO_URL:-https://github.com/micheldebeuk/karoli.git}"
APP_DIR="${PLANES_DIR:-/home/ubuntu/plans}"
BRANCH="${PLANES_BRANCH:-main}"

log() { printf '[install] %s\n' "$*"; }

if [ ! -d "$APP_DIR/.git" ]; then
  log "cloning $REPO_URL -> $APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  log "updating existing checkout at $APP_DIR"
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
fi

cd "$APP_DIR"
mkdir -p logs data
chmod 700 data

log "installing dependencies"
if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  log ".env created from .env.example — EDIT IT before starting:"
  log "    nano $APP_DIR/.env"
  log "Then link WhatsApp:  cd $APP_DIR && npm run login -- --pair +34XXXXXXXXX"
  log "Then start:          pm2 start ecosystem.config.js && pm2 save"
  exit 0
fi

log "syntax check"
node scripts/check-syntax.js

if ! node -e "process.exit(require('node:fs').existsSync(require('node:path').join(process.env.WHATSAPP_SESSION_DIR || './data/wa-session','creds.json'))?0:1)" 2>/dev/null; then
  log "no WhatsApp session yet — link this device first:"
  log "    cd $APP_DIR && npm run login -- --pair +34XXXXXXXXX"
  exit 0
fi

log "(re)starting under pm2"
pm2 startOrReload ecosystem.config.js
pm2 save
pm2 status
log "done"
