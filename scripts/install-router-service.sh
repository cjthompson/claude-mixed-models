#!/bin/bash
set -e

# Determine the project root (parent of the scripts directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Detect the node binary
NODE_PATH=$(command -v node)
if [ -z "$NODE_PATH" ]; then
  echo "Error: node not found in PATH"
  exit 1
fi

# Path to the plist template and destination
PLIST_TEMPLATE="$SCRIPT_DIR/com.chris.claude-mixed-models-router.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.chris.claude-mixed-models-router.plist"

# Create LaunchAgents directory if it doesn't exist
mkdir -p "$HOME/Library/LaunchAgents"

if [ "$1" == "uninstall" ]; then
  echo "Uninstalling router service..."
  launchctl bootout "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null || true
  rm -f "$PLIST_DEST"
  echo "Router service uninstalled."
  exit 0
fi

# Install mode (default)
echo "Installing router service..."
echo "Project directory: $PROJECT_DIR"
echo "Node path: $NODE_PATH"

# Substitute placeholders and write to the destination
sed "s|%%PROJECT_DIR%%|$PROJECT_DIR|g; s|%%NODE_PATH%%|$NODE_PATH|g" "$PLIST_TEMPLATE" > "$PLIST_DEST"

# Load the service
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

echo "Router service installed and started."
echo ""
echo "To check status, run:"
echo "  launchctl print gui/\$(id -u)/com.chris.claude-mixed-models-router"
echo ""
echo "To view logs:"
echo "  tail -f $PROJECT_DIR/router.log"
echo "  tail -f $PROJECT_DIR/router.err.log"
echo ""
echo "To stop the service:"
echo "  launchctl stop gui/\$(id -u)/com.chris.claude-mixed-models-router"
echo ""
echo "To start the service:"
echo "  launchctl start gui/\$(id -u)/com.chris.claude-mixed-models-router"
echo ""
echo "To uninstall:"
echo "  scripts/install-router-service.sh uninstall"
