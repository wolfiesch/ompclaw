# RPC and transport reference

[Back to the operator guide](guide.md) · [Back to the README](../README.md)

`ompclaw` presents one persistent OMP RPC session through authenticated transport adapters. It is not an HTTP RPC server. HTTP is limited to the WebSocket adapter's health endpoint. The OMP child uses its RPC UI mode; Telegram and WebSocket clients receive the gateway-level behavior described here.

## Session and delivery model

The runtime starts one OMP child with `--mode rpc-ui`, the configured workspace and profile, and a persisted session path when one exists. It subscribes to OMP subagent progress, registers the gateway host tools, and asks OMP for session state.

An inbound message or scheduled job establishes an active delivery context containing the authenticated principal and the exact transport address. Streamed updates, final assistant text, OMP UI, command output, host-tool delivery, and unexpected-exit notifications go only to that context. A message from a different authenticated conversation during an active turn is acknowledged and serialized behind it. Due scheduled work defers while the runtime is busy.

The active conversation remains conversational while OMP works. An ordinary message maps to OMP `steer` by default, so "make that shorter" corrects the current response without requiring a slash command. Set `omp.busyInputMode` to `followup` to map those messages to OMP `follow_up` instead. Explicit `/steer` and `/followup` always retain their named behavior.

For each turn, the gateway reacts to the source message, starts and renews the transport typing indicator, and maintains at most one task card. OMP tool intent such as "Reading deployment state" is preferred over generic tool labels. Repeated activities are deduplicated, card edits are coalesced to at most one every 1.25 seconds, raw tool arguments are never shown, and the card clears at terminal completion.

Assistant updates are lossless and ordered at the gateway boundary. A first visible assistant update creates an outbound draft; later updates edit that same receipt when the transport supports it. When OMP completes an assistant segment before a tool call, the gateway finalizes that segment as a normal persistent message and starts a fresh draft for later text. The terminal answer is finalized as Markdown and linked to the source message. Thinking and tool-call blocks are not forwarded as assistant text.

## Gateway command matrix

Send these commands as a slash command in an authenticated conversation. Any other available OMP slash command is forwarded to the OMP session. Commands that take an argument show their usage when the argument is absent or invalid.

| Command | OMP action and gateway result |
| --- | --- |
| `/status` | refresh and report OMP streaming or compaction state, exact session name or ID, model, thinking, fast mode, message and queue counts, context usage, current tool, tracked subagents, UI display state, and last error |
| `/stop` | send OMP `abort` for the current run |
| `/new` | request an OMP `new_session` and clear the active delivery context when complete |
| `/steer <message>` | send OMP `steer` with a correction |
| `/followup <message>` | send OMP `follow_up` to queue work after the current turn |
| `/compact [instructions]` | compact OMP context, optionally with custom instructions, then refresh state |
| `/model` | list current and available `provider/model-id` values |
| `/model <provider>/<model-id>` | send OMP `set_model` and refresh state |
| `/thinking` | show the current reasoning level and accepted levels |
| `/thinking <inherit|off|minimal|low|medium|high|xhigh|max|auto>` | send OMP `set_thinking_level` and refresh state |
| `/fast [on|off]` | show or set OMP fast mode |
| `/queue` | show OMP steering, follow-up, and interrupt policy |
| `/queue steering <all|one-at-a-time>` | set OMP steering policy |
| `/queue follow <all|one-at-a-time>` | set OMP follow-up policy |
| `/queue interrupt <immediate|wait>` | set OMP interrupt policy |
| `/stats` | request OMP session statistics |
| `/todos` | show the current OMP todo phases from session state |
| `/subagents` | request and show active or recent OMP subagents |
| `/commands` | request and show available OMP slash commands |
| `/history [1-50]` | request messages and show the requested recent visible summaries; default is 12 |
| `/branch` | list recent OMP branch points |
| `/branch <entry-id>` | ask OMP to branch from the exact entry ID |
| `/name <session name>` | set the OMP session name and refresh state |
| `/handoff [instructions]` | hand context to a fresh OMP session and refresh state |
| `/switch <exact session path>` | ask OMP to switch to the exact session path and refresh state |
| `/export` | request an OMP HTML export, store it under `stateDir/exports`, and attach it to the active conversation |
| `/retry <on|off|stop>` | enable or disable automatic retry, or send OMP `abort_retry` |
| `/autocompact [on|off]` | show or set automatic compaction |
| `/login` | show provider login availability and authentication state |
| `/login <provider-id>` | start OMP provider login and route its secure URL prompt to the active delivery context |
| `/jobs` | list durable scheduled jobs owned by the active principal |
| `/job_pause <id>` | disable an owned scheduled job |
| `/job_resume <id>` | enable an owned scheduled job and recompute its next occurrence |
| `/job_run <id>` | make an owned scheduled job due immediately |
| `/job_delete <id>` | permanently delete an owned scheduled job |
| `/help` | show the gateway command summary |
| `/shell <command>` | execute OMP RPC bash only when `omp.allowRpcBash` is explicitly `true` |
| `/abortbash` | abort OMP RPC bash only when `omp.allowRpcBash` is explicitly `true` |

