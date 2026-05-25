#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────────────────────────────────
# KiroGraph Release Script
#
# Usage:
#   ./scripts/release.sh
#
# Reads version from package.json (single source of truth).
#
# What it does:
#   1. Reads version from package.json
#   2. Extracts release notes from CHANGELOG.md for that version
#   3. Runs the build
#   4. Creates a git tag (v<version>) if it doesn't exist
#   5. Pushes the tag to origin
#   6. Creates a GitHub release with the changelog notes (requires `gh` CLI)
#   7. Publishes to npm (requires `npm` login)
#
# Prerequisites:
#   - gh CLI installed and authenticated (https://cli.github.com)
#   - npm login done (`npm whoami` should return your username)
#   - Clean working tree (no uncommitted changes)
#   - All changes committed and pushed to main
# ─────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[2m'
RESET='\033[0m'

info()  { echo -e "${GREEN}✓${RESET} $1"; }
warn()  { echo -e "${YELLOW}⚠${RESET} $1"; }
error() { echo -e "${RED}✗${RESET} $1" >&2; exit 1; }
step()  { echo -e "\n${GREEN}▸${RESET} $1"; }

# ── Resolve project root ─────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# ── Get version ──────────────────────────────────────────────────────────────
VERSION=$(node -p "require('./package.json').version")

TAG="v${VERSION}"

echo ""
echo -e "  ${GREEN}KiroGraph Release${RESET} ${DIM}${TAG}${RESET}"
echo ""

# ── Preflight checks ────────────────────────────────────────────────────────
step "Preflight checks"

# Check gh CLI
if ! command -v gh &> /dev/null; then
  error "gh CLI not found. Install from https://cli.github.com"
fi

# Check npm auth
if ! npm whoami &> /dev/null 2>&1; then
  warn "npm not authenticated. Publish step will be skipped."
  NPM_SKIP=true
else
  NPM_SKIP=false
  info "npm authenticated as $(npm whoami)"
fi

# Check clean working tree
if [ -n "$(git status --porcelain)" ]; then
  error "Working tree is not clean. Commit or stash changes first."
fi

# Check we're on main
BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
  warn "Not on main branch (currently on '$BRANCH'). Proceed? [y/N]"
  read -r CONFIRM
  if [ "$CONFIRM" != "y" ] && [ "$CONFIRM" != "Y" ]; then
    exit 0
  fi
fi

# Check tag doesn't already exist
TAG_EXISTS=false
if git rev-parse "$TAG" &> /dev/null 2>&1; then
  warn "Tag $TAG already exists locally — skipping tag creation"
  TAG_EXISTS=true
fi

info "All preflight checks passed"

# ── Extract changelog ────────────────────────────────────────────────────────
step "Extracting release notes from CHANGELOG.md"

# Extract everything between ## [version] and the next ## [
NOTES=$(awk -v ver="$VERSION" '
  /^## \[/ {
    if (found) exit
    if (index($0, "[" ver "]")) { found=1; next }
  }
  found { print }
' CHANGELOG.md)

if [ -z "$NOTES" ]; then
  warn "No changelog entry found for version $VERSION"
  NOTES="Release $VERSION"
else
  # Trim leading blank lines, then trailing blank lines (POSIX-compatible)
  NOTES=$(echo "$NOTES" | awk 'NF{found=1} found' | awk '{lines[NR]=$0} END{for(i=NR;i>=1;i--){if(lines[i]!=""){last=i;break}} for(i=1;i<=last;i++) print lines[i]}')
  LINES=$(echo "$NOTES" | wc -l | tr -d ' ')
  info "Found release notes ($LINES lines)"
fi

# ── Build ────────────────────────────────────────────────────────────────────
step "Building"

npm run build
info "Build complete"

# ── Create and push tag ──────────────────────────────────────────────────────
if [ "$TAG_EXISTS" = true ]; then
  info "Tag $TAG already exists — skipping creation"
else
  step "Creating tag $TAG"
  git tag -a "$TAG" -m "Release $VERSION"
  info "Tag $TAG created"
fi

step "Pushing tag to origin"

if git ls-remote --tags origin | grep -q "refs/tags/$TAG$"; then
  info "Tag $TAG already exists on remote — skipping push"
else
  git push origin "$TAG"
  info "Tag pushed"
fi

# ── Create GitHub release ────────────────────────────────────────────────────
step "Creating GitHub release"

echo "$NOTES" | gh release create "$TAG" \
  --title "$TAG" \
  --notes-file - \
  --latest

info "GitHub release created: $TAG"

# ── Publish to npm ───────────────────────────────────────────────────────────
if [ "$NPM_SKIP" = true ]; then
  warn "Skipping npm publish (not authenticated)"
else
  step "Publishing to npm"

  echo -e "  ${DIM}Package: kirograph@${VERSION}${RESET}"
  echo -e "  ${YELLOW}Publish to npm? [y/N]${RESET}"
  read -r CONFIRM
  if [ "$CONFIRM" = "y" ] || [ "$CONFIRM" = "Y" ]; then
    npm publish --access public
    info "Published kirograph@${VERSION} to npm"
  else
    warn "npm publish skipped"
  fi
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo -e "  ${GREEN}✓ Release $TAG complete${RESET}"
echo ""
