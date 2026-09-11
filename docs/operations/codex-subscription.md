# Codex subscription through the local Responses ingress

This guide configures Codex to use its OpenAI/ChatGPT subscription through the
local router. The router accepts the Responses API on a configurable HTTP
ingress,
passes the authenticated request to the subscription upstream, and records
provider-neutral usage statistics locally.

## Configure the Codex profile

Create a user-owned current-format profile at
`$CODEX_HOME/codex-subscription.config.toml` (normally
`~/.codex/codex-subscription.config.toml`):

```toml
model_provider = "codex-subscription-router"

[model_providers.codex-subscription-router]
name = "Codex subscription through claude-mixed-models"
base_url = "http://127.0.0.1:8788/openai"
wire_api = "responses"
requires_openai_auth = true
```

Use this user-level profile rather than the repository's `.codex/config.toml`.
Do not use the obsolete `[profiles.*]` or top-level `profile =` forms.

The profile above is for a Codex client on the same machine. For a client on a
trusted LAN, use `http://<router-lan-ip>:8788/openai` as `base_url` instead and
ensure the router's `ROUTER_HOST` permits that interface.

Select it explicitly for a session or command:

```bash
codex --profile codex-subscription
codex exec --profile codex-subscription "your deliberately small request"
```

The profile URL ends at `/openai` because Codex appends
`/responses`. The router strips `/openai`, then joins the remaining path to
the configured subscription base. The default composition is:

```text
http://127.0.0.1:8788/openai/responses
  -> https://chatgpt.com/backend-api/codex/responses
```

A LAN client composes the same path with the router's address:

```text
http://<router-lan-ip>:8788/openai/responses
  -> https://chatgpt.com/backend-api/codex/responses
```

## Operate the stack

1. Copy and edit the environment file:

   ```bash
   cp .env.example .env
   ```

   Use `ROUTER_PORT=8788` unless you change the profile's `base_url` to the
   matching port. `ROUTER_HOST=0.0.0.0` accepts LAN clients; set it to a
   narrower bind address when appropriate. `OPENAI_SUBSCRIPTION_BASE_URL` is a
   non-secret upstream override; it must use HTTPS unless its host is
   loopback. When unset, the tracked route default is
   `https://chatgpt.com/backend-api/codex`. `STATS_EVENTS_FILE` controls the
   JSONL event buffer and `STATS_DB_PATH` controls the SQLite database.

2. Start the full foreground stack with:

   ```bash
   npm start
   ```

   For a login-persistent macOS service, install and start the orchestrator:

   ```bash
   scripts/install-services.sh
   ```

   The service `com.claude-mixed-models.stats` supervises the router, batcher,
   and dashboard. `npm run router` alone only forwards requests; it does not
   run the batcher or dashboard.

3. Check Codex authentication without inspecting credential files:

   ```bash
   codex login status
   ```

   If it reports that you are not logged in, run `codex login` and rerun the
   status command. Make a deliberately small real request only after accepting
   that it consumes subscription usage.

4. Verify the service and usage path:

   ```bash
   launchctl print gui/$(id -u)/com.claude-mixed-models.stats
   curl -sf "http://127.0.0.1:8789/api/stats?range=24h"
   npm run stats -- --range=24h
   ```

   After the request, identify the new model row and its token counters in the
   dashboard or CLI. Counts depend on the request and upstream response; this
   guide does not prescribe an exact count.

## Credential and observability boundaries

- `requires_openai_auth = true` tells Codex to use its OpenAI/ChatGPT
  authentication. Do not configure `env_key`, an inline bearer token, or
  command-backed provider authentication for this provider. The current Codex
  manual says `env_key` is ignored when `requires_openai_auth` is enabled.
- The repository never reads or logs `$CODEX_HOME/auth.json`. Codex owns that
  file. Codex authorization headers travel from the Codex client to the router;
  the router uses passthrough authentication and forwards them to the
  subscription upstream. They are not logged or stored by this repository.
- The ingress is plain HTTP. This is acceptable only on a trusted, segmented
  LAN. Do not expose port 8788 publicly; restrict it with a firewall. For an
  untrusted or shared network, put an HTTPS reverse proxy in front of the
  router. The subscription upstream must use HTTPS unless it is loopback.
- Console logs contain the model, upstream host, status, duration, and token
  summary. They do not contain request headers, request bodies, SSE content, or
  credentials.
- JSONL and SQLite event records contain `id`, `ts`, model and `real_model`,
  upstream host, status, duration, optional session ID, input/output/cache-read/
  cache-write counters, cache 5m/1h splits, and an internal thinking/reasoning
  counter. Rollups additionally contain `bucket_start`, `model`, `upstream`,
  `requests`, `errors`, token/cache/thinking counters, and `p50_ms`/`p95_ms`.
  These records do not contain request content, SSE data, headers, or
  credentials.
- The stats endpoints are user-local. The router ingress can be local or LAN
  reachable according to `ROUTER_HOST`; the subscription upstream must use
  HTTPS unless it is loopback.

## Rollback

To stop using the subscription route, stop invoking Codex with
`--profile codex-subscription`. If desired, restore or remove the
user-owned profile file, restore any `ROUTER_HOST`, `ROUTER_PORT`, or
`OPENAI_SUBSCRIPTION_BASE_URL` overrides in `.env`, and restart the service:

```bash
launchctl stop gui/$(id -u)/com.claude-mixed-models.stats
launchctl start gui/$(id -u)/com.claude-mixed-models.stats
```

Profile rollback does not require `codex logout`; do not use logout as a
profile rollback step. Do not delete the stats SQLite database.
