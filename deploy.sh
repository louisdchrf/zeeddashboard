#!/bin/bash
set -e

# La version = hash court du dernier commit git
export BUILD_VERSION=$(git rev-parse --short HEAD 2>/dev/null || date +"%y.%m%d.%H%M")
echo "→ Deploy $BUILD_VERSION"

# ── Docker ───────────────────────────────────────────────────────────────────
docker compose build --no-cache
BUILD_VERSION=$BUILD_VERSION docker compose up -d
echo "✓ Déployé en $BUILD_VERSION"

# ── Notification Discord ──────────────────────────────────────────────────────
[ -f .env ] && export $(grep -v '^#' .env | grep DISCORD_DEPLOY_WEBHOOK | xargs)

if [ -n "$DISCORD_DEPLOY_WEBHOOK" ]; then
  DATE_LABEL=$(date +"%d/%m/%Y à %H:%M")
  COMMIT_MSG=$(git log -1 --pretty=format:"%s" 2>/dev/null || echo "—")
  PAYLOAD=$(printf '{"embeds":[{"title":"🚀 Deploy %s","description":"%s","color":7340543,"footer":{"text":"%s"}}]}' \
    "$BUILD_VERSION" \
    "$(echo "$COMMIT_MSG" | sed 's/"/\\"/g')" \
    "$DATE_LABEL")
  curl -s -X POST "$DISCORD_DEPLOY_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" > /dev/null && echo "✓ Notifié sur Discord" || echo "⚠ Notification Discord échouée"
fi
