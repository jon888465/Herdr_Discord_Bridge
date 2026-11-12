#!/usr/bin/env bash
set -euo pipefail

plugin_id="herdr-discord-bridge"
project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

usage() {
  cat <<'USAGE'
Usage: scripts/run.sh [--herdr|--core] [-r|-rg]
Backend defaults to --herdr. Options may appear in any order.
-r: rebuild local checkout; -rg: reinstall from GitHub (Herdr only).
--core -rg is unsupported; no changes are made.
USAGE
}
argument_error() {
  echo "$1" >&2
  usage >&2
  exit 2
}
backend="herdr"
backend_seen=0
mode=""
help_requested=0
for argument in "$@"; do
  case "$argument" in
    --herdr|--core)
      [[ "$backend_seen" == 0 ]] || argument_error "Backend specified more than once: $argument"
      backend_seen=1
      backend="${argument#--}"
      ;;
    -r|-rg)
      [[ -z "$mode" ]] || argument_error "Mode specified more than once: $argument"
      mode="$argument"
      ;;
    -h|--help) help_requested=1 ;;
    *) argument_error "Unknown argument: $argument" ;;
  esac
done
[[ "$backend" != core || "$mode" != -rg ]] || argument_error "--core -rg is unsupported; no changes are made."
if [[ "$help_requested" == 1 ]]; then
  usage
  exit 0
fi

# The CLI's explicit absence message is `no core running`. Only that exact
# message (plain or JSON error.message) plus a nonzero status permits start.
# Permission, incompatible, timeout and generic socket errors never permit it.
core_server_absent() {
  [[ "$1" == "no core running" ]] || printf '%s' "$1" | jq -e '.error.message == "no core running"' >/dev/null 2>&1
}
core_status() {
  # A hung individual status call must not make the readiness loop unbounded.
  node -e '
    const {spawnSync}=require("node:child_process");
    const r=spawnSync("herdr-core",["server","status","--json"],{encoding:"utf8",timeout:1000});
    process.stdout.write(r.stdout || ""); process.stderr.write(r.stderr || "");
    if(r.error) process.stderr.write("Core status failed or timed out\n");
    process.exit(r.status === null ? 1 : r.status);
  '
}
core_status_valid() {
  printf '%s' "$1" | jq -e 'type == "object" and (.version | type == "string") and (.core.id | type == "string")' >/dev/null 2>&1
}
if [[ "$backend" == core ]]; then
  project_dir="$(pwd -P)"
  bridge_config_dir="${HERDR_PLUGIN_CONFIG_DIR:-$(node -e 'console.log(require("node:path").join(require("node:os").homedir(),".config","herdr-discord-bridge"))')}"
  bridge_state_dir="${HERDR_PLUGIN_STATE_DIR:-$(node -e 'console.log(require("node:path").resolve(process.argv[1],"state"))' "$bridge_config_dir")}"
  # Match config.ts: config.json accepts JSONC comments and trailing commas.
  # Print only token presence; never copy a token into argv, stdout or stderr.
  file_has_token="$(node - "$bridge_config_dir" <<'NODE'
