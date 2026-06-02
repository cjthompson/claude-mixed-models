#!/usr/bin/env bash
set -euo pipefail
set -a; source "$(dirname "$0")/../.env"; set +a

export ANTHROPIC_BASE_URL="http://localhost:${PROXY_PORT:-8787}"
export ANTHROPIC_AUTH_TOKEN="${MINIMAX_API_KEY}"
export ANTHROPIC_MODEL="${MINIMAX_MODEL:-MiniMax-M2.5}"

echo "Launching Claude Code -> proxy -> MiniMax as model=${ANTHROPIC_MODEL}"
claude
