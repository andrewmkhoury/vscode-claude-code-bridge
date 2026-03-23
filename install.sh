#!/usr/bin/env bash
# Claude Code Workspace Bridge — one-command installer for macOS and Linux
set -euo pipefail

REPO="andrewmkhoury/vscode-claude-code-bridge"
BLUE='\033[0;34m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

info()    { echo -e "${BLUE}[Claude Code Workspace]${NC} $*"; }
success() { echo -e "${GREEN}[Claude Code Workspace]${NC} $*"; }
warn()    { echo -e "${YELLOW}[Claude Code Workspace]${NC} $*"; }
die()     { echo -e "${RED}[Claude Code Workspace] ERROR:${NC} $*" >&2; exit 1; }

# ── Detect editor command ─────────────────────────────────────────────────────
EDITOR_CMD=""
if command -v code &>/dev/null; then
  EDITOR_CMD="code"
elif command -v cursor &>/dev/null; then
  EDITOR_CMD="cursor"
elif [ -f "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then
  EDITOR_CMD="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"
elif [ -f "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" ]; then
  EDITOR_CMD="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
else
  die "Neither 'code' nor 'cursor' found. Open VS Code/Cursor, then run:\n  Extensions: install from VSIX → choose the downloaded .vsix file"
fi

# ── Fetch latest release ──────────────────────────────────────────────────────
info "Fetching latest release from github.com/${REPO}…"

if command -v curl &>/dev/null; then
  FETCH="curl -fsSL"
elif command -v wget &>/dev/null; then
  FETCH="wget -qO-"
else
  die "curl or wget is required"
fi

LATEST=$($FETCH "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name"' | head -1 | sed 's/.*"tag_name": *"\(.*\)".*/\1/')
[ -z "$LATEST" ] && die "Could not determine latest release version"

VERSION="${LATEST#v}"
VSIX_URL="https://github.com/${REPO}/releases/download/${LATEST}/claude-code-workspace-${VERSION}.vsix"

# ── Download ──────────────────────────────────────────────────────────────────
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

info "Downloading claude-code-workspace-${VERSION}.vsix…"
$FETCH "$VSIX_URL" > "$TMPDIR/extension.vsix" || die "Download failed. Check https://github.com/${REPO}/releases for available versions."

# ── Install ───────────────────────────────────────────────────────────────────
info "Installing extension via: ${EDITOR_CMD}"
"$EDITOR_CMD" --install-extension "$TMPDIR/extension.vsix" --force

echo ""
success "Installed claude-code-workspace ${VERSION}!"
echo ""
echo "  Next steps:"
echo "  1. Restart VS Code / Cursor"
echo "  2. Click 'Set Up' in the prompt that appears — this configures Claude Code automatically"
echo "  3. Restart Claude Code"
echo ""
echo "  Or run manually from the Command Palette:"
echo "    > Claude Code Workspace: Configure Claude Code"
