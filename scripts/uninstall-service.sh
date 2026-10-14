#!/usr/bin/env bash
# Stop cli-bridge and remove it from login items.
set -euo pipefail

# claude-api is this project's old name; remove a service installed under it too.
NAMES=(cli-bridge claude-api)

case "$(uname -s)" in
Darwin)
  for NAME in "${NAMES[@]}"; do
    LABEL="com.$(whoami).$NAME"
    PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
    [ -f "$PLIST" ] || continue
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed $LABEL"
  done
  ;;
Linux)
  for NAME in "${NAMES[@]}"; do
    UNIT="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$NAME.service"
    [ -f "$UNIT" ] || continue
    systemctl --user disable --now "$NAME.service" 2>/dev/null || true
    rm -f "$UNIT"
    echo "Removed $NAME.service"
  done
  systemctl --user daemon-reload
  ;;
*)
  echo "Nothing to remove on this system."
  ;;
esac
