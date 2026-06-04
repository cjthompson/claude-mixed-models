#!/usr/bin/env bash
set -euo pipefail

# Point Claude Code at the router and otherwise leave auth alone. We deliberately
# do NOT set ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL: Claude Code
# should use your normal subscription credential and default models, which the router
# passes straight through to Anthropic. Only the `minimax` alias is diverted
# to MiniMax (the router holds the MiniMax key itself, loaded from .env).
unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_MODEL

export ANTHROPIC_BASE_URL="http://localhost:${ROUTER_PORT:-8788}"

echo "Launching Claude Code -> router on ${ANTHROPIC_BASE_URL}"
echo "  unmapped models (your normal Opus/Sonnet) -> Anthropic subscription (passthrough)"
echo "  minimax                                   -> MiniMax-M3      (default)"
echo "  minimax-m2.7                              -> MiniMax-M2.7    (cheaper)"
exec claude
