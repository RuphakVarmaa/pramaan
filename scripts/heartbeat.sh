#!/usr/bin/env bash
# Pramaan git heartbeat — checkpoints wip/auto every 5 minutes with a secret scan.
# Started by the Orchestrator; killed after the final ship merge.
#
# Secret scan = exact-value matching: every real value in .env (length >= 8,
# not a placeholder) is extracted and must not appear in the staged diff.
# Plus a literal check for any rzp live key marker (assembled at runtime so
# this file never self-matches).
set -u
cd "/Users/ruphakvarmaa/Documents/Ruphak's-Harness/pramaan" || exit 1

LIVE_MARKER="rzp""_live"

scan_secrets() {
  # $1 = staged diff text on stdin; returns 0 if a secret is found
  local diff_text
  diff_text=$(cat)

  # 1) Any live-key marker anywhere -> instant fail
  if printf '%s' "$diff_text" | grep -q "$LIVE_MARKER"; then
    return 0
  fi

  # 2) Exact values from the real .env must not appear
  if [ -f .env ]; then
    local tmp
    tmp=$(mktemp)
    # extract KEY="value" or KEY=value pairs, keep values worth guarding
    sed -E 's/^[A-Za-z_][A-Za-z0-9_]*=("([^"]*)"|[^[:space:]]+).*/\2\1/' .env 2>/dev/null | while IFS= read -r v; do
      v="${v%\"}"; v="${v#\"}"
      if [ "${#v}" -ge 8 ] && [ "${v:0:4}" != "your" ] && [ "${v:0:6}" != "placeh" ] && ! printf '%s' "$v" | grep -q "XXXXX"; then
        printf '%s\n' "$v"
      fi
    done > "$tmp"
    if [ -s "$tmp" ]; then
      if printf '%s' "$diff_text" | grep -qF -f "$tmp"; then
        rm -f "$tmp"
        return 0
      fi
    fi
    rm -f "$tmp"
  fi
  return 1
}

while true; do
  git add -A
  if ! git diff --cached --quiet; then
    if git diff --cached | scan_secrets; then
      echo "[$(date -u +%FT%TZ)] HEARTBEAT ALERT: secret-like content in staged diff — aborting commit" >&2
      git reset >/dev/null 2>&1
    else
      STATS=$(git diff --cached --shortstat | sed 's/^ //')
      git commit -m "checkpoint(auto): ${STATS:-changes} [heartbeat]" >/dev/null 2>&1
      git push origin wip/auto >/dev/null 2>&1 && echo "[$(date -u +%FT%TZ)] heartbeat pushed: ${STATS:-changes}" || echo "[$(date -u +%FT%TZ)] heartbeat push FAILED (will retry next cycle)" >&2
    fi
  else
    echo "[$(date -u +%FT%TZ)] heartbeat: clean"
  fi
  sleep 300
done
