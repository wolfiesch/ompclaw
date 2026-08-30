# Changelog

All notable changes to this project will be documented in this file.

## 0.2.0 (2026-08-30)

### Added

- Durable principal-scoped one-shot and cron jobs with timezone validation, bounded retry, restart recovery, Telegram command controls, and OMP host tools.
- Opt-in gateway-scoped Mnemopi memory and experimental auto-learn skill capture.
- Read-only inherited harness snapshots that refresh desktop skills, rules, commands, agents, docs, and binaries without sharing runtime state or credentials.

### Changed

- Scheduled and interactive work now share one explicitly serialized OMP runtime and delivery context.
- Gateway configuration and operator documentation now expose automation, learning, isolation, and at-least-once delivery boundaries.

## 0.1.0 (2026-08-30)

### Alpha

- Initial alpha release of the authenticated Telegram and WebSocket gateway, persistent OMP RPC runtime, SQLite state store, interactive UI bridge, host tools, and user-service installers.
