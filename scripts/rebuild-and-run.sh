#!/usr/bin/env bash
set -euo pipefail

plugin_id="herdr-discord-bridge"
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

echo "Installing local dependencies..."
npm ci

echo "Building local plugin..."
npm run build

echo "Finding existing Discord bridge panes..."
mapfile -t bridge_panes < <(
  herdr pane list | jq -r ".result.panes[] | select(.label == \"Discord bridge\" or .terminal_title == \"Discord bridge\" or .terminal_title_stripped == \"Discord bridge\" or ((.cwd // \"\") | test(\"herdr-discord-bridge-\"))) | .pane_id"
)
for pane_id in "${bridge_panes[@]}"; do
  [[ -n "$pane_id" ]] || continue
  echo "Closing pane $pane_id..."
  herdr pane close "$pane_id"
done

echo "Linking local plugin..."
herdr plugin unlink "$plugin_id" 2>/dev/null || true
herdr plugin link . --enabled

echo "Opening Discord bridge pane..."
herdr plugin pane open \
  --plugin "$plugin_id" \
  --entrypoint bridge
