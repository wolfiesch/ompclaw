# Development Rules

## Default Context

OmpClaw is a Bun/TypeScript gateway that gives authenticated Telegram and WebSocket clients access to a primary persistent Oh My Pi session plus one isolated quick-answer session. Preserve this one-process, two-OMP-child model: the main session owns interactive work and durable gateway state; the quick lane is explicitly routed, FIFO, and has no durable `GatewayStore` state beyond its own OMP session file.

## Architecture Boundaries

| Area | Responsibility |
| --- | --- |
| `src/gateway-app.ts` | Application lifecycle and dependency wiring |
| `src/gateway-core.ts` | Authenticated message and delivery boundary |
| `src/gateway-store.ts` | Durable SQLite state and conversation bindings |
| `src/rpc-*.ts` | OMP RPC process, protocol, client, prompt, and UI translation |
| `src/gateway-quicklane.ts` | Explicit quick-lane routing, lazy second child lifecycle, and FIFO queue |
| `src/transports/telegram/` | Telegram authentication, polling, formatting, and delivery |
| `src/transports/websocket/` | Local authenticated WebSocket protocol |
| `src/gateway-scheduler.ts` | Durable scheduled work and retry policy |
| `src/gateway-update*.ts` | Transactional update, activation, and rollback |

- Transport adapters authenticate and normalize traffic; they do not invoke OMP directly.
- `GatewayStore` owns durable state. Do not add parallel files or in-memory state for data that must survive restart.
- Secrets are resolved from environment-variable names in configuration and must not be inherited by the OMP child process.
- HTTP remains health-only. Do not add an unauthenticated application API.

## Code Quality

- Keep TypeScript strict and avoid `any`. Narrow unknown input through the existing type guards.
- Prefer small explicit interfaces at subsystem boundaries.
- Use ES `#private` fields for class internals.
- Use `node:` prefixes for Node built-ins and Bun APIs where they are clearer.
- Extend an existing gateway, RPC, transport, or store helper before creating a second implementation of the same behavior.
- Keep prompts and user-visible Telegram text centralized near the responsible renderer.
- Preserve deterministic and idempotent behavior across retries and process restarts.

## Verification

Run the narrowest relevant test during development. Before requesting review, run:

```sh
bun run check
```

For release or package-surface changes, also run:

```sh
bun run ci
```

Update `CHANGELOG.md` for user-visible changes. Never commit credentials, environment files, local databases, session state, package tarballs, or private paths.

## GitHub

Do not comment on issues or pull requests, create issues, publish packages, create releases, or merge pull requests unless the user explicitly asks. Keep pull requests focused on one observable outcome.