const fs = require("node:fs"), path = require("node:path");
try {
  const file = path.join(process.argv[2], "config.json");
  if (!fs.existsSync(file)) {console.log("missing");process.exit(0);}
  let text = fs.readFileSync(file,"utf8");
  let out="", quoted=false, escaped=false, line=false, block=false;
  for(let i=0;i<text.length;i++) {
    const c=text[i], n=text[i+1];
    if(line) {if(c==="\n") {line=false;out+=c;}continue;}
    if(block) {if(c==="*"&&n==="/") {block=false;i++;}else if(c==="\n")out+=c;continue;}
    if(quoted) {out+=c;if(escaped)escaped=false;else if(c==="\\")escaped=true;else if(c==='"')quoted=false;continue;}
    if(c==='"') {quoted=true;out+=c;}else if(c==="/"&&n==="/"){line=true;i++;}else if(c==="/"&&n==="*"){block=true;i++;}else out+=c;
  }
  const config=JSON.parse(out.replace(/,\s*([}\]])/g,"$1"));
  console.log(typeof config?.discord?.botToken === "string" && config.discord.botToken.length > 0 ? "yes" : "no");
} catch {console.error("Cannot read bridge config.json; Core was not started.");process.exit(1);}
NODE
)"
  if [[ "$file_has_token" == missing ]]; then
    # A missing file would otherwise launch a Core terminal that exits at once
    # (ISSUE-151). Herdr plugin installs keep config.json in the plugin config dir.
    echo "Core bridge config not found: $bridge_config_dir/config.json; set HERDR_PLUGIN_CONFIG_DIR (Herdr plugin installs: herdr plugin config-dir herdr-discord-bridge). Core was not started." >&2
    # Filesystem-only hint at Herdr's plugin config directory; no herdr call and
    # no silent switch to that config (SPEC: never pick another config file).
    plugin_config_dir="$HOME/.config/herdr/plugins/config/herdr-discord-bridge"
    plugin_state_dir="$HOME/.local/state/herdr/plugins/herdr-discord-bridge"
    if [[ "$plugin_config_dir" != "$bridge_config_dir" && -f "$plugin_config_dir/config.json" ]]; then
      echo "Found Herdr plugin config: $plugin_config_dir/config.json" >&2
      rerun="HERDR_PLUGIN_CONFIG_DIR=$plugin_config_dir"
      [[ -d "$plugin_state_dir" ]] && rerun+=" HERDR_PLUGIN_STATE_DIR=$plugin_state_dir"
      echo "Rerun with: $rerun scripts/run.sh --core${mode:+ $mode}" >&2
    fi
    exit 1
  fi
  if [[ "$file_has_token" != yes && ( -n "${HERDR_DISCORD_BOT_TOKEN:-}" || -n "${DISCORD_BOT_TOKEN:-}" ) ]]; then
    echo "Core 模式需把 token 放在 config 檔，不透過環境變數傳遞；未啟動" >&2
    exit 1
  fi
  core_env=(env -u HERDR_DISCORD_BOT_TOKEN -u DISCORD_BOT_TOKEN -u HC_SOCKET -u HC_SESSION
    HERDR_BRIDGE_RUNTIME=core "HERDR_PLUGIN_CONFIG_DIR=$bridge_config_dir" "HERDR_PLUGIN_STATE_DIR=$bridge_state_dir")
  [[ -z "${HC_SOCKET+x}" ]] || core_env+=("HC_SOCKET=$HC_SOCKET")
  [[ -z "${HC_SESSION+x}" ]] || core_env+=("HC_SESSION=$HC_SESSION")
  if [[ "$mode" == -r ]]; then
    echo "Installing local dependencies..."
    npm ci
    echo "Building local bridge..."
    npm run build
  elif [[ ! -f dist/src/index.js ]]; then
    echo "Core bridge build missing; run scripts/run.sh --core -r." >&2
    exit 1
  fi
  if status_output="$(core_status 2>&1)"; then
    core_status_valid "$status_output" || { echo "Invalid Core server status: $status_output" >&2; exit 1; }
  else
    if ! core_server_absent "$status_output"; then
      echo "$status_output" >&2
      exit 1
    fi
    echo "Core server is not running; starting..."
    herdr-core server start
    ready=0
    deadline=$((SECONDS + 10))
    while [[ "$SECONDS" -lt "$deadline" ]]; do
      if status_output="$(core_status 2>&1)"; then
        core_status_valid "$status_output" || { echo "Invalid Core server status: $status_output" >&2; exit 1; }
        ready=1
        break
      elif ! core_server_absent "$status_output"; then
        echo "$status_output" >&2
        exit 1
      fi
      sleep 0.2
    done
    if [[ "$ready" != 1 ]]; then
      echo "Core server did not become ready within 10 seconds: $status_output" >&2
      exit 1
    fi
  fi
  core_list="$(herdr-core ls --json --all)"
  printf '%s' "$core_list" | jq -e '(.terminals | type == "array") and all(.terminals[]; (.address | type == "string") and (.state == "live" or .state == "finished"))' >/dev/null || { echo "Invalid Core terminal list; no terminal was started." >&2; exit 1; }
  existing=""
  while IFS= read -r terminal; do
    address="$(printf '%s' "$terminal" | jq -r '.address')"
    # ls may use compact records that omit labels; get is read-only. Never
    # interpret omitted ownership metadata as proof there is no bridge.
    if ! printf '%s' "$terminal" | jq -e '.labels | type == "object"' >/dev/null; then
      terminal="$(herdr-core get "$address" --json)"
    fi
    printf '%s' "$terminal" | jq -e --arg address "$address" '.address == $address and .state == "live" and (.labels | type == "object")' >/dev/null || { echo "Could not verify Core terminal $address; no terminal was started." >&2; exit 1; }
    if printf '%s' "$terminal" | jq -e --arg project "$project_dir" '.labels["bridge.role"] == "discord-bridge" and .labels["bridge.project"] == $project' >/dev/null; then
      existing="${existing}${address} "
    fi
  done < <(printf '%s' "$core_list" | jq -c '.terminals[] | select(.state == "live")')
  if [[ -n "$existing" ]]; then
    echo "Existing Core bridge terminal: $existing" >&2
    echo "Stop it explicitly before starting another bridge. No terminals were changed." >&2
    exit 1
  fi
  run_result="$(herdr-core run --json --bg --no-parent --no-notify \
    --cwd "$project_dir" --label bridge.role=discord-bridge \
    --label bridge.backend=core --label "bridge.project=$project_dir" \
    -- "${core_env[@]}" node "$project_dir/dist/src/index.js")"
  address="$(printf '%s' "$run_result" | jq -er '.address | select(type == "string" and length > 0)')" || { echo "Could not identify the new Core terminal; inspect Core before retrying." >&2; exit 1; }
  echo "Core bridge terminal: $address"
  exit 0
