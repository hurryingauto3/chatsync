#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# ChatSync — Publish to VS Code Marketplace & Open VSX
# ─────────────────────────────────────────────────
#
# Usage:
#   ./scripts/publish.sh                 # publish current version
#   ./scripts/publish.sh --dry-run       # package only, don't publish
#
# Required environment variables:
#   VSCE_PAT   — VS Code Marketplace Personal Access Token
#   OVSX_PAT   — Open VSX Registry Access Token
#
# Get your tokens:
#   VS Code:  https://dev.azure.com → User Settings → Personal Access Tokens
#   Open VSX: https://open-vsx.org/user-settings/tokens
# ─────────────────────────────────────────────────

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}ℹ${NC}  $1"; }
ok()    { echo -e "${GREEN}✅${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠️${NC}  $1"; }
fail()  { echo -e "${RED}❌${NC} $1"; exit 1; }

# ── Pre-flight checks ──
cd "$(dirname "$0")/.."
ROOT=$(pwd)

VERSION=$(node -p "require('./package.json').version")
PUBLISHER=$(node -p "require('./package.json').publisher")
NAME=$(node -p "require('./package.json').name")
VSIX="${NAME}-${VERSION}.vsix"

info "Publishing ${NAME}@${VERSION} (publisher: ${PUBLISHER})"

if [[ "$DRY_RUN" == false ]]; then
  [[ -z "${VSCE_PAT:-}" ]] && fail "VSCE_PAT is not set. Export your VS Code Marketplace token."
  [[ -z "${OVSX_PAT:-}" ]] && fail "OVSX_PAT is not set. Export your Open VSX token."
fi

# ── Step 1: Build ──
info "Building extension..."
npm run build
ok "Build complete"

# ── Step 2: Package ──
info "Packaging ${VSIX}..."
npx -y @vscode/vsce package --no-dependencies
if [[ ! -f "$VSIX" ]]; then
  fail "Expected ${VSIX} but file not found"
fi
ok "Packaged: ${VSIX} ($(du -h "$VSIX" | cut -f1 | xargs))"

if [[ "$DRY_RUN" == true ]]; then
  warn "Dry run — skipping publish"
  exit 0
fi

# ── Step 3: Publish to VS Code Marketplace ──
info "Publishing to VS Code Marketplace..."
if npx -y @vscode/vsce publish -p "$VSCE_PAT" --no-dependencies 2>&1; then
  ok "Published to VS Code Marketplace"
else
  warn "VS Code Marketplace publish failed (continuing...)"
fi

# ── Step 4: Publish to Open VSX ──
info "Publishing to Open VSX Registry..."
if npx -y ovsx publish "$VSIX" -p "$OVSX_PAT" 2>&1; then
  ok "Published to Open VSX"
else
  warn "Open VSX publish failed (continuing...)"
fi

# ── Done ──
echo ""
ok "🎉 ${NAME}@${VERSION} published!"
echo ""
echo "  VS Code:  https://marketplace.visualstudio.com/items?itemName=${PUBLISHER}.${NAME}"
echo "  Open VSX: https://open-vsx.org/extension/${PUBLISHER}/${NAME}"
echo ""
