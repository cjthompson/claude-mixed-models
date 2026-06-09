#!/bin/bash
set -e

# Installs (or uninstalls) the launchd services for this project:
#   com.claude-mixed-models.router  -> router/server.js
#   com.claude-mixed-models.stats   -> scripts/server.mjs (stats orchestrator)

# Determine the project root (parent of the scripts directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Detect the node binary
NODE_PATH=$(command -v node)
if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found in PATH"
  exit 1
fi

# Services to manage, by launchd label. Each has a matching <label>.plist template.
SERVICES=(
  "com.claude-mixed-models.router"
  "com.claude-mixed-models.stats"
)

LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
mkdir -p "$LAUNCH_AGENTS"

if [ "$1" == "uninstall" ]; then
  for label in "${SERVICES[@]}"; do
    dest="$LAUNCH_AGENTS/$label.plist"
    echo "Uninstalling $label..."
    launchctl bootout "gui/$(id -u)" "$dest" 2>/dev/null || true
    rm -f "$dest"
  done
  echo "Services uninstalled."
  exit 0
fi

# Install mode (default)
echo "Project directory: $PROJECT_DIR"
echo "Node path: $NODE_PATH"
echo ""

for label in "${SERVICES[@]}"; do
  template="$SCRIPT_DIR/$label.plist"
  dest="$LAUNCH_AGENTS/$label.plist"
  echo "Installing $label..."
  # Re-bootout first so re-running the installer picks up template changes.
  launchctl bootout "gui/$(id -u)" "$dest" 2>/dev/null || true
  sed "s|%%PROJECT_DIR%%|$PROJECT_DIR|g; s|%%NODE_PATH%%|$NODE_PATH|g" "$template" > "$dest"
  launchctl bootstrap "gui/$(id -u)" "$dest"
done

echo ""
echo "Services installed and started."
echo ""
echo "Status:"
echo "  launchctl print gui/\$(id -u)/com.claude-mixed-models.router"
echo "  launchctl print gui/\$(id -u)/com.claude-mixed-models.stats"
echo ""
echo "Logs:"
echo "  tail -f $PROJECT_DIR/router.log $PROJECT_DIR/router.err.log"
echo "  tail -f $PROJECT_DIR/stats/server.log $PROJECT_DIR/stats/server.err.log"
echo ""
echo "Stop / start a service (e.g. stats):"
echo "  launchctl stop  gui/\$(id -u)/com.claude-mixed-models.stats"
echo "  launchctl start gui/\$(id -u)/com.claude-mixed-models.stats"
echo ""
echo "Uninstall both:"
echo "  scripts/install-services.sh uninstall"