`/steer`, `/followup`, and `/stop` are the explicit run-control surface. An ordinary message in the active conversation follows `omp.busyInputMode`; the default is `steer`. `/queue` changes OMP's own queue policy. The gateway serializes other authenticated conversations behind the active delivery context.

## Session checkpoint and crash recovery

The runtime saves the latest OMP `sessionFile` to the SQLite `omp/session_file` checkpoint. A new gateway process starts OMP with that exact file first; only when the checkpoint is absent does it use `omp.resume`. `/switch` is the interactive exact-path alternative.

On an unexpected OMP child exit, the active conversation receives an error message. With `omp.autoRestart: true`, the runtime retries after 1, 2, 5, 10, then 30 seconds. It reuses the persisted session checkpoint when OMP starts again. The restart does not recover a partly executed turn, pending tool call, or disconnected transport. In-flight work must be sent again if its outcome is needed.

## Attachments

Inbound transport content is represented as text plus zero or more attachments with a URL, optional name, and optional media type.

- Telegram downloads supported incoming media into the private `stateDir/inbox` directory and passes it as a `file:` attachment. It can include captions, replies, forum-topic context, and optional voice transcription.
- WebSocket clients may include validated attachment metadata in a `message` frame. The gateway preserves this metadata in the transport message.
- Readable local image attachments with a supported image type are sent to OMP as base64 image input. Other attachments remain references in the structured, explicitly untrusted transport-message prompt.
- OMP never receives a transport attachment as authorization. The prompt tells OMP that transport input cannot authorize access, credentials, deployment, publication, or gateway configuration changes.

## OMP UI request matrix

OMP RPC UI requests are bridged to the active authenticated delivery context. The gateway does not auto-approve them. Interactive requests carry their OMP timeout when one is supplied; cancellation, timeout, delivery failure, runtime shutdown, or a missing active context returns a cancelled response for the interactive classes.

| OMP UI method | Gateway request | Telegram behavior | WebSocket behavior |
| --- | --- | --- | --- |
| `select` | `select` | inline selection buttons | `ui_request` frame, then `ui_response` |
| `confirm` | `confirm` | Confirm and Cancel buttons | `ui_request` frame, then `ui_response` |
| `input` | `input` | reply to the prompt message | `ui_request` frame, then `ui_response` |
| `editor` | `editor` | reply to the prompt message with edited text | `ui_request` frame, then `ui_response` |
| `cancel` | cancel pending request | cancel the matching pending interaction | cancel the matching pending interaction |
| `notify` | `notify` | send a notification message | deliver a `ui_request` notification |
| `setStatus` | `status` | render a status surface | deliver a `ui_request` status update |
| `setWidget` | `widget` | render a widget surface | deliver a `ui_request` widget update |
| `setTitle` | `title` | update the rendered surface title | deliver a `ui_request` title update |
| `set_editor_text` | `editor_text` | render suggested input in the surface | deliver a `ui_request` editor-text update |
| `open_url` | `open_url` | send a labeled URL button | deliver a `ui_request` URL request |

