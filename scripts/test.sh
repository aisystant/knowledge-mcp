#!/usr/bin/env bash
# Headless contract-test runner. Starts the devenv services (postgres) detached
# if the DB isn't already up, waits for it, then runs pytest. Run from inside the
# dev shell:
#
#   nix develop --impure --accept-flake-config -c scripts/test.sh
#
# Extra args pass through to pytest, e.g. `scripts/test.sh -k access -q`.
set -euo pipefail

if ! pg_isready -h 127.0.0.1 -p 5432 -q 2>/dev/null; then
  echo "starting postgres (detached)..."
  devenv up -D
fi

for _ in $(seq 1 60); do
  pg_isready -h 127.0.0.1 -p 5432 -q && break
  sleep 1
done
pg_isready -h 127.0.0.1 -p 5432 -q || { echo "postgres did not start" >&2; exit 1; }

exec uv run pytest "$@"
