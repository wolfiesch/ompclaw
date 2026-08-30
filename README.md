# omp-gateway

[![CI](https://github.com/wolfiesch/omp-gateway/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/wolfiesch/omp-gateway/actions/workflows/ci.yml?query=branch%3Amain)
[![npm package](https://img.shields.io/badge/npm-omp--gateway-CB3837?logo=npm)](https://www.npmjs.com/package/omp-gateway)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Status: Alpha.** `omp-gateway` is a Bun package for operators who need one persistent [Oh My Pi](https://github.com/can1357/oh-my-pi) 17+ session reachable through Telegram and authenticated WebSocket clients. It deliberately has one session owner and one state writer, rather than creating separate agent processes for each chat or client.

Use it when a single trusted operator needs remote access to an OMP workspace without placing transport credentials in OMP configuration or handing clients an OMP process directly. Telegram and WebSocket are adapters around the same authenticated session. HTTP is health-only.

- **Package:** [`omp-gateway`](https://www.npmjs.com/package/omp-gateway) `0.2.0`
- **Repository:** [`wolfiesch/omp-gateway`](https://github.com/wolfiesch/omp-gateway)
- **License:** [MIT](LICENSE)
- **Upstream provenance:** [TerrifiedBug/omp-telegram](https://github.com/TerrifiedBug/omp-telegram), preserved in [NOTICE](NOTICE)

## User quickstart

### Prerequisites

- [Bun](https://bun.sh/)
- `omp` 17.0.0 or newer, authenticated for the provider you intend to use
- A Telegram bot token if Telegram is enabled

Install the package:

```bash
bun add --global omp-gateway
omp-gateway --help
```

Create a token-free JSON configuration. Run the command from the OMP workspace you want the gateway to use, or replace the example workspace path with an absolute path.

```bash
mkdir -p ~/.config/omp-gateway
cat > ~/.config/omp-gateway/config.json <<'JSON'
{
  "workspace": "~/path/to/workspace",
  "stateDir": "~/.omp/agent/gateway",
  "profile": "gateway",
  "omp": {
    "command": "omp",
    "autoRestart": true
  },
  "transports": {
    "telegram": {
      "enabled": true,
      "account": "default",
      "tokenEnv": "TELEGRAM_BOT_TOKEN"
    },
    "websocket": {
      "enabled": true,
      "hostname": "127.0.0.1",
      "port": 8787,
      "account": "local",
      "credentials": [
        {
          "tokenEnv": "OMP_GATEWAY_WS_TOKEN",
          "subject": "local-operator",
          "channel": "local"
        }
      ]
    }
  },
  "automation": {
    "enabled": true
  },
  "learning": {
    "enabled": true,
    "autoCapture": true,
    "memoryModel": "online"
  }
}
JSON
```

Put token values only in a private environment file. The values below are placeholders, not usable credentials.

```bash
cat > ~/.config/omp-gateway/gateway.env <<'ENV'
TELEGRAM_BOT_TOKEN=replace-with-telegram-bot-token
OMP_GATEWAY_WS_TOKEN=replace-with-a-long-random-websocket-token
ENV
chmod 600 ~/.config/omp-gateway/gateway.env
```

Authorize the Telegram operator and the example local WebSocket identity. Set `TELEGRAM_USER_ID` to the numeric ID of the person you intend to authorize.

```bash
TELEGRAM_USER_ID=123456789
omp-gateway telegram-allow "$TELEGRAM_USER_ID" \
  --config ~/.config/omp-gateway/config.json
omp-gateway principal-add local-operator \
  --config ~/.config/omp-gateway/config.json
omp-gateway identity-bind websocket local local-operator local-operator \
  --config ~/.config/omp-gateway/config.json
```

The first command prints `Telegram user allowed as telegram:default:<numeric-user-id>`. The identity commands print the updated principal and binding.

Validate credentials, the SQLite store, Telegram reachability, and a short OMP RPC session before starting the gateway:

```bash
omp-gateway doctor \
  --config ~/.config/omp-gateway/config.json \
  --env-file ~/.config/omp-gateway/gateway.env
```

When Telegram is enabled, successful output includes the bot identity, `Webhook: none (...)`, the OMP RPC protocol and session, and ends with:

```text
Doctor: ready
```

Start the foreground gateway:

```bash
omp-gateway run \
  --config ~/.config/omp-gateway/config.json \
  --env-file ~/.config/omp-gateway/gateway.env
```

The process owns the OMP session until it receives `SIGINT` or `SIGTERM`. Telegram starts long polling. The WebSocket endpoint accepts authenticated connections at `ws://127.0.0.1:8787/`; `GET /healthz` returns `{"status":"ok"}`.

To install it as a user service instead, use the same validated files:

```bash
omp-gateway service-install \
  --config ~/.config/omp-gateway/config.json \
  --env-file ~/.config/omp-gateway/gateway.env
```

The command reports `Installed and started <manager> service: <path>`. It installs launchd label `com.omp.gateway` on macOS or user systemd unit `omp-gateway.service` on Linux.

## What the gateway provides

- One authenticated OMP RPC session with streamed assistant updates and a final response routed only to the active authenticated conversation.
- OMP commands for steering, follow-up, abort, models, thinking, session controls, queue policy, compaction, retries, subagents, history, branching, exports, and login.
- Telegram long polling with durable update checkpoints, message editing, buttons, file intake, reactions, topics, and interactive OMP UI.
- An authenticated versioned WebSocket protocol with client identity and conversation address derived from configured credential metadata, not client-supplied fields.
- SQLite-backed principals, transport identities, conversation bindings, OMP session checkpointing, inbound deduplication, UI state, durable scheduled jobs, and legacy Telegram migration markers.
- Optional unattended automation with one-shot and cron schedules, explicit timezone support, bounded retries, restart recovery, per-principal ownership, and natural-language job control through OMP host tools.
- Optional experimental Mnemopi memory and auto-learn capture in gateway-owned state. Inherited desktop skills are refreshed into a read-only snapshot, while gateway-created managed skills and memory remain isolated in the named OMP profile.

Read the [operator guide](docs/guide.md) for configuration, migration, operations, and security boundaries. Read the [RPC and transport reference](docs/rpc-service.md) for the command and protocol matrix.

## Contributors

Package installation above is for operators. Source checkout, development conventions, and verification commands are intentionally separate in [CONTRIBUTING.md](CONTRIBUTING.md).

## License and notice

`omp-gateway` is MIT licensed. It includes and adapts work from TerrifiedBug's MIT-licensed `omp-telegram`; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
