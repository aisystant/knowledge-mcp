#!/usr/bin/env bash
# Production deploy gate for knowledge-mcp.
#
# The gate accepts only a clean checkout of the current origin/main, records
# the exact Cloudflare Version created by this invocation, and proves that the
# same Version is serving 100% of traffic. Any failure after upload rolls back
# to the previously active Version, provided no other deployment superseded it.
set -euo pipefail

worker="knowledge-mcp"
health_url="https://knowledge-mcp.aisystant.com/health"
previous_version_id=""
deployed_version_id=""
git_sha=""
deploy_log=""
rollback_required="false"
previous_versions_json=""
deploy_attempted="false"

is_version_id() {
  printf '%s' "$1" | grep -qE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
}

active_version_id() {
  local status_json
  status_json=$(npx wrangler deployments status --name "$worker" --json 2>/dev/null) || return 0
  printf '%s' "$status_json" | jq -r \
    '[.versions[]? | select(.percentage == 100)] | if length == 1 then .[0].version_id else empty end' \
    2>/dev/null || true
}

new_uploaded_version_id() {
  local versions_json
  versions_json=$(npx wrangler versions list --name "$worker" --json 2>/dev/null) || return 0
  printf '%s' "$versions_json" | jq -r \
    --argjson before "$previous_versions_json" \
    --arg tag "$git_sha" \
    --arg message "git:$git_sha" '
      ($before | map(.id)) as $before_ids
      | [.[]
          | select(.id as $id | ($before_ids | index($id)) == null)
          | select(.annotations["workers/tag"] == $tag)
          | select(.annotations["workers/message"] == $message)]
      | if length == 1 then .[0].id else empty end
    ' 2>/dev/null || true
}

version_matches_release() {
  local candidate_id="$1" version_json
  version_json=$(npx wrangler versions view "$candidate_id" --name "$worker" --json 2>/dev/null) || return 1
  printf '%s' "$version_json" | jq -e \
    --arg id "$candidate_id" \
    --arg tag "$git_sha" \
    --arg message "git:$git_sha" '
      .id == $id
      and .annotations["workers/tag"] == $tag
      and .annotations["workers/message"] == $message
    ' >/dev/null 2>&1
}

reconcile_deployed_version_id() {
  local candidate_id="" active_id=""
  for _ in 1 2 3 4 5 6; do
    candidate_id=$(new_uploaded_version_id)
    if is_version_id "$candidate_id" && version_matches_release "$candidate_id"; then
      printf '%s\n' "$candidate_id"
      return
    fi

    active_id=$(active_version_id)
    if is_version_id "$active_id" \
      && [ "$active_id" != "$previous_version_id" ] \
      && version_matches_release "$active_id"; then
      printf '%s\n' "$active_id"
      return
    fi
    sleep 2
  done
}

health_http_code() {
  local version_id="$1"
  local attempt="$2"
  curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -H 'Cache-Control: no-cache' \
    "${health_url}?deploy_check=${version_id}&attempt=${attempt}" || true
}

rollback_previous_version() {
  local current_version_id="" attempt rollback_code=""

  for attempt in 1 2 3 4 5 6; do
    current_version_id=$(active_version_id)
    [ -n "$current_version_id" ] && break
    sleep 2
  done

  if [ "$current_version_id" = "$previous_version_id" ]; then
    echo "[verified-deploy] previous version is still active; rollback is not needed" >&2
    return
  fi
  if [ "$current_version_id" != "$previous_version_id" ] \
    && [ "$current_version_id" != "$deployed_version_id" ]; then
    echo "[verified-deploy] FATAL: refusing to overwrite an unexpected active version during rollback" >&2
    echo "  previous=$previous_version_id deployed=$deployed_version_id active=$current_version_id" >&2
    return
  fi

  echo "[verified-deploy] restoring $previous_version_id after failed deployment $deployed_version_id" >&2
  if ! NO_COLOR=1 npx wrangler rollback "$previous_version_id" \
    --name "$worker" \
    --message "automatic rollback after failed git:$git_sha" \
    --yes; then
    echo "[verified-deploy] FATAL: rollback command failed" >&2
    return
  fi

  for attempt in $(seq 1 18); do
    current_version_id=$(active_version_id)
    rollback_code=$(health_http_code "$previous_version_id" "$attempt")
    if [ "$current_version_id" = "$previous_version_id" ] && [ "$rollback_code" = "200" ]; then
      echo "[verified-deploy] rollback confirmed: version $previous_version_id is active and healthy" >&2
      return
    fi
    sleep 5
  done

  echo "[verified-deploy] FATAL: rollback could not be confirmed" >&2
  echo "  expected active=$previous_version_id HTTP=200" >&2
  echo "  actual   active=$current_version_id HTTP=$rollback_code" >&2
}

on_exit() {
  local exit_code="$?"
  local reconciled_version_id=""
  trap - EXIT HUP INT TERM
  set +e
  if [ "$exit_code" -ne 0 ] \
    && [ "$deploy_attempted" = "true" ] \
    && [ "$rollback_required" != "true" ]; then
    reconciled_version_id=$(reconcile_deployed_version_id)
    if is_version_id "$reconciled_version_id"; then
      deployed_version_id="$reconciled_version_id"
      rollback_required="true"
    fi
  fi
  if [ "$exit_code" -ne 0 ] && [ "$rollback_required" = "true" ]; then
    rollback_previous_version
  fi
  [ -z "$deploy_log" ] || rm -f "$deploy_log"
  exit "$exit_code"
}

trap on_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

