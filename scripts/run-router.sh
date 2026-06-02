#!/usr/bin/env bash
set -euo pipefail
set -a; source "$(dirname "$0")/../.env"; set +a

export ANTHROPIC_BASE_URL="http://localhost:${ROUTER_PORT:-8788}"
export ANTHROPIC_AUTH_TOKEN="router-local"
export ANTHROPIC_MODEL="${MAIN_MODEL:-claude-opus-4-8}"

echo "Launching Claude Code -> router (main model=${ANTHROPIC_MODEL})"
claude
