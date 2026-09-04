# OmpClaw

[![CI](https://github.com/wolfiesch/ompclaw/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/wolfiesch/ompclaw/actions/workflows/ci.yml?query=branch%3Amain)
[![npm](https://img.shields.io/npm/v/ompclaw?logo=npm&label=npm)](https://www.npmjs.com/package/ompclaw)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Status: Alpha.** OmpClaw is an authenticated Telegram and WebSocket gateway for operators who need remote access to one persistent [Oh My Pi](https://github.com/can1357/oh-my-pi) session. It keeps the main session, gateway state, and transport boundary under one process while giving trusted operators a durable mobile control surface.

Use it when you want to work with an OMP workspace from Telegram or a local authenticated WebSocket client without giving either transport direct access to OMP. Telegram and WebSocket are authenticated adapters around the same serialized runtime. HTTP is health-only.

- **Package:** [`ompclaw`](https://www.npmjs.com/package/ompclaw) `0.12.0`
- **Repository:** [`wolfiesch/ompclaw`](https://github.com/wolfiesch/ompclaw)
- **License:** [MIT](LICENSE)

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

From the OMP workspace you want to control, run the guided Telegram setup:

```bash
ompclaw setup
```

The command reads the BotFather token without echoing it, validates the bot and webhook state, and creates private default configuration and environment files without replacing existing ones. When its listener is ready, it prints the bot's `https://t.me/<botusername>` deep link. Open that link, send the bot a direct message, and complete the local pairing command that setup prints.

The pairing journey stays in one Telegram card as it moves through approval, rejection, expiry, retry, and connected Home access. Pairing codes expire after ten minutes, are shown only on the gateway host, and are never stored in plaintext. Successful setup runs `doctor` and ends with:

```text
Doctor: ready
```

Use `ompclaw setup --install-service` on the first run to install the verified configuration as a launchd or user-systemd service. Local approval remains separate from Telegram.

### Manual configuration

Use this path when enabling WebSocket, automation, or non-default OMP settings. Create a token-free JSON configuration. Run the command from the OMP workspace you want the gateway to use, or replace the example workspace path with an absolute path.

```bash
mkdir -p ~/.config/ompclaw
cat > ~/.config/ompclaw/config.json <<'JSON'
{
  "workspace": "~/path/to/workspace",
  "stateDir": "~/.omp/agent/ompclaw",
  "profile": "ompclaw",
  "omp": {
    "command": "omp",
    "autoRestart": true,
    "busyInputMode": "steer",
    "autonomyMode": "inherit"
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
      "port": 7788,
      "account": "local",
      "credentials": [
        {
          "tokenEnv": "OMPCLAW_WEBSOCKET_TOKEN",
          "subject": "local-operator",
          "channel": "local"
        }
      ]
    }
  },
  "automation": {
    "enabled": true
  },
  "quickLane": {
    "enabled": true
  }
}
JSON
```

### OMP approval policy

`omp.autonomyMode` defaults to `inherit`, which preserves OMP's existing approval-mode resolution. OmpClaw generates no approval flag in this mode, so existing raw `omp.args` remain supported.

Set an explicit mode when the gateway should generate the OMP tool approval policy:

- `autopilot` generates `--approval-mode yolo`.
- `balanced` generates `--approval-mode write`.
- `review` generates `--approval-mode always-ask`.

To prevent conflicting policies, an explicit mode rejects raw `--approval-mode VALUE` and `--approval-mode=VALUE` entries in `omp.args`. Autonomy mode governs prompts before OMP uses tools. It does not make genuine user decisions, including authorization, publication, or other consequential actions.

Telegram Home displays the active mode and provides an interactive selector. Autonomy can also be changed at runtime with `/autonomy <mode>`.

Put token values only in a private environment file. The values below are placeholders, not usable credentials.

```bash
cat > ~/.config/ompclaw/ompclaw.env <<'ENV'
TELEGRAM_BOT_TOKEN=replace-with-telegram-bot-token
OMPCLAW_WEBSOCKET_TOKEN=replace-with-a-long-random-websocket-token
ENV
chmod 600 ~/.config/ompclaw/ompclaw.env
```

When the gateway is running, an unknown user can pair without stopping the service: send the bot a direct message, copy the short-lived pairing code from its card, and run the local approval command shown in that reply:

```bash
ompclaw pairing-approve ABCD2345 \
  --config ~/.config/ompclaw/config.json
```

The bot confirms approval in the same chat, updates the pairing journey, and opens Home for the user's next message. If the gateway is stopped, `ompclaw pairing-listen` provides the bootstrap listener and prints the code and approval command only on the gateway host.

Authorize the example local WebSocket identity separately:

```bash
ompclaw principal-add local-operator \
  --config ~/.config/ompclaw/config.json
ompclaw identity-bind websocket local local-operator local-operator \
  --config ~/.config/ompclaw/config.json
```

Validate credentials, the SQLite store, Telegram reachability, and a short OMP RPC session before starting the gateway:

```bash
ompclaw doctor \
  --config ~/.config/ompclaw/config.json \
  --env-file ~/.config/ompclaw/ompclaw.env
```

Start the foreground gateway:

```bash
ompclaw run \
  --config ~/.config/ompclaw/config.json \
  --env-file ~/.config/ompclaw/ompclaw.env
```

The process owns the main OMP session until it receives `SIGINT` or `SIGTERM`. Telegram starts long polling. The WebSocket endpoint accepts authenticated connections at `ws://127.0.0.1:7788/`; `GET /healthz` returns `{"status":"ok"}`.

To install it as a user service instead, use the same validated files:

```bash
ompclaw service-install \
  --config ~/.config/ompclaw/config.json \
  --env-file ~/.config/ompclaw/ompclaw.env
```

The command reports `Installed and started <manager> service: <path>`. It installs launchd label `com.ompclaw` on macOS or user systemd unit `ompclaw.service` on Linux.

## What the gateway provides

- **One durable main session, plus an explicit quick-answer lane.** The primary OMP child remains the only persistent session owner. `/quick <question>` lazily starts an isolated second child for concise, unrelated questions. Quick requests are FIFO and never steer or modify the main task. While a task is working, its Telegram card can arm one plain-text quick question with **Quick ask**.
- **A durable Telegram Home control surface.** Home presents `Ready` with the current session, model, reasoning, and Fast controls. During work it changes to `Working`, shows the active task and current step, and offers Open task, Quick ask, and Stop. Context details, auto-compaction, queue size, and session identifiers live under More.
- **Decision and picker cards that settle in place.** OMP prompts appear as correlated Telegram controls for confirmations, choices, text input, and editors. Model selection is provider-first and paginated. Old cards visibly show their approved, denied, expired, or replaced state instead of lingering as active controls.
- **Searchable commands and skills.** `/commands` offers ranked command and skill results with durable recent choices, paginated picker cards, and private or group-scoped native menus. Telegram inline mode provides the same discovery flow after enabling inline queries for the bot in BotFather.
- **Actionable task outcomes.** Telegram task cards show active work and final outcomes. The task timeline records task, tool, terminal, and restart-interruption events, while failure cards explain the problem in plain language and offer retry, bounded details, history, and fresh-start controls.
- **Reply-aware, native Telegram delivery.** Deep replies retain quoted text, external-origin metadata, and useful descriptions for captionless media. Outgoing attachments use Telegram's native audio, voice note, video, animation, photo, document, and supported media-album methods when their media type is identifiable.
- **Humanized schedules and agent-authored watches.** The Schedules surface renders common cron rules and next runs in local language, supports pause, resume, run now, edit, and confirmed deletion, and retains durable retry state. With automation enabled, OMP can author conversation-bound `ompclaw_watch` jobs for recurring check-and-notify work. See [Ask your agent to watch things](docs/guide.md#ask-your-agent-to-watch-things).
- **Authenticated transport boundaries and durable state.** Telegram identities and WebSocket credentials resolve to server-side principals before work enters the session. SQLite persists bindings, inbound deduplication, controls, task outcomes, scheduled jobs, and session checkpoints. Telegram topic sessions can keep separate transcripts while the gateway still serializes access.
- **Transactional self-update.** An opt-in update flow stages one exact commit from a fixed trusted checkout, verifies an isolated build, completes the active Telegram response, and switches through an external supervisor. Failed startup automatically rolls back and records the outcome for later delivery. Read [Transactional self-update](docs/guide.md#transactional-self-update) before enabling it.

Read the [operator guide](docs/guide.md) for configuration, migration, operations, and security boundaries. Read the [RPC and transport reference](docs/rpc-service.md) for the command and protocol matrix.

## Contributors

Package installation above is for operators. Source checkout, development conventions, and verification commands are intentionally separate in [CONTRIBUTING.md](CONTRIBUTING.md).

## Pull request verification

Pull requests that change only `README.md`, `CHANGELOG.md`, `LICENSE`, documentation files ending in `.md`, `.rst`, or `.txt` under `docs/`, or a top-level `.github/*.md` file use the lightweight CI lane. The classifier still scans added public text for credentials, private paths, session identifiers, and private hosts. Source, manifest, workflow, executable documentation, mixed, empty, or ambiguous changes use the full lane.

Branch protection requires the stable `verify` check. Before merging, confirm that `verify` succeeded for the current pull request head and that all review threads are resolved.

## License

`ompclaw` is MIT licensed; see [LICENSE](LICENSE).
