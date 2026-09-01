# Contributing to OmpClaw

Thank you for helping improve `ompclaw`. Keep changes small, reviewable, and focused on one observable behavior.

## Local workflow

This project uses Bun 1.3.14. Install dependencies from the lockfile:

```sh
bun install --frozen-lockfile
```

While developing, run the narrowest relevant test first. For example:

```sh
bun test src/gateway-config.test.ts
```

Before opening a pull request, run the complete local check:

```sh
bun run check
```

### Telegram scenario and remote checks

Run the deterministic Telegram scenario layer without credentials:

```sh
bun run test:harness
```

This exercises synthetic Telegram updates through the real adapter, authenticated gateway core, SQLite state, application dispatch, and captured Bot API delivery.

Render the deterministic mobile control surfaces as credential-free JSON:

```sh
bun run test:telegram:ui
```

`src/dev/telegram-ui-scenario.test.ts` is the golden contract for Home, reasoning, scheduled-job, and active-task rendering. It catches copy, status, and keyboard-layout drift without contacting Telegram.

Offload the complete check to an SSH-accessible macOS worker with Bun installed:

```sh
bun run test:remote -- --host m1-worker
```

The dispatcher copies the working tree into a new `/tmp/ompclaw-check.*` directory, omits Git metadata, dependencies, environment files, databases, and session logs, clears Telegram credential variables, runs `bun run check`, and removes the remote directory. It does not use a Telegram token or provider authentication.

For an explicit live Telegram transport canary, configure `OMPCLAW_TEST_TELEGRAM_TOKEN` and `OMPCLAW_TEST_TELEGRAM_CHAT_ID` in the process environment, then run:

```sh
bun run test:telegram:live
```

Use a dedicated private test bot and test chat. The command refuses the configured production `TELEGRAM_BOT_TOKEN`, refuses bots with an active webhook, performs one visible send, typing action, and edit, and prints a receipt. Add `-- --delete` to remove the canary message after the check. Never point the canary at the product bot.

Do not commit generated package tarballs, local databases, session state, environment files, or credentials. Start configuration from `config.example.json`; it contains only credential environment variable names, never credential values.

## Architecture boundaries

One gateway process owns one persistent OMP session. Preserve that ownership model:

- The CLI loads token-free configuration, resolves transport credentials from the environment, and starts the application.
- `GatewayApplication` orders startup and shutdown around the single OMP RPC runtime.
- `GatewayCore` is the authenticated message and delivery boundary. Transport adapters must not invoke OMP directly.
- Telegram and WebSocket adapters authenticate and normalize their transport-specific traffic. The WebSocket listener is local by default, and HTTP remains health-only.
- `GatewayStore` owns durable principals, transport identities, message deduplication, checkpoints, and conversation bindings.
- Transport secrets must remain outside JSON configuration and must not be inherited by the OMP child process.

Avoid changing an adjacent boundary to solve a local problem. Extend the responsible layer and update the focused contract tests for the behavior you change.

## Security reports

Do not open a public issue for a vulnerability, exposed credential, authorization bypass, or unsafe transport behavior. Follow the reporting route in [SECURITY.md](SECURITY.md). Ordinary bugs and feature proposals belong in the repository issue forms.

## Release provenance

Releases are created only by the trusted GitHub Actions workflow in `wolfiesch/ompclaw`. A release tag must be exactly `v` followed by the package version, and that workflow publishes npm provenance through trusted publishing.

Do not publish from a local checkout, add registry tokens to repository files, or claim that an unpublished version has been released. Keep lockfile changes intentional and include their reason in the pull request.
