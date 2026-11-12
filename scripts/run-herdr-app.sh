#!/usr/bin/env bash
# ISSUE-152: keep the XIM encoder's locale separate from the desktop session.
set -euo pipefail
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
  echo 'Usage: scripts/run-herdr-app.sh [herdr-app arguments...]'
  echo 'Linux X11: reuse/start ibus-herdr with en_US.UTF-8, then launch Herdr.'
  echo 'Close an existing Desktop window first if it used the normal ibus server.'
  exit 0
fi
command -v herdr-app >/dev/null || { echo 'herdr-app not found' >&2; exit 1; }
if [[ "$(uname -s)" != Linux || "${XDG_SESSION_TYPE:-}" != x11 ]]; then
  exec herdr-app "$@"
fi
[[ -n "${DISPLAY:-}" ]] || { echo 'DISPLAY is required for X11' >&2; exit 1; }
[[ "${XDG_RUNTIME_DIR:-}" == /* && -d "$XDG_RUNTIME_DIR" && -O "$XDG_RUNTIME_DIR" ]] || {
  echo 'An absolute, existing, user-owned XDG_RUNTIME_DIR is required' >&2; exit 1;
}
for tool in xprop flock locale nohup; do
  command -v "$tool" >/dev/null || { echo "$tool not found" >&2; exit 1; }
done
# A per-user lock serializes startup; never restart the ordinary ibus daemon.
exec 9>"$XDG_RUNTIME_DIR/herdr-ibus-x11.lock"
flock -w 10 9 || { echo 'Timed out waiting for Herdr XIM startup lock' >&2; exit 1; }
xim_ready() {
  local snapshot
  snapshot="$(xprop -root XIM_SERVERS)" || return 2
  [[ "$snapshot" =~ (^|[[:space:],])@server=ibus-herdr([[:space:],]|$) ]]
}
status=0
xim_ready || status=$?
[[ "$status" != 2 ]] || { echo 'Cannot query X11 XIM servers' >&2; exit 1; }
if [[ "$status" != 0 ]]; then
  ibus_x11="$(command -v ibus-x11 || true)"
  for candidate in /usr/libexec/ibus-x11 /usr/lib/ibus/ibus-x11; do
    if [[ -z "$ibus_x11" && -x "$candidate" ]]; then ibus_x11="$candidate"; break; fi
  done
  [[ -n "$ibus_x11" ]] || { echo 'ibus-x11 not found' >&2; exit 1; }
  env LC_ALL=en_US.UTF-8 locale charmap 2>/dev/null | grep -qx UTF-8 || {
    echo 'en_US.UTF-8 locale is unavailable' >&2; exit 1;
  }
  # Keep this bridge alive after Desktop exits. No --kill-daemon, no global changes.
  nohup env LC_ALL=en_US.UTF-8 "$ibus_x11" --server-name=ibus-herdr \
    9>&- </dev/null >"$XDG_RUNTIME_DIR/herdr-ibus-x11.log" 2>&1 &
  ready=0
  for ((attempt=0; attempt<50; attempt++)); do
    if xim_ready; then ready=1; break; fi
    sleep 0.1
  done
  [[ "$ready" == 1 ]] || {
    echo "Herdr XIM did not become ready; see $XDG_RUNTIME_DIR/herdr-ibus-x11.log" >&2
    exit 1
  }
fi
flock -u 9
exec 9>&-
exec env XMODIFIERS=@im=ibus-herdr herdr-app "$@"