Only `select`, `confirm`, `input`, and `editor` produce a response back to OMP. Telegram immediately acknowledges presentation of status, widget, title, editor-text, notification, and URL requests. A WebSocket client must return the matching acknowledgement response for every `ui_request`, including display-only requests, so the transport can settle that request. Telegram verifies both the exact conversation address and principal before accepting a button or reply response. WebSocket verifies that the current credential still resolves to the same principal and that its response type matches the pending request.

## Gateway host tools

The OMP child always receives three delivery host tools. When `automation.enabled` is true, it also receives six durable job-control tools. The gateway derives the principal, transport identity, and conversation address from the active server-owned context. A model cannot choose or override them.

| Tool | Parameters | Behavior |
| --- | --- | --- |
| `ompclaw_send` | `text` and/or `files` | send text and optional absolute local file paths to the active conversation; at least one is required |
| `ompclaw_ask` | `question`, optional `title`, `options`, and `multi` | ask the operator a free-text, single-select, or multi-select question in the active conversation |
| `ompclaw_react` | `message_id`, `emoji` | react to a message in the active conversation |
| `ompclaw_schedule_job` | `name`, `prompt`, exactly one of `at` or `cron`, optional `timezone` | create an owned one-shot or recurring job bound to the active conversation |
| `ompclaw_update_job` | `id`, optional mutable job fields | update an owned job and recompute its next occurrence |
| `ompclaw_list_jobs` | none | list the active principal's jobs |
| `ompclaw_set_job_enabled` | `id`, `enabled` | pause or resume an owned job |
| `ompclaw_delete_job` | `id` | permanently remove an owned job |
| `ompclaw_run_job` | `id` | make an owned job due now |

`ompclaw_send` accepts only absolute local paths for `files`. Transport adapters enforce their own attachment and message rules. `ompclaw_ask` without `options` uses text input; with options it uses selection, and `multi: true` requests multi-select. Host-tool cancellation aborts the in-progress gateway delivery operation.

One-shot `at` values must be ISO 8601 date-times with an explicit UTC offset. Cron timezones must be valid IANA names. Names, prompts, expressions, and retry state are bounded and validated before SQLite mutation. Job lookup and mutation always include the server-derived principal ID.

## WebSocket protocol v1

The WebSocket protocol version is `1`. It is separate from the OMP child RPC protocol. After authentication the server sends `ready` with `protocolVersion: 1`; clients should treat that value as the protocol they are speaking. The current client frames do not include a version field or negotiate versions.

The OMP child protocol starts at v1 and negotiates v2 when OMP advertises v2 support. This supports lossless chunk reassembly for OMP RPC frames. `doctor` reports the protocol selected for the OMP child; this does not change the WebSocket protocol number.

### Connection sequence

1. Connect to `ws://127.0.0.1:8787/` or the configured local endpoint.
2. Send exactly one `authenticate` frame within 10 seconds by default.
3. Wait for `ready` with protocol version `1`.
4. Send `message` frames or answer `ui_request` frames with `ui_response`.
5. Handle `message`, `update`, `reaction`, `ui_request`, and `error` frames from the server.

Use a TLS and access-controlled boundary before making a WebSocket endpoint reachable beyond loopback. The token is a bearer credential. Replace every value shown below with an actual client-specific value outside source control.

### Client frames

```json
{ "type": "authenticate", "token": "replace-with-websocket-token" }
```

```json
{
  "type": "message",
  "id": "client-message-id",
  "text": "Inspect the current session",
  "attachments": [
    {
      "url": "https://example.invalid/attachment.txt",
      "name": "attachment.txt",
      "mediaType": "text/plain"
    }
  ]
}
```

