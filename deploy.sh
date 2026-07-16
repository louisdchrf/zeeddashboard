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
CHANGELOG_ENTRY="## v$BUILD_VERSION — $DATE_LABEL

$DESCRIPTION"

# Insère l'entrée après la ligne "---"
TMPFILE=$(mktemp)
awk -v entry="$CHANGELOG_ENTRY" '
  /^---$/ && !done {
    print
    print ""
    print entry
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
