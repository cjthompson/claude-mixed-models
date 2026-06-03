# Running the Router as a Persistent Service

By default, `npm run router` starts the router for the current session only. If you need the router to run continuously — auto-restarting on crash and starting automatically after login — you can install it as a macOS user service using `launchd`.

## Installation

1. Ensure your `.env` file is in the project root with all required keys:
   ```bash
   cp .env.example .env
   # Edit .env and fill in ANTHROPIC_API_KEY, MINIMAX_API_KEY, etc.
   ```

2. Run the install script:
   ```bash
   scripts/install-router-service.sh
   ```

   This will:
   - Detect your project directory and node binary
   - Create `~/Library/LaunchAgents/com.claude-mixed-models.router.plist`
   - Load the service into launchd
   - Print status and log-viewing commands

3. Verify the service is running:
   ```bash
   launchctl print gui/$(id -u)/com.claude-mixed-models.router
   ```

## Usage

Once installed, the router will:
- Start automatically when you log in
- Restart automatically if it crashes
- Run in the background at `http://localhost:8788` (or your configured `ROUTER_PORT`)

### View Logs

Standard output:
```bash
tail -f <project>/router.log
```

Errors:
```bash
tail -f <project>/router.err.log
```

### Stop the Service

```bash
launchctl stop gui/$(id -u)/com.claude-mixed-models.router
```

### Start the Service

```bash
launchctl start gui/$(id -u)/com.claude-mixed-models.router
```

### Uninstall

```bash
scripts/install-router-service.sh uninstall
```

This will unload the service and remove the plist file from `~/Library/LaunchAgents/`.

## How It Works

The installation creates a **launchd user agent** — a macOS system feature for running per-user background services. The plist file contains:

- **Label**: `com.claude-mixed-models.router` (unique identifier)
- **ProgramArguments**: The exact node command from `npm run router` (node with `--env-file-if-exists=.env`)
- **WorkingDirectory**: Your project root (so relative `.env` loading works)
- **KeepAlive**: `true` (automatically restart on crash)
- **RunAtLoad**: `true` (start when you log in)
- **StandardOutPath** / **StandardErrorPath**: Log files in your project directory

This approach:
- Requires zero additional dependencies (no npm packages, no Docker, no process manager)
- Matches the project's philosophy of minimal tooling
- Is already used on your system by Dropbox, Google Updater, and Homebrew
- Provides crash recovery without manual intervention

## Why Not Other Options?

**Option: `tmux`** — Zero setup, visible logs, but no auto-restart and no boot-time start. Good for development, not for persistent services.

**Option: `pm2`** — Adds a global npm tool and complexity. `pm2 startup` generates a launchd plist under the hood anyway, so this is less direct than using launchd directly.

**Option: Docker** — Stateless container is overkill for a zero-dep local tool. Requires Docker Desktop running continuously. Much more complexity for no benefit on local.

**Option: `nohup`** — Simplest possible (`nohup npm run router >> router.log 2>&1 &`), but does not survive reboots or crashes.

## Troubleshooting

**Service doesn't start?**
Check the error log:
```bash
tail -50 <project>/router.err.log
```

**Port already in use?**
Change `ROUTER_PORT` in your `.env`, restart the service, and update your Claude Code configuration.

**Node not found?**
Ensure `node` is in your PATH and try the install script again.
