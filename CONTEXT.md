# OmpClaw Architecture

OmpClaw is one gateway service that gives authenticated remote transports access
to one owned OMP RPC child and its session. The gateway serializes access to the
child and is the only writer of OmpClaw's durable state.

## Runtime

**Gateway service**:
The OmpClaw process that owns the OMP RPC child, coordinates transport and
scheduler work, and persists all gateway state.

**OMP RPC child**:
The child process the gateway starts and owns to operate OMP. Transports never
receive direct access to this process.

**OMP session**:
The OMP conversation operated by the owned RPC child. When topic sessions are
enabled, the gateway serializes session selection and retains the associated
bindings.

**Single-writer invariant**:
Only the gateway service may mutate OmpClaw's SQLite state or operate its owned
OMP RPC child. Transports, Home, and scheduled jobs submit work through the
gateway rather than writing state or controlling OMP directly.

**SQLite state**:
The durable store for principals, bindings, OMP session checkpoints, inbound
deduplication and queued work, UI state, and scheduled jobs. It survives gateway
restarts.

## Access and routing

**Transport**:
An authenticated adapter for a client protocol, currently Telegram or
WebSocket. A transport verifies credentials before it can submit work.

**Principal**:
The durable OmpClaw identity that owns permissions, conversations, and scheduled
jobs.

**Transport identity binding**:
The server-side association between a verified transport identity and an
OmpClaw principal. Clients do not choose their principal.

**Conversation binding**:
The durable association between an authenticated conversation and its OMP
session context. It lets the gateway resume the correct context after a restart.

**Topic**:
A Telegram forum thread. Topic bindings can associate authorized topic
conversations with their persisted OMP session contexts.

**Home**:
The Telegram control surface for current gateway and OMP state. It shows the
configured autonomy mode and provides an interactive selector for changing it.

**Inbound request**:
An authenticated message or control action submitted by a transport to the
gateway for serialized handling.

**Outbound response**:
Assistant output or gateway state delivered to the authenticated conversation
that originated or owns the work.

## Durable work

**Scheduler**:
The gateway component that runs durable one-shot and cron jobs with timezone,
retry, recovery, and principal-ownership rules. Scheduler work uses the same
serialized OMP runtime as interactive work.

**Scheduled job**:
A durable, principal-owned unit of scheduler work. Its state and retry history
are stored in SQLite.

**Tool approval mode**:
The configured OMP policy that governs prompts before OMP uses a tool. It does
not decide actions that require a genuine user decision.

**OMP slash command**:
An explicit OMP instruction that is expanded in the OMP session. It is distinct
from a gateway control action handled before OMP receives a turn.