assert_latest_origin_main() {
  local expected_sha="$1" remote_main
  git fetch --quiet origin '+refs/heads/main:refs/remotes/origin/main'
  remote_main=$(git rev-parse refs/remotes/origin/main)
  if [ "$expected_sha" != "$remote_main" ]; then
    echo "[verified-deploy] FATAL: refusing to deploy a stale/non-main commit" >&2
    echo "  local HEAD=$expected_sha" >&2
    echo "  origin/main=$remote_main" >&2
    exit 1
  fi
}

dirty_paths=$(git status --porcelain --untracked-files=all -- . \
  ':(exclude)node_modules')
if [ -n "$dirty_paths" ]; then
  echo "[verified-deploy] FATAL: refusing to tag a dirty worktree as a git commit" >&2
  printf '%s\n' "$dirty_paths" >&2
  exit 1
fi

git_sha=$(git rev-parse HEAD)
if ! printf '%s' "$git_sha" | grep -qE '^[0-9a-f]{40}$'; then
  echo "[verified-deploy] FATAL: git HEAD is not a full commit SHA" >&2
  exit 1
fi
assert_latest_origin_main "$git_sha"

previous_version_id=$(active_version_id)
if ! is_version_id "$previous_version_id"; then
  echo "[verified-deploy] FATAL: production must have exactly one valid version at 100% before deploy" >&2
  exit 1
fi
previous_versions_json=$(npx wrangler versions list --name "$worker" --json)
if ! printf '%s' "$previous_versions_json" | jq -e 'type == "array"' >/dev/null; then
  echo "[verified-deploy] FATAL: could not snapshot Worker Versions before deploy" >&2
  exit 1
fi

deploy_log=$(mktemp "${TMPDIR:-/tmp}/knowledge-mcp-deploy.XXXXXX")
echo "[verified-deploy] deploying $worker from git $git_sha (previous version $previous_version_id)"
deploy_succeeded="true"
deploy_attempted="true"
if ! NO_COLOR=1 npx wrangler deploy \
  --name "$worker" \
  --strict \
  --tag "$git_sha" \
  --message "git:$git_sha" 2>&1 | tee "$deploy_log"; then
  deploy_succeeded="false"
fi

deployed_version_id=$(sed -nE \
  's/^Current Version ID:[[:space:]]*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})[[:space:]]*$/\1/p' \
  "$deploy_log" | tail -n 1)
if ! is_version_id "$deployed_version_id" || ! version_matches_release "$deployed_version_id"; then
  deployed_version_id=$(reconcile_deployed_version_id)
fi
if is_version_id "$deployed_version_id" && [ "$deployed_version_id" != "$previous_version_id" ]; then
  rollback_required="true"
fi
if [ "$deploy_succeeded" != "true" ]; then
  echo "[verified-deploy] FATAL: wrangler deploy failed" >&2
  exit 1
fi
if [ "$rollback_required" != "true" ]; then
  echo "[verified-deploy] FATAL: could not identify the new Cloudflare Version" >&2
  exit 1
fi

# A newer main during upload invalidates this release. The EXIT trap restores
# the previous production Version before the queued newest workflow proceeds.
assert_latest_origin_main "$git_sha"

version_json=$(npx wrangler versions view "$deployed_version_id" --name "$worker" --json)
version_id=$(printf '%s' "$version_json" | jq -r '.id // empty')
version_tag=$(printf '%s' "$version_json" | jq -r '.annotations["workers/tag"] // empty')
version_message=$(printf '%s' "$version_json" | jq -r '.annotations["workers/message"] // empty')
if [ "$version_id" != "$deployed_version_id" ] \
  || [ "$version_tag" != "$git_sha" ] \
  || [ "$version_message" != "git:$git_sha" ]; then
  echo "[verified-deploy] FATAL: uploaded Version metadata does not match this release" >&2
  echo "  expected id=$deployed_version_id tag=$git_sha message=git:$git_sha" >&2
  echo "  actual   id=$version_id tag=$version_tag message=$version_message" >&2
  exit 1
fi

echo "[verified-deploy] waiting for exact runtime provenance at $health_url"
attempt=0
active_id=""
actual_version_id=""
actual_git_sha=""
code=""
while :; do
  active_id=$(active_version_id)
  response=$(curl -sS -w $'\n%{http_code}' --max-time 10 \
    -H 'Cache-Control: no-cache' \
    "${health_url}?deploy_check=${deployed_version_id}&attempt=${attempt}" || true)
  code="${response##*$'\n'}"
  body="${response%$'\n'*}"
  actual_version_id=$(printf '%s' "$body" | jq -r '.version.id // empty' 2>/dev/null || true)
  actual_git_sha=$(printf '%s' "$body" | jq -r '.version.tag // empty' 2>/dev/null || true)

  if [ "$code" = "200" ] \
    && [ "$active_id" = "$deployed_version_id" ] \
    && [ "$actual_version_id" = "$deployed_version_id" ] \
    && [ "$actual_git_sha" = "$git_sha" ]; then
    assert_latest_origin_main "$git_sha"
    rollback_required="false"
    deploy_attempted="false"
    echo "[verified-deploy] runtime provenance confirmed: version $deployed_version_id, git $git_sha"
    exit 0
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -ge 18 ]; then
    echo "[verified-deploy] FATAL: deployed Version did not become the proven active runtime" >&2
    echo "  expected HTTP=200 active=$deployed_version_id health_version=$deployed_version_id git=$git_sha" >&2
    echo "  actual   HTTP=$code active=$active_id health_version=$actual_version_id git=$actual_git_sha" >&2
    exit 1
  fi
  sleep 5
done
