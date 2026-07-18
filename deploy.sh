#!/bin/bash
set -e

# La version = hash court du dernier commit git
export BUILD_VERSION=$(git rev-parse --short HEAD 2>/dev/null || date +"%y.%m%d.%H%M")
echo "→ Deploy $BUILD_VERSION"

# ── Docker ───────────────────────────────────────────────────────────────────
docker compose build --no-cache
BUILD_VERSION=$BUILD_VERSION docker compose up -d
echo "✓ Déployé en $BUILD_VERSION"
