# Operator guide

[Back to the README](../README.md)

`omp-gateway` runs one persistent OMP RPC session and exposes it through enabled, authenticated transport adapters. It is a gateway process, not an OMP extension and not a per-chat session launcher. Telegram and WebSocket clients feed the same OMP session.

## Before you start

Use the [user quickstart](../README.md#user-quickstart) for package installation, token-free configuration, private environment file creation, `telegram-allow`, `doctor`, and foreground or service startup.

The following operating assumptions are intentional:

- OMP is version 17.0.0 or newer and is already authenticated for the provider you intend to use.
- One process owns one gateway state directory and one OMP session.
- Every incoming transport identity must be bound to a local principal before it is admitted.
- A token authorizes a WebSocket credential only after that credential's identity resolves to a principal.
- Telegram uses Bot API long polling. Do not configure a webhook for the same bot token.
- WebSocket is intended to bind to loopback by default. The only HTTP route is the unauthenticated health response.

## Architecture and persistence

At startup the gateway acquires `gateway.lock` in `stateDir`, opens `gateway.sqlite`, resolves transport secrets, constructs the OMP runtime, starts OMP, then starts the transport adapters. If another process holds the gateway lock, startup stops before opening the database.

```text
Telegram long poller  ─┐
                       ├─ authenticated transport adapter ─┐
WebSocket client      ─┘                                    │
                                                            v
                                                 one OMP RPC session
                                                            │
                                                            v
                                        SQLite state and session checkpoint
```

The start order prevents an adapter or scheduler from accepting work before the OMP session is available. On shutdown, the scheduler stops first, then adapters stop before OMP, and the state store closes before the lock is released.

The SQLite database is `~/.omp/agent/gateway/gateway.sqlite` by default. A newly created database is private to its owner. It records:

| Data | Purpose |
| --- | --- |
| principals and transport identities | resolve an inbound identity to authorized local roles |
| conversation bindings | record the exact OMP session path associated with a transport address |
| adapter checkpoints | store the active OMP session file and Telegram update progress |
| inbound messages | deduplicate accepted transport messages |
| pending UI interactions | keep transport UI metadata until completion or expiry |
| migration markers | make legacy Telegram import idempotent |
| scheduled jobs | persist one-shot and cron automation, ownership, next run, retry, and outcome state |

SQLite uses foreign keys, full synchronous mode, and immediate transactions for the legacy import. Do not open the database for concurrent writes or share `stateDir` between gateway instances.

## Configuration reference

The configuration is a bounded JSON document. It must be a regular file, not a symlink, and must be no larger than 256 KiB. Unknown keys are rejected. Paths beginning with `~/` expand to the current user's home; relative paths resolve from the directory where the command is run.

The JSON document never contains a token value. It names environment variables that are read from the process environment or an `--env-file`.

### Top-level fields

| Field | Type and default | Meaning |
| --- | --- | --- |
| `workspace` | path, current directory | OMP working directory |
| `stateDir` | path, `~/.omp/agent/gateway` | gateway lock, SQLite database, inbox, exports, and checkpoints |
| `profile` | identifier, `gateway` | OMP profile passed to the RPC child |
| `omp` | object | OMP runtime settings |
| `transports` | object | enabled transport settings |
| `automation` | object | optional durable unattended job runner |
| `learning` | object | optional experimental gateway-scoped memory and managed-skill capture |

### `omp`

| Field | Type and default | Meaning |
| --- | --- | --- |
| `command` | string, `omp` | OMP executable |
| `model` | optional string | initial OMP model selection |
| `resume` | optional path | exact OMP session path used only when no persisted session checkpoint exists |
| `sessionDir` | optional path | OMP session directory |
| `configFiles` | string array, `[]` | OMP configuration files, passed in order |
| `args` | string array, `[]` | additional OMP arguments, passed in order |
| `authBrokerTokenFile` | optional path | private auth-broker token file passed to the OMP child |
| `allowRpcBash` | boolean, `false` | enables `/shell` and `/abortbash` in the gateway command surface |
| `inheritHarness` | boolean, `false` | requests inherited harness preparation in the RPC runtime configuration |
| `autoRestart` | boolean, `true` | restart an unexpectedly exited OMP child with bounded backoff |

`authBrokerTokenFile`, when used, must be private in the same way as the environment file. `allowRpcBash` changes the authority available through the gateway. Leave it disabled unless it is a deliberate operational choice.

### Durable automation

Automation is off by default. Enable it explicitly:

```json
{
  "automation": {
    "enabled": true,
    "pollIntervalMs": 1000,
    "retryDelayMs": 15000,
    "maxAttempts": 3
  }
}
```

| Field | Type and default | Meaning |
| --- | --- | --- |
| `enabled` | boolean, `false` | register scheduling host tools and start the durable dispatcher |
| `pollIntervalMs` | integer, `1000` | scan interval from 250 to 60000 milliseconds |
| `retryDelayMs` | integer, `15000` | base retry delay from 1000 to 3600000 milliseconds |
| `maxAttempts` | integer, `3` | maximum failed attempts from 1 to 10 before a one-shot job is disabled |

An authenticated operator can ask OMP to schedule a one-shot job at an ISO 8601 time with an explicit UTC offset, or a recurring cron job with an optional IANA timezone. OMP receives `gateway_schedule_job`, `gateway_update_job`, `gateway_list_jobs`, `gateway_set_job_enabled`, `gateway_delete_job`, and `gateway_run_job` host tools. The model never supplies a principal or delivery route. The gateway binds each job to the active server-derived principal, identity, and conversation.

Use `/jobs` to inspect your jobs, `/job_pause <id>` or `/job_resume <id>` to change dispatch, `/job_run <id>` to make a job due immediately, and `/job_delete <id>` to remove it. Job IDs are intentionally exact and principal-scoped.

The scheduler persists the next occurrence before dispatch. A restart recovers every due job from SQLite. Only one OMP turn runs at a time, so a scheduled job that finds the runtime busy is deferred without consuming an attempt. Other failures use bounded linear backoff. A one-shot job is disabled after success or after exhausting retries. A recurring job advances to its next cron occurrence after success or final failure. Job execution is at least once across process crashes, so prompts that mutate external systems should be idempotent.

Scheduled output and OMP interaction requests return to the conversation that created the job. Telegram can receive output while no inbound request is active. WebSocket jobs require the exact authenticated origin to be connected when delivery occurs.

### Experimental learning and profile isolation

Learning is off by default because OMP marks auto-learn as experimental and automatic capture consumes an extra model turn. A private single-operator setup can enable the full loop:

```json
{
  "omp": {
    "inheritHarness": true
  },
  "learning": {
    "enabled": true,
    "autoCapture": true,
    "minToolCalls": 5,
    "memoryModel": "online"
  }
}
```

| Field | Type and default | Meaning |
| --- | --- | --- |
| `enabled` | boolean, `false` | enable isolated Mnemopi memory, `learn`, and `manage_skill` |
| `autoCapture` | boolean, `false` | run OMP's private capture turn after an eligible stop |
| `minToolCalls` | integer, `5` | minimum tool calls before automatic capture, from 1 to 100 |
| `memoryModel` | string, `online` | memory extraction model: `online`, `qwen3-1.7b`, `llama3.2:3b`, `gemma-3-1b`, `qwen2.5-1.5b`, or `lfm2-1.2b` |

When enabled, the gateway writes a private generated OMP overlay at `stateDir/omp-learning.json` and stores Mnemopi data under `stateDir/memory`. `online` uses OMP's configured TINY role, then its small online fallback. The other values select local on-device memory models. The active conversation model remains independently selectable through `omp.model` or `/model`.

With `omp.inheritHarness: true`, each gateway start refreshes desktop `skills`, `rules`, `commands`, `agents`, `docs`, and `bin` into read-only snapshots inside the named gateway profile. Root policy and harness configuration files refresh atomically. Symlinked skill directories are materialized so the named profile never points back into the desktop profile. Secret and volatile paths such as `.env*`, dependency directories, virtual environments, logs, caches, and browser profiles are excluded.

OMP-managed skill creation and refinement write to the gateway profile's separate `managed-skills` directory. Gateway memory, managed skills, sessions, credentials, and databases stay isolated, while updated desktop harness content flows into the gateway on restart.

### Telegram transport

A Telegram object is required only when Telegram is configured:

```json
{
  "enabled": true,
  "account": "default",
  "tokenEnv": "TELEGRAM_BOT_TOKEN"
}
```

| Field | Meaning |
| --- | --- |
| `enabled` | whether to start this adapter |
| `account` | stable local account identifier used in identities and checkpoints |
| `tokenEnv` | environment variable containing the bot token; it must be `TELEGRAM_BOT_TOKEN` |

Authorizing a user is an explicit local database operation:

```bash
omp-gateway telegram-allow <your-numeric-telegram-user-id> \
  --config ~/.config/omp-gateway/config.json
```

It creates or updates an `operator` principal and binds the exact Telegram identity for the configured account. To use a custom principal or roles, create it with `principal-add` and bind the Telegram identity with `identity-bind`.

### WebSocket transport

The following loopback configuration is the recommended starting point:

```json
{
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
```

| Field | Meaning |
| --- | --- |
| `enabled` | whether to start the WebSocket server |
| `hostname` | server bind hostname; use `127.0.0.1` by default |
| `port` | integer from 0 to 65535; `0` lets Bun choose a port |
| `account` | stable local account identifier |
| `credentials` | non-empty list of credential metadata |
| `credentials[].tokenEnv` | environment variable holding the token; use an `OMP_GATEWAY_...` name |
| `credentials[].subject` | stable identity subject derived after authentication |
| `credentials[].channel` | stable delivery channel derived after authentication |
| `credentials[].thread` | optional stable delivery thread derived after authentication |

Credential metadata is configuration, not client input. Tokens are compared by hash. Each configured token and conversation origin must be unique, and one live connection is allowed for an origin. Bind each credential identity before clients can use it:

```bash
omp-gateway principal-add local-operator \
  --config ~/.config/omp-gateway/config.json
omp-gateway identity-bind websocket local local-operator local-operator \
  --config ~/.config/omp-gateway/config.json
```

## Secret environment file

Create the environment file outside the repository and make it mode `0600`:

```bash
cat > ~/.config/omp-gateway/gateway.env <<'ENV'
TELEGRAM_BOT_TOKEN=replace-with-telegram-bot-token
OMP_GATEWAY_WS_TOKEN=replace-with-a-long-random-websocket-token
ENV
chmod 600 ~/.config/omp-gateway/gateway.env
```

The loader accepts literal `KEY=VALUE` lines, optional `export ` prefixes, comments, and quoted values. Existing process variables take precedence over values in the file. On Unix-like systems it refuses an environment file that is a symlink, not a regular file, not owned by the current user, or readable by group or others.

Before launching OMP, the gateway removes Telegram and gateway transport secret variables from the OMP child environment. Do not rely on that filtering as a reason to store credentials in project files or OMP configuration.

## Start, validate, and service operation

Use `doctor` before the first start and whenever credentials or OMP configuration change:

```bash
omp-gateway doctor \
  --config ~/.config/omp-gateway/config.json \
  --env-file ~/.config/omp-gateway/gateway.env
```

`doctor` resolves all enabled transport secrets, opens the SQLite store, verifies Telegram's bot identity and the absence of a webhook when Telegram is enabled, starts a short OMP RPC child, requests session state, then stops that child. A successful run ends with `Doctor: ready`.

Run in the foreground during setup:

```bash
omp-gateway run \
  --config ~/.config/omp-gateway/config.json \
  --env-file ~/.config/omp-gateway/gateway.env
```

The process stops cleanly on `SIGINT` or `SIGTERM`. It starts the OMP session first, then the adapters.

For a persistent user service:

```bash
omp-gateway service-install \
  --config ~/.config/omp-gateway/config.json \
  --env-file ~/.config/omp-gateway/gateway.env
```

The installer requires both `--config` and `--env-file` as absolute regular-file paths, requires the environment file to be exactly mode `0600`, verifies that configured secrets resolve, and reports its manager and installed path. It uses launchd label `com.omp.gateway` on macOS and user systemd unit `omp-gateway.service` on Linux. The environment file is referenced by the service command rather than copied into the service definition.

Remove a user service with:

```bash
omp-gateway service-uninstall \
  --config ~/.config/omp-gateway/config.json
```

The command reports the stopped and removed service path. Stop the service before making manual database backups or state-directory copies.

### Health and logs

The WebSocket adapter exposes exactly one HTTP response:

```text
GET /healthz -> 200 {"status":"ok"}
```

It is a liveness endpoint, not an authenticated API, metrics endpoint, command endpoint, or reverse-proxy control plane. Unknown HTTP paths return `404`. The WebSocket upgrade is `GET /` with the WebSocket upgrade header.

Use service-manager logs and foreground stderr for gateway and OMP failures. Do not include environment file content, session exports, inbox attachment paths, or database rows in a public report.

## Crash recovery and exact-session resume

After an OMP state update and after each successful inbound turn, the gateway records OMP's current `sessionFile` in the `omp/session_file` checkpoint. On the next gateway start it resumes that exact path first. If no checkpoint exists, it uses `omp.resume` when configured. `/switch <exact session path>` asks OMP to switch to the exact path supplied by the operator.

If the OMP child exits unexpectedly and `omp.autoRestart` is true, the gateway notifies the active delivery context and retries startup with delays of 1, 2, 5, 10, then 30 seconds. `autoRestart: false` leaves the gateway offline after the exit.

The checkpoint allows a restarted gateway to resume a completed OMP session. It does not resume a partly executed prompt, an in-flight tool call, a transport connection, or a pending user interaction. Send a new message after recovery when the interrupted result matters.

## Migration from standalone omp-telegram RPC state

Migration is for state created by the old standalone `omp-telegram` RPC service. It is not an extension activation step and it does not reuse legacy pairing commands.

1. Stop the old standalone service so only one Telegram poller owns the bot token.
2. Create the new token-free gateway JSON and private environment file.
3. Locate the old standalone access-state JSON and RPC-state JSON. Keep backups outside source control.
4. Run the idempotent importer:

   ```bash
   omp-gateway migrate-telegram <legacy-access-state.json> <legacy-rpc-state.json> \
     --config ~/.config/omp-gateway/config.json
   ```

5. Run `telegram-allow` if you want to establish or replace the Telegram operator binding explicitly, then run `doctor` and start the gateway.

The importer reads only the two named JSON state files. It does not read or copy an old token environment file. In one SQLite transaction, it imports the legacy Telegram operator as an `operator` principal, binds its default Telegram identity, records the exact OMP session path for its conversation, and imports the Telegram update checkpoint when present. A migration marker makes subsequent invocations report that the state was already migrated.

## Transport behavior

### Telegram

Telegram uses long polling, per-account update checkpointing, and a per-account polling lock. It ignores replayed or already completed updates and advances the durable checkpoint only across the completed update prefix. A failed earlier update is not skipped by a later successful one.

Private chats and forum topics map to stable gateway conversation addresses. Incoming Telegram identity comes from the sender ID. Normal inbound content can include text, captions, reply metadata, supported media as private inbox files, and optional voice transcription when configured by the adapter. Images are passed to OMP as image input when readable; other attachment references are retained in the transport-message prompt.

Telegram supports assistant message creation and editing, reactions, attachments, threads, confirmation buttons, single and multi-select buttons, reply-based text/editor input, notifications, URL buttons, and rendered status surfaces. Interaction responses are bound to the original address and authorized principal. An expired, moved, or cross-user control is rejected.

### WebSocket

WebSocket is a versioned, authenticated transport. Connect to the configured endpoint, send an `authenticate` frame first, wait for `ready`, then send messages or UI responses. The server derives identity, account, channel, and optional thread from the credential configuration. A client cannot set those fields.

The server accepts a connection at `GET /` only after HTTP WebSocket upgrade. It requires authentication within 10 seconds by default. Invalid, missing, duplicate, or unbound credentials are rejected and the socket closes with a policy error. See the full frame contract in the [RPC and transport reference](rpc-service.md#websocket-protocol-v1).

## Operational limitations

- One gateway process owns one OMP session, one scheduler, and one SQLite writer. This is not a worker pool or a distributed multi-writer system.
- Interactive and scheduled work serialize through the same OMP runtime. A due job waits while another turn is active. A different interactive conversation receives a busy response while another turn is active.
- Job dispatch is at least once across gateway or host crashes. External side effects require idempotent prompts or downstream deduplication.
- In-flight OMP work is not resumable after a process or child crash. Completed session and scheduled-job state remain durable.
- One Telegram bot token has one long poller. Do not run multiple pollers or mix long polling with a Telegram webhook.
- WebSocket delivery requires the authenticated client for the exact configured origin to remain connected. The gateway does not queue delivery for a disconnected WebSocket client.
- HTTP is health-only. There is no HTTP prompt, scheduler, database, or unauthenticated transport API.
- Experimental auto-capture uses extra provider tokens and can create or refine gateway-profile managed skills. Review that profile before relying on learned behavior for consequential automation.

## Further reference

- [README quickstart](../README.md)
- [RPC and transport reference](rpc-service.md)
- [Security policy](../SECURITY.md)
- [Upstream attribution](../NOTICE)
