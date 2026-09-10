#!/usr/bin/env bash
set -euo pipefail

plugin_id="herdr-discord-bridge"
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

mode="${1:-}"
if [[ $# -gt 1 ]]; then
  echo "Usage: $0 [-r|-rg]" >&2
  exit 2
fi
case "$mode" in
  "")
    echo "Starting existing installed plugin..."
    ;;
  -r)
    echo "Installing local dependencies..."
    npm ci
    echo "Building local plugin..."
    npm run build
    ;;
  -rg)
    echo "Installing plugin from GitHub..."
    herdr plugin install jon888465/Herdr_Discord_Bridge --ref main --yes
    ;;
  *)
    echo "Usage: $0 [-r|-rg]" >&2
    exit 2
    ;;
esac
is_herdr_server_running() {
  herdr status server 2>/dev/null | grep -Eq "^status:[[:space:]]*running"
}

ensure_herdr_server() {
  if is_herdr_server_running; then
    return 0
  fi

  local server_log="${TMPDIR:-/tmp}/herdr-server.log"
  echo "Herdr server is not running; starting headless server..."
  nohup herdr server >>"$server_log" 2>&1 </dev/null &

  for _ in {1..50}; do
    if is_herdr_server_running; then
      echo "Herdr server is ready."
      return 0
    fi
    sleep 0.2
  done

  echo "Herdr server did not become ready; log: $server_log" >&2
  if [[ -f "$server_log" ]]; then
    tail -n 40 "$server_log" >&2
  fi
  return 1
}

ensure_herdr_server

# Resolve the destination before closing a pane: closing the last pane can
# remove a tab and make a global "first tab 1" lookup select another workspace.
# Only an explicitly labelled non-Agent pane is eligible for replacement.
workspace_json="$(herdr workspace list)"
mapfile -t bridge_workspaces < <(printf "%s" "$workspace_json" | jq -r '.result.workspaces[] | select(.label == "bridge" or .name == "bridge") | .workspace_id')
if [[ ${#bridge_workspaces[@]} -gt 1 ]]; then
  echo "Multiple workspaces named bridge; resolve duplicate names first. No panes were closed." >&2
  exit 1
fi
workspace_id="${bridge_workspaces[0]:-}"
panes_json="$(herdr pane list)"
if [[ -z "$workspace_id" ]]; then
  echo "Creating dedicated bridge workspace..."
  workspace_result="$(herdr workspace create --label bridge --cwd "$project_dir" --no-focus)"
  workspace_id="$(printf "%s" "$workspace_result" | jq -r '.result.workspace.workspace_id // empty')"
  if [[ -z "$workspace_id" ]]; then
    echo "Could not identify the bridge workspace; no panes were closed." >&2
    exit 1
  fi
  panes_json="$(herdr pane list)"
fi
legacy_bridges="$(printf "%s" "$panes_json" | jq -r --arg wk "$workspace_id" '.result.panes[] | select(.workspace_id != $wk and (.agent // "") == "" and (.label == "Discord bridge" or .terminal_title == "Discord bridge" or .terminal_title_stripped == "Discord bridge")) | .pane_id')"
if [[ -n "$legacy_bridges" ]]; then
  echo "Existing bridge panes outside the dedicated workspace: $legacy_bridges" >&2
  echo "Move or stop those bridge panes explicitly before restarting. No panes were changed." >&2
  exit 1
fi
tab_json="$(herdr tab list)"
mapfile -t target_tabs < <(printf "%s" "$tab_json" | jq -r --arg wk "$workspace_id" '.result.tabs[] | select(.workspace_id == $wk and .number == 1) | .tab_id')
if [[ ${#target_tabs[@]} != 1 ]]; then
  echo "Could not find exactly one tab 1 in workspace $workspace_id; no panes were closed." >&2
  exit 1
fi
tab_id="${target_tabs[0]}"
mapfile -t bridge_panes < <(printf "%s" "$panes_json" | jq -r --arg tab "$tab_id" '.result.panes[] | select(.tab_id == $tab and (.agent // "") == "" and (.label == "Discord bridge" or .terminal_title == "Discord bridge" or .terminal_title_stripped == "Discord bridge")) | .pane_id')
target_pane="$(printf "%s" "$panes_json" | jq -r --arg tab "$tab_id" '[.result.panes[] | select(.tab_id == $tab) | select((.agent // "") != "" or (.label != "Discord bridge" and .terminal_title != "Discord bridge" and .terminal_title_stripped != "Discord bridge"))][0].pane_id // empty')"
if [[ -z "$target_pane" ]]; then
  # Preserve tab 1 if its only pane is the old bridge.
  if [[ ${#bridge_panes[@]} == 0 ]]; then
    echo "No target pane in tab 1; no panes were closed." >&2
    exit 1
  fi
  split_result="$(herdr pane split "${bridge_panes[0]}" --direction right --no-focus)"
  target_pane="$(printf "%s" "$split_result" | jq -r '.result.pane.pane_id // empty')"
fi
if [[ -z "$target_pane" ]]; then
  echo "Could not prepare a target in tab 1; no panes were closed." >&2
  exit 1
fi
for pane_id in "${bridge_panes[@]}"; do
  echo "Closing bridge pane $pane_id..."
  herdr pane close "$pane_id"
done

if [[ "$mode" == "-r" ]]; then
  echo "Linking local plugin..."
  herdr plugin unlink "$plugin_id" 2>/dev/null || true
  herdr plugin link . --enabled
fi

echo "Opening Discord bridge pane..."
open_result="$(herdr plugin pane open \
  --plugin "$plugin_id" \
  --entrypoint bridge \
  --placement tab \
  --workspace "$workspace_id" \
  --no-focus)"
printf "%s\n" "$open_result"
bridge_pane="$(printf "%s" "$open_result" | jq -r '.result.plugin_pane.pane.pane_id // .result.plugin_pane.pane_id // .result.pane.pane_id // empty')"
if [[ -z "$bridge_pane" ]]; then
  echo "Could not identify the newly opened Discord bridge pane." >&2
  exit 1
fi

echo "Moving Discord bridge pane $bridge_pane to tab 1..."
herdr pane move "$bridge_pane" \
  --tab "$tab_id" \
  --split right \
  --target-pane "$target_pane" \
  --no-focus
