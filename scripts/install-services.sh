#!/bin/bash
set -e

# Installs (or uninstalls) the single launchd service for this project:
#   com.claude-mixed-models.stats  -> scripts/server.mjs (orchestrator
#                                    that supervises the router, the stats
#                                    batcher, and the stats HTTP server)

# Determine the project root (parent of the scripts directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Detect the node binary
NODE_PATH=$(command -v node)
if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found in PATH"
  exit 1
fi

# Services to manage, by launchd label. Each has a matching <label>.plist
# template. There is only one service: the orchestrator supervises the
# router and the two stats workers as child processes.
SERVICES=(
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
echo "Service installed and started."
echo ""
echo "Status:"
echo "  launchctl print gui/\$(id -u)/com.claude-mixed-models.stats"
echo ""
echo "Logs (orchestrator + all three supervised children, interleaved):"
echo "  tail -f $PROJECT_DIR/stats/server.log $PROJECT_DIR/stats/server.err.log"
echo ""
echo "Stop / start the service:"
echo "  launchctl stop  gui/\$(id -u)/com.claude-mixed-models.stats"
echo "  launchctl start gui/\$(id -u)/com.claude-mixed-models.stats"
echo ""
echo "Uninstall:"
echo "  scripts/install-services.sh uninstall"