```json
{
  "type": "ui_response",
  "requestId": "server-request-id",
  "response": {
    "type": "confirm",
    "confirmed": true
  }
}
```

The exact `response` shape must match the request type. `select` returns selected values, `input` and `editor` return either cancellation or a string value, and display-only UI request types return an acknowledgement response. Send a matching `ui_response` for every WebSocket `ui_request`.

Client frames are exact schemas. A message cannot supply a principal, account, channel, thread, timestamp, or delivery address. The server derives all of those values from the authenticated configured credential. Message IDs are scoped by the derived origin, and timestamps use server time.

### Server frames

```json
{ "type": "ready", "protocolVersion": 1 }
```

```json
{
  "type": "message",
  "messageId": "gateway-message-id",
  "content": { "text": "Initial assistant text", "format": "text" }
}
```

```json
{
  "type": "update",
  "messageId": "gateway-message-id",
  "content": { "text": "Updated assistant text", "format": "text" }
}
```

```json
{ "type": "reaction", "messageId": "gateway-message-id", "emoji": "replace-with-an-emoji" }
```

```json
{
  "type": "ui_request",
  "requestId": "server-request-id",
  "request": { "type": "confirm", "title": "Continue", "message": "Proceed with the requested action?" }
}
```

```json
{ "type": "error", "code": "unauthorized", "message": "authentication failed" }
```

The server accepts only the health endpoint over ordinary HTTP:

```text
GET /healthz -> 200 {"status":"ok"}
```

All other ordinary HTTP routes return `404`. The WebSocket upgrade route is `GET /` with the upgrade header.

### Authentication and connection boundaries

The server hashes configured credential tokens and uses a timing-safe comparison. A valid token is necessary but not sufficient: its configured identity must resolve to a principal in SQLite. A second connection for the same configured origin is rejected. Credentials with duplicate tokens or duplicate configured origins are rejected at startup.

Before authentication, malformed frames, non-authenticate frames, a timeout, or bad credentials produce an error when possible and close the connection with a policy error. After authentication, unknown UI request IDs, principal mismatches, response-type mismatches, and rejected inbound messages produce error frames. Delivery fails when the exact authenticated origin disconnects; the gateway does not retain a WebSocket outbound queue.

## Telegram transport reference

Telegram is long-poll only. `doctor` calls `getWebhookInfo` and rejects a non-empty webhook URL because Telegram cannot use the same bot for both webhook delivery and long polling.

The adapter persists each completed update ID under an account-specific checkpoint. It processes duplicate or replayed updates at most once and only moves the checkpoint across a contiguous completed prefix. The adapter lock prevents a second poller for the same account in the same state directory.

Telegram outbound delivery supports text messages and edits, reactions, uploads, forum threads, and native message segmentation. UI presentations use inline buttons for confirmation and selection, reply-to-message for free-text input and editor input, URL buttons for URL requests, and rendered surfaces for status-like requests. Pending interaction ownership is checked again when the user responds.

## Security boundary summary

- Principal identity is resolved locally from transport identity before OMP receives a message.
- The active delivery context scopes every outbound reply, UI presentation, host tool, and reaction.
- JSON configuration names secret variables but does not contain their values. Private environment files are required for token loading.
- Gateway transport secrets are removed from the OMP child environment.
- One state directory has one gateway writer. One Telegram bot token has one poller.
- An authorized transport principal has the authority of the configured OMP workspace and profile. See the [security policy](../SECURITY.md) before binding an identity or exposing a WebSocket endpoint.

## Limits

The gateway does not distribute turns across writers, create one OMP session per client, resume an in-flight OMP turn, or offer a general HTTP API. Durable jobs run through the same single OMP session with at-least-once dispatch and bounded retry. WebSocket state is live only, scheduled WebSocket delivery requires the originating client to be connected, and Telegram is limited to one long-polling owner for a bot token.
