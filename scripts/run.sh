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

echo "Finding existing Discord bridge panes..."
mapfile -t bridge_panes < <(
  herdr pane list | jq -r ".result.panes[] | select(.label == \"Discord bridge\" or .terminal_title == \"Discord bridge\" or .terminal_title_stripped == \"Discord bridge\" or ((.cwd // \"\") | test(\"herdr-discord-bridge-\"))) | .pane_id"
)
for pane_id in "${bridge_panes[@]}"; do
  [[ -n "$pane_id" ]] || continue
  echo "Closing pane $pane_id..."
  herdr pane close "$pane_id"
done

tab_json="$(herdr tab list)"
tab_id="$(printf "%s" "$tab_json" | jq -r '.result.tabs[] | select(.number == 1) | .tab_id' | head -n1)"
workspace_id="$(printf "%s" "$tab_json" | jq -r --arg tab "$tab_id" '.result.tabs[] | select(.tab_id == $tab) | .workspace_id' | head -n1)"
target_pane="$(herdr pane list | jq -r --arg tab "$tab_id" '.result.panes[] | select(.tab_id == $tab) | .pane_id' | head -n1)"
if [[ -z "$tab_id" || -z "$workspace_id" || -z "$target_pane" ]]; then
  echo "Could not find tab 1 and a target pane for the Discord bridge." >&2
  exit 1
fi

# Keep tab 1 dedicated to the Discord bridge. Move existing Agent panes to a
# separate Agents tab so they do not share the bridge tab.
agent_panes="$(herdr agent list | jq -r --arg tab "$tab_id" '.result.agents[]? | select(.tab_id == $tab) | .pane_id' | sed 's/^ //')"
target_pane=""
while IFS= read -r pane_id; do
  [[ -n "$pane_id" ]] || continue
  if ! grep -Fxq "$pane_id" <<< "$agent_panes"; then
    target_pane="$pane_id"
    break
  fi
done < <(herdr pane list | jq -r --arg tab "$tab_id" '.result.panes[]? | select(.tab_id == $tab) | .pane_id')
if [[ -z "$target_pane" ]]; then
  first_pane="$(herdr pane list | jq -r --arg tab "$tab_id" '.result.panes[]? | select(.tab_id == $tab) | .pane_id' | head -n1)"
  split_result="$(herdr pane split "$first_pane" --direction right --no-focus)"
  target_pane="$(printf "%s" "$split_result" | jq -r ".result.pane.pane_id // empty")"
fi
if [[ -z "$target_pane" ]]; then
  echo "Could not prepare a shell target in tab 1." >&2
  exit 1
fi
move_panes=()
while IFS= read -r pane_id; do
  [[ -n "$pane_id" && "$pane_id" != "$target_pane" ]] || continue
  move_panes+=("$pane_id")
done < <(herdr pane list | jq -r --arg tab "$tab_id" '.result.panes[]? | select(.tab_id == $tab) | .pane_id')
if [[ ${#move_panes[@]} -gt 0 ]]; then
  agents_tab_id="$(printf "%s" "$tab_json" | jq -r --arg tab "$tab_id" '.result.tabs[]? | select(.label == "Agents" and .tab_id != $tab) | .tab_id' | head -n1)"
  agents_root_pane=""
  if [[ -z "$agents_tab_id" ]]; then
    agents_result="$(herdr tab create --workspace "$workspace_id" --label Agents --no-focus)"
    printf "%s\n" "$agents_result"
    agents_tab_id="$(printf "%s" "$agents_result" | jq -r ".result.tab.tab_id // empty")"
    agents_root_pane="$(printf "%s" "$agents_result" | jq -r ".result.root_pane.pane_id // empty")"
  else
    agents_root_pane="$(herdr pane list | jq -r --arg tab "$agents_tab_id" '.result.panes[]? | select(.tab_id == $tab) | .pane_id' | head -n1)"
  fi
  if [[ -z "$agents_tab_id" || -z "$agents_root_pane" ]]; then
    echo "Could not prepare the Agents tab." >&2
    exit 1
  fi
  for pane_id in "${move_panes[@]}"; do
    echo "Moving pane $pane_id to Agents tab..."
    herdr pane move "$pane_id" --tab "$agents_tab_id" --split right --target-pane "$agents_root_pane" --no-focus
  done
fi
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
