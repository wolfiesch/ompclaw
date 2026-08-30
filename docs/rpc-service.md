# Standalone OMP RPC service

[Back to the quick start](../README.md#standalone-omp-rpc-service)

The standalone service turns one Telegram conversation into a persistent OMP
session. It runs OMP as a supervised child process in `rpc-ui` mode instead of
embedding the agent SDK.

```text
Telegram Bot API
        |
        v
omp-telegram-rpc
  allowlist and pairing
  update deduplication
  streaming and files
  approvals and questions
  launchd or systemd
        |
        | JSONL over stdin/stdout
        v
omp --mode rpc-ui --resume <exact-session>
        |
        v
OMP profile, skills, rules, tools, MCP, and models
```

## Requirements

- OMP 17.0.0 or newer
- Bun 1.3 or newer
- A Telegram bot from [@BotFather](https://t.me/BotFather)
- One immutable numeric Telegram user ID

A bot token can have only one active long poller. Use a separate token for each
machine or stop every other extension daemon, Hermes gateway, and `getUpdates`
consumer before starting this service.

## Install

```bash
bun add --global omp-telegram
omp-telegram-rpc --help
```

Create a private environment file:

```bash
mkdir -p ~/.config/omp-telegram
touch ~/.config/omp-telegram/rpc.env
chmod 600 ~/.config/omp-telegram/rpc.env
```

Add literal `KEY=VALUE` entries. The loader does not execute the file, expand
shell expressions, or override variables already present in the process.

```dotenv
TELEGRAM_BOT_TOKEN=123456:replace-me
TELEGRAM_ALLOWED_USERS=123456789
```

`TELEGRAM_ALLOWED_USERS` accepts comma or whitespace separated numeric IDs. RPC
mode requires exactly one operator. If the state directory has not been paired,
the first valid ID is imported into `access.json`.

If the ID is not known, omit `TELEGRAM_ALLOWED_USERS`, start the service, and
send the bot a normal message. It returns a short code. Pair it on the host:

```bash
omp-telegram-rpc pair <code> --env-file ~/.config/omp-telegram/rpc.env
```

You can also configure the ID directly:

```bash
omp-telegram-rpc allow 123456789 --env-file ~/.config/omp-telegram/rpc.env
```

## Choose the OMP profile

RPC mode defaults to the named profile `telegram`. Named OMP profiles isolate
sessions, runtime databases, environment files, MCP state, and native OMP
configuration from the default profile.

Use `--inherit-harness` when the remote agent should start with the default
profile's capabilities. The setup links these read-mostly directories:

- `skills`, `rules`, `commands`, `agents`, `docs`, and `bin`

It copies the initial instruction and configuration files when the destination
does not already exist:

- `AGENTS.md`, `RULES.md`, `SYSTEM.md`, `WATCHDOG.md`, `APPEND_SYSTEM.md`
- `config.yml`, `mcp.json`, `models.yml`, and `ssh.json`

It never links hooks or extensions and never copies `.env`, credentials,
sessions, blobs, or SQLite databases. Existing files in the named profile are
never overwritten. Rerunning the flag only fills missing entries.

For the smallest remote attack surface, omit `--inherit-harness` and add only the
skills, MCP servers, and rules needed by the service.

If the copied configuration uses an OMP auth broker, add
`--auth-broker-token-file ~/.omp/auth-broker.token` to `doctor`, `run`, and
`service-install`. The token file must be owner-only. Its value is passed only
to the OMP child environment and is not copied into the profile or service
definition.

## Validate before starting

`doctor` authenticates to Telegram, rejects webhook conflicts, starts OMP RPC,
negotiates protocol v2 when available, requests session state, and exits. It does
not invoke a model or print the bot token.

```bash
omp-telegram-rpc doctor \
  --env-file ~/.config/omp-telegram/rpc.env \
  --cwd ~/Projects \
  --profile telegram \
  --inherit-harness
```

Run in the foreground for the first Telegram exchange:

```bash
omp-telegram-rpc run \
  --env-file ~/.config/omp-telegram/rpc.env \
  --cwd ~/Projects \
  --profile telegram \
  --inherit-harness
```

Stop it with `Ctrl-C` after `/status` and a normal prompt work from Telegram.

## Install as a user service

The installer preserves the exact command options used at installation. The bot
token stays in the private environment file rather than the service definition.

```bash
omp-telegram-rpc service-install \
  --env-file ~/.config/omp-telegram/rpc.env \
  --cwd ~/Projects \
  --profile telegram \
  --inherit-harness
```

On macOS this writes and bootstraps:

```text
~/Library/LaunchAgents/com.omp.telegram.rpc.plist
```

Logs are written under the configured state directory:

```text
~/.omp/agent/telegram-rpc/logs/stdout.log
~/.omp/agent/telegram-rpc/logs/stderr.log
```

On Linux it writes and enables:

```text
~/.config/systemd/user/omp-telegram-rpc.service
```

Remove the service with:

```bash
omp-telegram-rpc service-uninstall
```

## Telegram commands

| Command | Behavior |
| --- | --- |
| `/status` | Session ID/name, model, reasoning, queue, context, tool, subagent, and UI state |
| `/stop` | Abort the active OMP agent run |
| `/new` | Start a new OMP session and persist its exact path |
| `/steer <text>` | Interrupt the active run with a correction |
| `/followup <text>` | Queue a follow-up after the current work |
| `/compact [focus]` | Compact context, optionally with custom instructions |
| `/model [provider/id]` | List or select models |
| `/thinking [level]` | Show or set reasoning effort |
| `/fast [on|off]` | Show or toggle fast mode |
| `/queue [...]` | Inspect or set steering, follow-up, and interrupt modes |
| `/stats` | Request OMP session statistics |
| `/todos` | Show OMP todo phases |
| `/subagents` | Show active and recent subagents |
| `/commands` | List slash commands discovered by OMP |
| `/history [count]` | Show recent user and assistant messages |
| `/branch [entry-id]` | List branch points or branch from an exact entry |
| `/name <name>` | Set the session name |
| `/handoff [instructions]` | Create a fresh handoff session |
| `/switch <session-path>` | Switch to an exact local session path |
| `/export` | Export the session to HTML and attach it in Telegram |
| `/retry <on|off|stop>` | Configure or abort automatic retry |
| `/autocompact <on|off>` | Configure automatic context compaction |
| `/login [provider]` | Show providers or start the RPC login flow |
| `/help` | Show the Telegram command menu |
| `/whoami` | Show numeric chat and user IDs |

Other slash commands reported by OMP are passed through to the session. RPC
`bash` is excluded by default because it provides an additional direct command
surface beyond normal agent tool approval. Add `--allow-rpc-bash` only for a
trusted single-user deployment; this exposes `/shell` and `/abortbash`.

## Interactive OMP UI

The service translates the RPC UI contract instead of automatically approving
requests:

| OMP request | Telegram surface |
| --- | --- |
| `confirm` | Confirm and Cancel buttons bound to the operator, chat, and message |
| `select` | One button per option |
| `input` | Force-reply message correlated to the operator and chat |
| `editor` | Force-reply message with the suggested text |
| `notify` | Telegram message |
| `open_url` | URL button plus provider instructions |
| `setStatus`, `setWidget`, `setTitle` | Stored and shown by `/status` |
| `cancel` or timeout | Controls removed and a cancellation response returned to OMP |

Callbacks from another sender, chat, topic, or message are rejected. Every
pending interaction receives a response during shutdown so the OMP child cannot
remain blocked on an abandoned Telegram control.

## Streaming, queueing, and subagents

Assistant text uses Telegram native message drafts in private chats when the Bot
API supports them. Other chats use an edited preview. The preview is finalized
into one regular message per terminal agent turn. MarkdownV2 failures retry as
plain text.

A normal message received while OMP is streaming follows the access setting
`deliverAs`, which defaults to `followUp`. `/steer` always requests a correction
and `/followup` always requests queued work. One live OMP session has one active
Telegram conversation target; a different authorized chat cannot take over
until the run finishes.

The bridge subscribes to OMP subagent progress and exposes current state through
`/subagents` and `/status`. Subagents remain owned by the same OMP session.

## Files and voice

- Photos are passed to OMP as image content and retained in the inbox.
- Image documents are passed as image content and local attachment paths.
- Other documents, audio, video, stickers, and voice notes are stored as local
  attachment paths in the structured Telegram prompt.
- Individual downloads are limited to 20 MiB.
- The inbox is pruned after 7 days and oldest-first above 250 MiB.
- Outbound files are restricted by the same path and size checks as extension
  mode. Transport state files and lock files cannot be sent.

Optional voice transcription uses the existing no-shell argv array in
`access.json`, with `{file}` replaced by the inbox path. It has a two-minute
runtime limit and a 1 MiB output limit.

## Agent-initiated Telegram tools

OMP receives three host tools:

- `telegram_send`: send text and checked local files
- `telegram_react`: react to a Telegram message
- `telegram_ask`: ask free-text, single-select, or multi-select questions

Explicit destinations still pass the configured private-chat allowlist. Host
tool cancellation aborts pending Telegram sends, uploads, reactions, and
questions.

## Persistence and recovery

The default transport state root is:

```text
~/.omp/agent/telegram-rpc/
```

| Path | Purpose |
| --- | --- |
| `access.json` | Numeric owner, delivery settings, and pairing requests |
| `rpc-state.json` | Exact OMP session path/ID and last handled Telegram update |
| `rpc-runtime.lock` | One service process per state root |
| `bot.lock` | One poller per state root |
| `inbox/` | Quarantined inbound attachments |
| `exports/` | Session HTML exports |
| `logs/` | launchd output and error logs |

State files use owner-only permissions. Updates are processed serially. The last
completed Telegram update ID is persisted so updates already handled before a
restart are not delivered again.

If OMP exits unexpectedly, the bridge tells the operator, closes the active
stream, and restarts the child with bounded backoff. The exact persisted session
file is resumed. A process crash cannot resume an interrupted tool invocation;
OMP resumes the conversation state and the operator can continue or retry.

## Security model

Telegram input is remote untrusted input with the full authority of the selected
OMP profile and workspace. The bridge enforces transport identity; OMP rules and
tool approvals enforce action authority.

Code-enforced defaults:

- Numeric Telegram IDs only, with one paired operator
- Private chats only; group policy is rejected at startup
- Default-deny pairing and allowlists
- Callback binding to sender, chat, topic, and control message
- Bot token and transport environment paths removed from the OMP child
- Credential files must be regular, owner-only files and cannot be symlinks
- Interactive confirmations preserved through RPC
- Direct RPC bash disabled
- One live session writer and two process locks
- Attachment size, retention, and outbound path checks
- Exact-session persistence with atomic mode-`0600` state writes

Operational requirements:

- Keep credential files mode `0600`; the runtime rejects broader permissions.
- Use a dedicated bot token for each machine.
- Select a workspace whose files the remote operator is allowed to access.
- Review inherited rules, skills, MCP servers, helper binaries, and workspace
  authority before using `--inherit-harness` on a server.
- Use dedicated provider credentials on a VPS. Do not copy a complete personal
  credential database to another machine.

## Troubleshooting

**`409 Conflict: terminated by other getUpdates request`**

Another process is polling with the same bot token. Stop the extension daemon,
Hermes gateway, or second RPC service, or issue a separate bot token.

**`Telegram webhook is configured`**

Delete the webhook through a Bot API client that reads the protected environment
file, then rerun `doctor`. Do not place a real bot token in a command argument,
URL, shell history, or log.

**The service restarts but Telegram is silent**

Run `omp-telegram-rpc doctor` with the same options, then inspect the service log.
Confirm that the environment file path is absolute and readable after login.

**The remote session has no skills or MCP servers**

A named profile is isolated by design. Reinstall with `--inherit-harness` or add
only the required profile-local assets under:

```text
~/.omp/profiles/<name>/agent/
```

**The exact session does not resume**

Inspect `rpc-state.json` and confirm the saved session file still exists. An
explicit `--resume <path>` takes precedence over the persisted path.
