# Running the Router as a Persistent Service

By default, `npm run router` starts the router for the current session only. If you need the router (and the usage-stats dashboard) to run continuously — auto-restarting on crash and starting automatically after login — install the single orchestration launchd agent.

## Installation

1. Ensure your `.env` file is in the project root with all required keys:
   ```bash
   cp .env.example .env
   # Edit .env and fill in ANTHROPIC_API_KEY, MINIMAX_API_KEY, etc.
   ```

2. Run the install script:
   ```bash
   scripts/install-services.sh
   ```

   This will:
   - Detect your project directory and node binary
   - Create `~/Library/LaunchAgents/com.claude-mixed-models.stats.plist`
   - Load the service into launchd
   - Print status and log-viewing commands

3. Verify the service is running:
   ```bash
   launchctl print gui/$(id -u)/com.claude-mixed-models.stats
   ```

## Architecture: one service, three supervised children

There is a single launchd agent. `scripts/server.mjs` is the orchestrator; it
spawns and supervises three child processes, all with the same respawn +
signal-forward contract:

- `router/server.js`  — the HTTP router (binds `ROUTER_PORT`, default 8788)
- `stats/workers/batcher.mjs` — drains the events JSONL into SQLite
- `stats/workers/server.mjs`  — the stats dashboard HTTP server (binds `STATS_PORT`, default 8789)

Restarting the launchd agent (or letting `KeepAlive` do it for you) restarts
all three. Killing one child respawns only that one.

## Usage

Once installed, the service will:
- Start automatically when you log in (`RunAtLoad`)
- Restart automatically if the orchestrator exits (`KeepAlive`)
- Run the router in the background at `http://localhost:8788` (or your
  configured `ROUTER_PORT`) and the dashboard at
  `http://localhost:8789` (or `STATS_PORT`)

### View Logs

All three children share the orchestrator's stdio, so their output is
interleaved in two files:

```bash
tail -f <project>/stats/server.log
tail -f <project>/stats/server.err.log
```

### Stop the Service

```bash
launchctl stop gui/$(id -u)/com.claude-mixed-models.stats
```

### Start the Service

```bash
launchctl start gui/$(id -u)/com.claude-mixed-models.stats
```

### Uninstall

```bash
scripts/install-services.sh uninstall
```

This will unload the service and remove the plist file from
`~/Library/LaunchAgents/`.

## How It Works

The installation creates a **launchd user agent** — a macOS system feature
for running per-user background services. The plist file contains:

- **Label**: `com.claude-mixed-models.stats` (unique identifier)
- **ProgramArguments**: `%%NODE_PATH%% --env-file-if-exists=.env
  scripts/server.mjs` — the orchestrator, started with the absolute path
  to the Node binary so it runs under launchd's minimal PATH
- **WorkingDirectory**: Your project root (so relative `.env` loading works)
- **KeepAlive**: `true` (automatically restart on crash)
- **RunAtLoad**: `true` (start when you log in)
- **StandardOutPath** / **StandardErrorPath**: `stats/server.log` and
  `stats/server.err.log` in your project directory

The orchestrator in turn uses `process.execPath` (the absolute path of the
Node binary running it) when spawning its children — so the children
inherit the orchestrator's path resolution and don't need `node` on PATH.

This approach:
- Requires zero additional dependencies (no npm packages, no Docker, no process manager)
- Matches the project's philosophy of minimal tooling
- Is already used on your system by Dropbox, Google Updater, and Homebrew
- Provides crash recovery without manual intervention

## Why Not Other Options?

**Option: `tmux`** — Zero setup, visible logs, but no auto-restart and no boot-time start. Good for development, not for persistent services.

**Option: `pm2`** — Adds a global npm tool and complexity. `pm2 startup` generates a launchd plist under the hood anyway, so this is less direct than using launchd directly.

**Option: Docker** — Stateless container is overkill for a zero-dep local tool. Requires Docker Desktop running continuously. Much more complexity for no benefit on local.

**Option: `nohup`** — **Do not use this.** A `nohup` process binds `ROUTER_PORT` independently of the launchd service. If it survives a logout or restart, the launchd-managed router will crash with `EADDRINUSE` on every respawn — and until the orchestrator's recent respawn-cap fix, that produced 130k+ stack traces in `stats/server.err.log` and grew the file past 100 MB. There is no recovery path where both the `nohup` instance and the launchd service are healthy on the same port.

## Troubleshooting

**Service doesn't start?**
Check the error log:
```bash
tail -50 <project>/stats/server.err.log
```

**Port already in use?**
Change `ROUTER_PORT` (or `STATS_PORT`) in your `.env`, then restart the service.

**Node not found?**
The plist uses the absolute path that `command -v node` resolved to at
install time. If you've moved your Node install, re-run
`scripts/install-services.sh` to refresh the plist.

## Upstream URLs

The router forwards requests to configured upstream services using either `http:` or `https:` protocols — protocol detection and forwarding are handled transparently.

**Security note:** for any upstream configured with `auth: "bearer"` or `auth: "x-api-key"`, the router attaches that upstream's API key to every forwarded request. If such an upstream's base URL uses `http:` instead of `https:`, that key crosses the network in cleartext. Limit `http:` upstreams to loopback (`localhost`/`127.0.0.1`) or otherwise fully trusted networks — anything else should use `https:`. The router logs a one-time warning (without the secret itself) when it resolves a keyed upstream configured this way.

## Graceful Shutdown

Termination signals trigger the following shutdown sequence:

- **SIGTERM** and **SIGINT** (Ctrl+C, orchestrator stop, system shutdown) both initiate graceful shutdown. The router stops accepting new connections and drains all in-flight requests, allowing them to complete before exit.
- **Follow-up signal** (a second SIGTERM or SIGINT) forces immediate exit. This prevents indefinite hangs if graceful shutdown stalls.
