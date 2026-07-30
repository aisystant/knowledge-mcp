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
SOURCES_JSON="${SOURCES_CONFIG:-$SCRIPT_DIR/sources.json}"
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

# Резолвим source → path + source_type (+ user_id, если задан — WP-484 30.07,
# peer-session with Codex, Ф27-2: personal sources carry user_id in
# sources-personal.json, which caller sets $SOURCES_CONFIG to point at; platform
# sources in the default sources.json have no such key). The 4th field is
# printed unconditionally (empty string, not omitted) so `read` below always
# sees 4 tab-separated fields — an omitted trailing field on an L2 (platform)
# row would silently shift nothing here since it's already last, but making the
# arity explicit avoids relying on that fact.
RESOLVED=$(python3 - "${REQUESTED[@]}" << PYEOF
import sys, json
sources = json.load(open("$SOURCES_JSON"))
requested = sys.argv[1:]
source_map = {s["source"]: s for s in sources}
for name in requested:
    if name in source_map:
        s = source_map[name]
        path = s["path"].replace("~", "$HOME")
        print(f"{s['source']}\t{s['source_type']}\t{path}\t{s.get('user_id', '')}")
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

FAILED_SOURCES=()
while IFS=$'\t' read -r SOURCE SOURCE_TYPE SOURCE_PATH USER_ID; do
    log "→ Indexing: $SOURCE ($SOURCE_TYPE) from $SOURCE_PATH"

    UID_ARGS=()
    [ -n "$USER_ID" ] && UID_ARGS=(--user-id "$USER_ID")

    # `set -u` (line 12) makes a bare "${UID_ARGS[@]}" on a genuinely empty
    # array an unbound-variable error in bash — the L2 (platform) case, which
    # is the common one, has no user_id and hit this on every single call
    # (caught live by the smoke test, not by inspection: exit 1 on the FIRST
    # source, before Ф27-2's own FAILED_SOURCES logic ever ran). The
    # `${arr[@]+"${arr[@]}"}` form is the standard nounset-safe empty-array
    # expansion — expands to nothing when UID_ARGS is empty instead of erroring.
    OUTPUT=$(npx tsx scripts/ingest.ts --source "$SOURCE" --type "$SOURCE_TYPE" --path "$SOURCE_PATH" ${UID_ARGS[@]+"${UID_ARGS[@]}"} 2>&1) || {
        log "ERROR: ingest failed for $SOURCE"
        log "$OUTPUT"
        FAILED_SOURCES+=("$SOURCE")
        continue
    }

    # Извлекаем количество проиндексированных docs (формат: "Done. Indexed: N" или "Total indexed: N")
    INDEXED=$(echo "$OUTPUT" | grep -oE '(Done\. Indexed|Total indexed): [0-9]+' | grep -o '[0-9]*' || echo "0")
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

# WP-484 30.07 (peer-session with Codex): a failed ingest.ts call used to just
# `continue` to the next source — the loop always exited 0 even when every
# single source failed (live incident: 3 of 6 day-close.sh sources failed this
# way every night, silently, because the caller never checked this script's
# exit code either — see the fix in day-close.sh's do_reindex()). Partial
# progress on the OTHER sources is still real and already logged above; this
# only changes whether the caller can tell "some/all failed" from "all OK".
if [ "${#FAILED_SOURCES[@]}" -gt 0 ]; then
    log "ERROR: ${#FAILED_SOURCES[@]} source(s) failed: ${FAILED_SOURCES[*]}"
    echo "FAILED: ${FAILED_SOURCES[*]}" >&2
    exit 1
fi
