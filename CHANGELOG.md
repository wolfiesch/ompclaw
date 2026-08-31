# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Persist queued, running, tool, completed, stopped, failed, and interrupted task states; expose recent tasks with `/tasks`; and render authenticated stop controls in Telegram.
- Stream partial responses through native Telegram drafts with a typing fallback when the Bot API does not support drafts.

### Fixed

- Deliver complete Telegram responses when a streamed final answer exceeds one message.

## 0.3.2 (2026-08-30)

### Fixed

- Bind generated user services to OmpClaw's installed executable instead of relying on the caller's `PATH`.

## 0.3.1 (2026-08-30)

### Fixed

- Generate systemd `WorkingDirectory` values with unit-file escapes instead of quotes, allowing the Linux user service to start.

## 0.3.0 (2026-08-30)

### Changed

- Renamed the product, npm package, CLI, repository, service identifiers, default profile, state paths, environment prefix, and OMP host tools from `omp-gateway` to OmpClaw.
- The new package and command are `ompclaw`; the renamed surfaces intentionally provide no legacy aliases.

### Migration

- Stop and uninstall the old service before installing `com.ompclaw` or `ompclaw.service`.
- Move the prior state directory to `~/.omp/agent/ompclaw`, rename `gateway.sqlite` and `gateway.lock` to `ompclaw.sqlite` and `ompclaw.lock`, change the old default `gateway` profile to `ompclaw`, and rename `OMP_GATEWAY_*` environment variables to `OMPCLAW_*`. Keep an explicitly configured custom profile unchanged.

## 0.2.0 (2026-08-30)

### Added

- Durable principal-scoped one-shot and cron jobs with timezone validation, bounded retry, restart recovery, Telegram command controls, and OMP host tools.
- Opt-in gateway-scoped Mnemopi memory and experimental auto-learn skill capture.
- Read-only inherited harness snapshots that refresh desktop skills, rules, commands, agents, docs, and binaries without sharing runtime state or credentials.

### Changed

- Scheduled and interactive work now share one explicitly serialized OMP runtime and delivery context.
- Gateway configuration and operator documentation exposed automation, learning, isolation, and at-least-once delivery boundaries.

## 0.1.0 (2026-08-30)

### Alpha

- Initial alpha release of the authenticated Telegram and WebSocket gateway, persistent OMP RPC runtime, SQLite state store, interactive UI bridge, host tools, and user-service installers.
