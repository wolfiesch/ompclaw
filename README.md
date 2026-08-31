# OmpClaw

[![CI](https://github.com/wolfiesch/ompclaw/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/wolfiesch/ompclaw/actions/workflows/ci.yml?query=branch%3Amain)
[![npm package](https://img.shields.io/badge/npm-ompclaw-CB3837?logo=npm)](https://www.npmjs.com/package/ompclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Status: Alpha.** OmpClaw is a Bun package for operators who need persistent [Oh My Pi](https://github.com/can1357/oh-my-pi) 17+ sessions reachable through Telegram and authenticated WebSocket clients. One RPC process remains the sole session owner and state writer. Optional Telegram topic sessions isolate context without launching another agent process per chat.

Use it when a trusted operator needs remote access to an OMP workspace without placing transport credentials in OMP configuration or handing clients an OMP process directly. Telegram and WebSocket are authenticated adapters around the same serialized runtime. HTTP is health-only.

- **Package:** [`ompclaw`](https://www.npmjs.com/package/ompclaw) `0.5.0`
- **Repository:** [`wolfiesch/ompclaw`](https://github.com/wolfiesch/ompclaw)
- **License:** [MIT](LICENSE)
- **Upstream provenance:** [TerrifiedBug/omp-telegram](https://github.com/TerrifiedBug/omp-telegram), preserved in [NOTICE](NOTICE)

## User quickstart

### Prerequisites

- [Bun](https://bun.sh/)
- `omp` 17.0.0 or newer, authenticated for the provider you intend to use
- A Telegram bot token if Telegram is enabled

Install the package:

```bash
bun add --global ompclaw
ompclaw --help
```

Create a token-free JSON configuration. Run the command from the OMP workspace you want the gateway to use, or replace the example workspace path with an absolute path.

```bash
mkdir -p ~/.config/ompclaw
cat > ~/.config/ompclaw/config.json <<'JSON'
{
  "workspace": "~/path/to/workspace",
  "stateDir": "~/.omp/agent/ompclaw",
  "profile": "ompclaw",
  "omp": {
    "command": "omp",
    "autoRestart": true
  },
  "transports": {
    "telegram": {
      "enabled": true,
      "account": "default",
      "tokenEnv": "TELEGRAM_BOT_TOKEN",
      "topicSessions": {
        "enabled": false,
        "createFromRoot": false
      }
    },
    "websocket": {
      "enabled": true,
      "hostname": "127.0.0.1",
      "port": 8787,
      "account": "local",
      "credentials": [
        {
          "tokenEnv": "OMPCLAW_WS_TOKEN",
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
cat > ~/.config/ompclaw/ompclaw.env <<'ENV'
TELEGRAM_BOT_TOKEN=replace-with-telegram-bot-token
OMPCLAW_WS_TOKEN=replace-with-a-long-random-websocket-token
ENV
chmod 600 ~/.config/ompclaw/ompclaw.env
```

Authorize the Telegram operator and the example local WebSocket identity. Set `TELEGRAM_USER_ID` to the numeric ID of the person you intend to authorize.

```bash
TELEGRAM_USER_ID=123456789
ompclaw telegram-allow "$TELEGRAM_USER_ID" \
  --config ~/.config/ompclaw/config.json
ompclaw principal-add local-operator \
  --config ~/.config/ompclaw/config.json
ompclaw identity-bind websocket local local-operator local-operator \
  --config ~/.config/ompclaw/config.json
```

The first command prints `Telegram user allowed as telegram:default:<numeric-user-id>`. The identity commands print the updated principal and binding.

Validate credentials, the SQLite store, Telegram reachability, and a short OMP RPC session before starting the gateway:

```bash
ompclaw doctor \
  --config ~/.config/ompclaw/config.json \
  --env-file ~/.config/ompclaw/ompclaw.env
```

When Telegram is enabled, successful output includes the bot identity, `Webhook: none (...)`, the OMP RPC protocol and session, and ends with:

```text
Doctor: ready
```

Start the foreground gateway:

```bash
ompclaw run \
  --config ~/.config/ompclaw/config.json \
  --env-file ~/.config/ompclaw/ompclaw.env
```

The process owns the OMP session until it receives `SIGINT` or `SIGTERM`. Telegram starts long polling. The WebSocket endpoint accepts authenticated connections at `ws://127.0.0.1:8787/`; `GET /healthz` returns `{"status":"ok"}`.

To install it as a user service instead, use the same validated files:

```bash
ompclaw service-install \
  --config ~/.config/ompclaw/config.json \
  --env-file ~/.config/ompclaw/ompclaw.env
```

The command reports `Installed and started <manager> service: <path>`. It installs launchd label `com.ompclaw` on macOS or user systemd unit `ompclaw.service` on Linux.

## What the gateway provides

- One authenticated OMP RPC process with serialized session switching, streamed assistant updates, and a final response routed only to the active authenticated conversation.
- OMP commands for steering, follow-up, abort, models, thinking, session controls, queue policy, compaction, retries, subagents, history, branching, exports, and login.
- Telegram long polling with durable update checkpoints and an SQLite-backed inbound work queue, concise mobile presentation, voice transcription, message editing, buttons, file intake, reactions, topics, and interactive OMP UI.
- Optional per-topic OMP sessions with persistent conversation bindings and authorized root-message topic creation.
- An authenticated versioned WebSocket protocol with client identity and conversation address derived from configured credential metadata, not client-supplied fields.
- SQLite-backed principals, transport identities, conversation bindings, OMP session checkpointing, inbound deduplication, UI state, durable scheduled jobs, and legacy Telegram migration markers.
- Optional unattended automation with one-shot and cron schedules, explicit timezone support, bounded retries, restart recovery, per-principal ownership, and natural-language job control through OMP host tools.
- Optional experimental Mnemopi memory and auto-learn capture in OmpClaw-owned state. Inherited desktop skills are refreshed into a read-only snapshot, while gateway-created managed skills and memory remain isolated in the named OMP profile.

Read the [operator guide](docs/guide.md) for configuration, migration, operations, and security boundaries. Read the [RPC and transport reference](docs/rpc-service.md) for the command and protocol matrix.

## Contributors

Package installation above is for operators. Source checkout, development conventions, and verification commands are intentionally separate in [CONTRIBUTING.md](CONTRIBUTING.md).

## License and notice

`ompclaw` is MIT licensed. It includes and adapts work from TerrifiedBug's MIT-licensed `omp-telegram`; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
