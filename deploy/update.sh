#!/usr/bin/env bash
# Pull the latest main and restart. Intended for a per-minute cron on the VPS,
# the same shape as losali's proxy/deploy.sh: do nothing when already current,
# never restart into code that does not parse.
set -euo pipefail

APP_DIR="${PLANES_DIR:-/home/ubuntu/plans}"
BRANCH="${PLANES_BRANCH:-main}"
cd "$APP_DIR"

log() { printf '%s [update] %s\n' "$(date -Is)" "$*"; }

if ! git fetch --quiet origin "$BRANCH"; then
  log "git fetch failed — leaving the running version alone"
  exit 0
fi

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
[ "$LOCAL" = "$REMOTE" ] && exit 0

log "updating $LOCAL -> $REMOTE"
git reset --hard "origin/$BRANCH"

if ! git diff --quiet "$LOCAL" "$REMOTE" -- package-lock.json package.json; then
  log "manifest changed — npm ci"
  npm ci --omit=dev
fi

# Refuse to restart into a broken tree; the old process keeps serving.
if ! node scripts/check-syntax.js >/dev/null; then
  log "SYNTAX CHECK FAILED at $REMOTE — not restarting"
  exit 1
fi

pm2 startOrReload ecosystem.config.js
log "restarted at $(git rev-parse --short HEAD)"
