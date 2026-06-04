# Changelog

## 2026-06-03

### Tasks
- expose `MiniMax-M2.7` as a cheaper MiniMax option via the `minimax-m2.7` alias
- drop the `claude-` prefix from MiniMax aliases (`claude-minimax` → `minimax`, `claude-minimax-m2.7` → `minimax-m2.7`) — verified unnecessary for caching, and shorter to type at the `/model` prompt
- trim low-value fields from REQ/RES log lines (`method`, `url`, `route`, `user` dropped) and color the value part of `key=value` so a `tail -f` makes routing, status, and token shape visible at a glance (#observability, #logging)
- abbreviate numeric values in the log line (`1.2k`, `10.2k`, `1.5M`)

## 2026-06-02

### Tasks
- colorize log lines by user session_id (#observability, #logging)
- explore options to have the router run as a persistent service
