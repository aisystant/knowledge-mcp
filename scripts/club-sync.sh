#!/usr/bin/env bash
# Club sync v2 — экспорт новых постов + индексация в knowledge-mcp
#
# Usage:
#   ./club-sync.sh [username]
#
# Default username: tseren-tserenov
# Schedule: crontab -e -> 0 */6 * * * cd /Users/tserentserenov/IWE/DS-MCP/knowledge-mcp && ./scripts/club-sync.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IWE_DIR="$(cd "$REPO_DIR/../.." && pwd)"

USERNAME="${1:-tseren-tserenov}"
EXPORT_DIR="$REPO_DIR/staging/club-export"
CURSOR_FILE="$REPO_DIR/staging/.club-cursor"

# P1 fix: trap для .dev.vars
RESTORE_DEVVARS=0
_cleanup_devvars() {
  if [ "$RESTORE_DEVVARS" -eq 1 ] && [ -f "$REPO_DIR/.dev.vars.tmp" ]; then
    mv "$REPO_DIR/.dev.vars.tmp" "$REPO_DIR/.dev.vars"
  fi
}
trap _cleanup_devvars EXIT

echo "=== Club Sync v2 ==="
echo "Username: $USERNAME"
echo "Export dir: $EXPORT_DIR"
echo "Cursor: $CURSOR_FILE"
echo ""

# 1. Export posts from club
echo "[1/3] Exporting club posts..."
mkdir -p "$EXPORT_DIR"

DISCOURSE_API_KEY=""
if [ -f "$HOME/.secrets/club_api_token" ]; then
  DISCOURSE_API_KEY=$(cat "$HOME/.secrets/club_api_token" | head -1 | tr -d '[:space:]')
fi

if [ -z "$DISCOURSE_API_KEY" ]; then
  echo "ERROR: DISCOURSE_API_KEY not found in ~/.secrets/club_api_token"
  exit 1
fi

export DISCOURSE_API_KEY
python3 "$SCRIPT_DIR/club-etl.py" --username "$USERNAME" --output "$EXPORT_DIR" --cursor-file "$CURSOR_FILE"

# 2. Index into knowledge-mcp
echo ""
echo "[2/3] Indexing into knowledge-mcp..."
cd "$REPO_DIR"

DATABASE_URL=""
if [ -f "$HOME/.secrets/neon" ]; then
  NEON_BASE=$(grep "NEON_PROD_BASE=" "$HOME/.secrets/neon" | head -1 | sed 's/.*=//' | tr -d '"')
  if [ -n "$NEON_BASE" ]; then
    DATABASE_URL="${NEON_BASE}/knowledge?sslmode=require"
  fi
fi

if [ -z "$DATABASE_URL" ]; then
  echo "ERROR: Could not resolve DATABASE_URL from ~/.secrets/neon"
  exit 1
fi

OPENAI_API_KEY=""
if [ -f "$REPO_DIR/.dev.vars" ]; then
  OPENAI_API_KEY=$(grep "OPENAI_API_KEY=" "$REPO_DIR/.dev.vars" | head -1 | sed 's/OPENAI_API_KEY=//' | tr -d '"' | tr -d "'")
fi

if [ -z "$OPENAI_API_KEY" ]; then
  echo "ERROR: Could not resolve OPENAI_API_KEY from .dev.vars"
  exit 1
fi

# Move .dev.vars temporarily (P1 fix with trap)
if [ -f "$REPO_DIR/.dev.vars" ]; then
  mv "$REPO_DIR/.dev.vars" "$REPO_DIR/.dev.vars.tmp"
  RESTORE_DEVVARS=1
fi

export DATABASE_URL
export OPENAI_API_KEY

npx tsx scripts/ingest.ts   --source "club-${USERNAME}"   --type content   --path "$EXPORT_DIR"

echo ""
echo "[3/3] Done. $(date -Iseconds)"