fi

case "$mode" in
  "")
    # A plugin linked from another checkout would keep running (and logging
    # in) that checkout; relink to this directory when the paths differ.
    linked_path="$(herdr plugin list 2>/dev/null | grep -F -e "$plugin_id " | sed -n 's/.*\[local:\(.*\)\].*/\1/p' | head -n 1 || true)"
    if [[ -n "$linked_path" && "$(cd -- "$linked_path" 2>/dev/null && pwd -P)" != "$(pwd -P)" ]]; then
      echo "Plugin is linked to $linked_path; relinking to $project_dir..."
      mode="-r"
      [[ -d node_modules ]] || npm ci
      npm run build
    else
      echo "Starting existing installed plugin..."
    fi
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
bridge_workspaces=()
while IFS= read -r workspace; do
  [[ -n "$workspace" ]] && bridge_workspaces+=("$workspace")
done < <(printf "%s" "$workspace_json" | jq -r '.result.workspaces[] | select(.label == "bridge" or .name == "bridge") | .workspace_id')
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
target_tabs=()
while IFS= read -r tab; do
  [[ -n "$tab" ]] && target_tabs+=("$tab")
done < <(printf "%s" "$tab_json" | jq -r --arg wk "$workspace_id" '.result.tabs[] | select(.workspace_id == $wk and .number == 1) | .tab_id')
if [[ ${#target_tabs[@]} != 1 ]]; then
  echo "Could not find exactly one tab 1 in workspace $workspace_id; no panes were closed." >&2
  exit 1
fi
tab_id="${target_tabs[0]}"
bridge_panes=()
while IFS= read -r pane; do
  [[ -n "$pane" ]] && bridge_panes+=("$pane")
done < <(printf "%s" "$panes_json" | jq -r --arg tab "$tab_id" '.result.panes[] | select(.tab_id == $tab and (.agent // "") == "" and (.label == "Discord bridge" or .terminal_title == "Discord bridge" or .terminal_title_stripped == "Discord bridge")) | .pane_id')
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
# Bash 3.2 treats an empty array expansion as unset under nounset.
# Check its length before expanding it (first startup has no bridge panes).
if [[ ${#bridge_panes[@]} -gt 0 ]]; then
  for pane_id in "${bridge_panes[@]}"; do
    echo "Closing bridge pane $pane_id..."
    herdr pane close "$pane_id"
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
  --env HERDR_BRIDGE_RUNTIME=herdr \
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
