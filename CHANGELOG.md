# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Added

- Redesign Telegram Home control surface with distinct Idle ("🟢 Ready", hero session title, combined model and reasoning settings, and direct state-exposing Fast toggle) and Busy ("🟡 Working · <elapsed>", active task title, current step, Open task, and single-tap Stop) states, moving context details, auto-compaction, queue size, and session identifiers under a More sub-surface.
- Humanize scheduled job rules and next runs with local natural-language cron formatting ("Every day at 9:00 AM", "Every weekday at 9:00 AM", "Every 30 minutes") with exotic-expression fallback, and relative run times with friendly timezone names ("in 45 min", "Today at 9:00 AM Pacific", "Tomorrow at 9:00 AM Pacific").
- Add Schedule Detail surface with state-exposing Pause/Resume, Run now, Edit, and a dedicated confirmation card for Schedule Delete that settles in-message.
- Replace Telegram approval prompts with in-message decision cards that visibly settle approved, denied, or expired requests; long OMP clarifications use numbered choices and a correlated typed “Other answer”.
- Add paginated Telegram model cards that choose a provider before its models, retain the current selection, and return to the same message on navigation.
- Add prompt-backed task-card controls for immediate instructions and queued follow-ups.
- Replace plain `/tasks` output with an actionable task timeline that persists task, tool, terminal, and restart-interruption events and can retry stopped, failed, or interrupted work.
- Add table-driven native Telegram media dispatch for outbound attachments, sending audio (`sendAudio`), voice notes (`sendVoice`), video (`sendVideo`), animations (`sendAnimation`), photos (`sendPhoto`), and documents (`sendDocument`) by MIME type and file extension, with native `sendMediaGroup` grouping for visual and audio sets and automatic fallback to documents for mixed media batches.

- Add a single durable Telegram pairing journey card that updates in place for approval, rejection, expiry, retry, connected Home access, and dismissible command examples.
- Print the bot's `https://t.me/<botusername>` deep link during successful interactive setup.
- Refresh the Telegram Bot API description and short description at setup and gateway startup, plus a derivable friendly name without making profile API failures fatal.

### Changed

- Rename user-facing controls and commands: Jobs → Schedules, Autonomy → Permissions, and New session → New chat.

### Fixed

- Always finalize a Telegram task with a visible outcome when OMP omits its terminal assistant text, while retaining the existing safeguard that prevents an empty response from activating an armed update.

## 0.11.0 (2026-09-03)

### Added

- Add Telegram Deep Reply Context: extract Telegram Bot API 7.0+ text quotes, external reply origin metadata, and synthesized media descriptions for captionless replies.
- Correlate message replies to semantic view task cards, decision prompts, and turn results as structured targets (`task_card`, `decision`, `turn_result`, `interaction`) in the OMP prompt envelope.
- Preserve inbound reply context and target metadata across composed multipart ingress fragments.
- Add dynamic runtime autonomy switching via `/autonomy <mode>` and interactive Telegram Home choice view, recycling the OMP RPC child with session resume.
- Add category-specific emoji cues to streamed tool activity and task-card status text.

### Changed

- Decompose OMP RPC runtime into focused rpc-prompt and rpc-commands modules.

### Fixed

- Initialize SQLite storage with WAL journal mode and busy timeout to avoid database locking under concurrent operations.
- Forward the configured startup readiness budget to the OMP RPC runtime across all gateway startup configurations.
- Retain transactional update outcome records across service activations.

## 0.10.1 (2026-09-01)

### Fixed

- Include missing production modules (`gateway-ingress-composer`, `gateway-views`, `rpc-semantic-views`, and `transports/telegram/semantic-views`) in the published npm package files list.
- Normalize scheduler timer typing across Node and Bun environments.

## 0.10.0 (2026-09-01)

### Added

- Add `omp.autonomyMode`: `inherit` preserves existing OMP approval resolution; `autopilot`, `balanced`, and `review` generate `yolo`, `write`, and `always-ask`, respectively, with read-only Telegram Home state.
- Add a reusable credential-free Telegram scenario harness, a guarded live Bot API canary for dedicated test bots, and an ephemeral SSH dispatcher for running the complete check on a macOS worker without transferring credentials or state.
- Add guided first-use Telegram setup with private credential files, stale-update-safe discovery, expiring local pairing codes, explicit identity confirmation, and optional service installation after `doctor` succeeds.
- Let the running Telegram gateway issue bounded private-chat pairing challenges and deliver approval confirmation without exposing the bot token to local approval commands.

### Changed

- Replace regex-based Telegram formatting with parsed MarkdownV2 rendering, block-aware message splitting, stable fenced-code chunks, plain-text fallback, and grouped photo albums.
- Turn Telegram Home into a durable single-message control center with compact keyboards, state-backed task and result views, scheduled-job actions, stale-control refresh, and principal ownership checks.
- Acknowledge both voice and video-note transcription with a reaction or a message fallback, and expose the supported RPC command surface through one grouped registry.

## 0.9.2 (2026-09-01)

### Changed

- Refuse new transactional release builds when the state filesystem has less than 4 GiB free, and report actionable storage headroom through `doctor`.

## 0.9.1 (2026-09-01)

### Fixed

- Isolate RPC runtime tests from the concrete client module so test file order cannot leak a mock into Linux release builds.

## 0.9.0 (2026-09-01)

### Added

- Add opt-in transactional self-update from a fixed trusted checkout, with isolated release builds, post-response activation, an external service supervisor, startup readiness verification, automatic rollback, and post-restart result delivery.

### Fixed

- Serialize service installation with update activation, including attempts that disable updates, through the complete service-manager restart.

## 0.8.0 (2026-08-31)

### Changed

- Present active Telegram turns with a renewed typing indicator, one throttled activity card based on OMP intent, persistent commentary segments, and a source-linked final answer.
- Treat an ordinary message in the active conversation as an immediate correction by default, with configurable follow-up routing through `omp.busyInputMode`.

## 0.7.0 (2026-08-31)

### Changed

- Present Telegram turns as an ongoing conversation with immediate receipt reactions, source-linked Markdown responses, and task status that clears after successful completion.

### Fixed

- Deliver Telegram receipt reactions for every prompt outcome in lifecycle order per source message without allowing optional reaction retries to gate prompt dispatch, RPC frame processing, or completed-turn cleanup.

## 0.6.2 (2026-08-31)

### Fixed

- Fail Telegram startup when command registration exposes invalid bot credentials instead of reporting a healthy but unusable poller.
- Track, update, and remove every part of multipart control cards so status text and controls remain consistent.
- Retain and refresh old control-card chunks when Telegram no longer permits deleting them.
- Treat already-absent Telegram card messages as successfully removed so stale receipts cannot poison later updates.

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

- Initial alpha release of the authenticated Telegram and WebSocket gateway, persistent OMP RPC runtime, SQLite state store, interactive UI, host tools, and user-service installers.
