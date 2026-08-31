# Changelog

All notable changes to this project will be documented in this file.

## 0.6.1 (2026-08-31)

### Fixed

- Continue Telegram polling when optional command-menu registration fails.
- Decode queued attachment file URLs before inbox retention checks so encoded local paths remain protected.
- Split oversized interactive UI messages within Telegram's text limit and keep controls on the final part.

## 0.6.0 (2026-08-31)

### Changed

- Reimplement the Telegram transport as project-owned Bot API, delivery, formatting, inbox, and adapter modules while preserving the gateway's public transport contract.
- Package only the maintained transport modules and remove obsolete source-provenance artifacts.

### Fixed

- Validate malformed Telegram API envelopes without unchecked generic casts and preserve retry, cancellation, lock, attachment, topic, streaming, and interactive UI behavior behind focused contract tests.
- Preserve long OMP output for Telegram's multipart delivery path instead of rejecting it at the gateway boundary.
- Route native Telegram draft-stop events through authenticated `/stop`, reuse forum topics across retried updates, and migrate legacy poll offsets to account-scoped checkpoints.
- Propagate update-handler failures into bounded long-poll retries and drain in-flight update work before shutdown.

## 0.5.1 (2026-08-31)

### Fixed

- Retry bounded transient Telegram network and server failures so a completed OMP response is not dropped when final delivery is interrupted.

## 0.5.0 (2026-08-30)

### Added

- Add optional local voice transcription through stdout commands or isolated Whisper-style output directories.
- Add `/start` onboarding and a curated native Telegram command menu with advanced controls grouped under `/help`.

### Changed

- Present tool activity, task states, and controls in plain language, with Stop available only while work is active.
- Give Telegram turns a concise mobile response contract and require successful durable writes before acknowledging memory.
- Queue authenticated conversations behind the active OMP turn instead of requiring users to resend after a busy response.

### Fixed

- Persist full queued inbound requests before transport acknowledgement, retry dispatch failures without releasing deduplication claims, and replay pending work after restart.
- Resume scheduler-owned pending attempts through scheduler accounting, preserve queued attachment files during inbox cleanup, serialize session-mutating controls behind active work, and gate immediate RPC bash aborts on RPC bash being enabled.
- Retry poison entries behind newer queued work and retry post-dispatch bookkeeping without resubmitting successful prompts.
- Revalidate durable principals immediately before dispatch, preserve immediate controls during restart replay, and keep recovered prompts behind the startup gate until the transport core starts.

## 0.4.0 (2026-08-30)

### Added

- Add opt-in Telegram forum-topic sessions, including root-message topic creation and persisted topic-to-session routing.
- Persist queued, running, tool, completed, stopped, failed, and interrupted task states; expose recent tasks with `/tasks`; and render authenticated stop controls in Telegram.
- Add a native Telegram command menu, `/home` control center, and paginated model and reasoning pickers.
- Stream partial responses through native Telegram drafts with a typing fallback when the Bot API does not support drafts.

### Fixed

- Deliver complete Telegram responses when a streamed final answer exceeds one message.
- Wait for active turns before switching forum-topic sessions, preserve one shared session for non-topic conversations, and reset ambiguous pre-release topic bindings once on upgrade.

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
