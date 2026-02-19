#!/bin/bash
# selective-reindex.sh — переиндексация выбранных источников (DP.AISYS.013 § 4.8)
#
# Вызывается из протокола Session-Close после записи в Pack.
# Читает sources.json, фильтрует по переданным source-именам, вызывает ingest.ts.
#
# Использование:
#   selective-reindex.sh PACK-digital-platform              — один источник
#   selective-reindex.sh PACK-digital-platform PACK-personal — несколько
#   selective-reindex.sh --list                              — показать доступные source

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MCP_DIR="$(dirname "$SCRIPT_DIR")"
SOURCES_JSON="$SCRIPT_DIR/sources.json"
LOG_DIR="$HOME/logs/synchronizer"
DATE=$(date +%Y-%m-%d)
LOG_FILE="$LOG_DIR/selective-reindex-$DATE.log"

mkdir -p "$LOG_DIR"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [selective-reindex] $1" | tee -a "$LOG_FILE"
}

if [ $# -eq 0 ]; then
    echo "Usage: selective-reindex.sh <source1> [<source2> ...]"
    echo "       selective-reindex.sh --list"
    exit 1
fi

if [ "$1" = "--list" ]; then
    python3 << PYEOF
import json
sources = json.load(open("$SOURCES_JSON"))
for s in sources:
    name = s["source"]
    stype = s["source_type"]
    path = s["path"]
    print(f"  {name:30s} ({stype:6s}) -> {path}")
PYEOF
    exit 0
fi

REQUESTED=("$@")
TOTAL_INDEXED=0
TOTAL_SOURCES=0
START_TIME=$(date +%s)

log "=== Selective Reindex Started ==="
log "Sources requested: ${REQUESTED[*]}"

# Резолвим source → path + source_type из sources.json
RESOLVED=$(python3 - "${REQUESTED[@]}" << PYEOF
import sys, json
sources = json.load(open("$SOURCES_JSON"))
requested = sys.argv[1:]
source_map = {s["source"]: s for s in sources}
for name in requested:
    if name in source_map:
        s = source_map[name]
        path = s["path"].replace("~", "$HOME")
        print(f"{s['source']}\t{s['source_type']}\t{path}")
    else:
        print(f"ERROR\t{name}\tnot found in sources.json", file=sys.stderr)
        sys.exit(1)
PYEOF
) || {
    log "ERROR: unknown source in request"
    echo "$RESOLVED"
    exit 1
}

cd "$MCP_DIR"

while IFS=$'\t' read -r SOURCE SOURCE_TYPE SOURCE_PATH; do
    log "→ Indexing: $SOURCE ($SOURCE_TYPE) from $SOURCE_PATH"

    OUTPUT=$(npx tsx scripts/ingest.ts --source "$SOURCE" --type "$SOURCE_TYPE" --path "$SOURCE_PATH" 2>&1) || {
        log "ERROR: ingest failed for $SOURCE"
        log "$OUTPUT"
        continue
    }

    # Извлекаем количество проиндексированных docs (формат: "Total indexed: N")
    INDEXED=$(echo "$OUTPUT" | grep -o 'Total indexed: [0-9]*' | grep -o '[0-9]*' || echo "0")
    TOTAL_INDEXED=$((TOTAL_INDEXED + INDEXED))
    TOTAL_SOURCES=$((TOTAL_SOURCES + 1))

    log "  ✓ $SOURCE: $INDEXED docs indexed"
    echo "$OUTPUT" >> "$LOG_FILE"
done <<< "$RESOLVED"

END_TIME=$(date +%s)
ELAPSED=$((END_TIME - START_TIME))

log "=== Selective Reindex Complete ==="
log "Sources: $TOTAL_SOURCES, Docs indexed: $TOTAL_INDEXED, Time: ${ELAPSED}s"

echo "Reindex: $TOTAL_SOURCES источников, $TOTAL_INDEXED docs проиндексировано за ${ELAPSED} сек."
