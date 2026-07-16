#!/bin/bash
set -e

export BUILD_VERSION=$(date +"%y.%m%d.%H%M")
echo "→ Build $BUILD_VERSION"

# ── Description des changements ─────────────────────────────────────────────
DESCRIPTION="${1:-}"

if [ -z "$DESCRIPTION" ]; then
  echo ""
  echo "Qu'est-ce qui a changé dans ce build ? (entrée pour passer)"
  read -r DESCRIPTION
fi

if [ -z "$DESCRIPTION" ]; then
  DESCRIPTION="Mise à jour $BUILD_VERSION"
fi

# ── Mise à jour du CHANGELOG ─────────────────────────────────────────────────
DATE_LABEL=$(date +"%d/%m/%Y à %H:%M")
# Insère l'entrée après la ligne "---"
TMPFILE=$(mktemp)
awk -v version="v$BUILD_VERSION" -v date="$DATE_LABEL" -v desc="$DESCRIPTION" '
  /^---$/ && !done {
    print
    print ""
    print "## " version " — " date
    print ""
    print desc
    print ""
    done=1
    next
  }
  { print }
' CHANGELOG.md > "$TMPFILE" && mv "$TMPFILE" CHANGELOG.md

echo "✓ CHANGELOG mis à jour"

# ── Git : commit + push ───────────────────────────────────────────────────────
if git remote get-url origin &>/dev/null; then
  git add -A
  git commit -m "deploy: v$BUILD_VERSION — $DESCRIPTION" 2>/dev/null || true
  git push origin main 2>/dev/null && echo "✓ Pushé sur GitHub" || echo "⚠ Push GitHub échoué (continuer quand même)"
fi

# ── Docker ───────────────────────────────────────────────────────────────────
docker compose build --no-cache
BUILD_VERSION=$BUILD_VERSION docker compose up -d
echo "✓ Déployé en v$BUILD_VERSION"

# ── Notification Discord ──────────────────────────────────────────────────────
[ -f .env ] && export $(grep -v '^#' .env | grep DISCORD_DEPLOY_WEBHOOK | xargs)

if [ -n "$DISCORD_DEPLOY_WEBHOOK" ]; then
  DATE_LABEL=$(date +"%d/%m/%Y à %H:%M")
  PAYLOAD=$(printf '{"embeds":[{"title":"🚀 Nouveau déploiement — v%s","description":"%s","color":3066993,"footer":{"text":"%s"}}]}' \
    "$BUILD_VERSION" \
    "$(echo "$DESCRIPTION" | sed 's/"/\\"/g')" \
    "$DATE_LABEL")
  curl -s -X POST "$DISCORD_DEPLOY_WEBHOOK" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" > /dev/null && echo "✓ Notifié sur Discord" || echo "⚠ Notification Discord échouée"
fi
