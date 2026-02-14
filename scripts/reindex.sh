#!/bin/bash
# reindex.sh — еженедельная переиндексация knowledge-mcp
#
# Запускается scheduler.sh (Пт 19:00).
# Читает sources.json, вызывает ingest.ts, отправляет отчёт через notify.sh.
#
# Использование:
#   reindex.sh           — полная переиндексация из sources.json
#   reindex.sh --dry-run — только показать что будет (без индексации)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$HOME/logs/synchronizer"
DATE=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/reindex-$DATE.log"
NOTIFY_SH="$HOME/Github/DS-synchronizer/scripts/notify.sh"
SOURCES_JSON="$SCRIPT_DIR/sources.json"

mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [reindex] $1" | tee -a "$LOG_FILE"
}

log "=== Reindex Started ==="

if [ "${1:-}" = "--dry-run" ]; then
    log "DRY RUN — showing sources only"
    cat "$SOURCES_JSON" | python3 -c '
import sys, json
sources = json.load(sys.stdin)
for s in sources:
    print(f"  {s[\"source\"]} ({s[\"source_type\"]}) → {s[\"path\"]}")
'
    log "=== Reindex Dry Run Complete ==="
    exit 0
fi

# Запуск ingest.ts
cd "$MCP_DIR"
OUTPUT=$(npx tsx scripts/ingest.ts --config scripts/sources.json 2>&1) || {
    log "ERROR: ingest.ts failed"
    log "$OUTPUT"
    # Отправить уведомление об ошибке
    "$NOTIFY_SH" synchronizer reindex-error 2>/dev/null || true
    exit 1
}

echo "$OUTPUT" >> "$LOG_FILE"
log "=== Reindex Complete ==="

# Отправить уведомление об успехе
"$NOTIFY_SH" synchronizer reindex-done 2>/dev/null || true
