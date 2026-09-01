# Security policy

## Supported versions

OmpClaw is Alpha. Security fixes are considered for the newest published release only. There is no guaranteed response or remediation timeline during Alpha. If a security fix requires an upgrade, use the newest release rather than expecting backports.

## Report a vulnerability privately

Do not open a public issue, discussion, pull request, or chat message for a suspected vulnerability. Use GitHub's private vulnerability reporting flow for this repository:

<https://github.com/wolfiesch/ompclaw/security/advisories/new>

A useful report includes:

- affected package version and operating system;
- a minimal reproduction or proof of concept;
- the impact and attack preconditions;
- whether an attacker needs local host access, a Telegram account, a WebSocket token, or network access;
- relevant logs and configuration with every token, user ID, hostname, workspace path, and session path removed.

Please allow maintainers to investigate and prepare a fix before public disclosure. Do not publish exploit details, working credentials, session files, or a bypass while the report is being handled.

## Threat model

The gateway is designed for one trusted operator environment:

- It runs one OMP RPC child process for one configured workspace and profile.
- A transport identity must resolve to a principal recorded in the local SQLite store before its inbound message reaches OMP.
- Telegram sender identity is obtained from the Telegram update. WebSocket identity and conversation address are derived from the configured credential, never from client message fields.
- A live WebSocket connection is limited to one configured conversation origin. Gateway delivery is constrained to the active principal and origin.
- The JSON configuration contains paths and environment-variable names, not token values. Transport-secret environment variables are removed before the OMP child starts.
- The gateway locks its state directory so a second gateway process cannot become another state writer. The Telegram adapter separately locks one polling account. Durable automation remains scoped to the principal and conversation derived when the job was created.
- Transactional self-update is disabled by default. When enabled, only an authenticated principal with the `operator` role can stage or activate a release, and only from the fixed configured repository.

The gateway does **not** make an OMP workspace safe for untrusted operators. An authorized principal can cause prompts to be processed by OMP with the authority of the configured OMP profile, workspace, tools, and provider credentials. Treat granting a Telegram allowance or binding a WebSocket identity as granting access to that environment.

The gateway does not defend against a compromised host, another process running as the same operating-system user, stolen provider credentials, a stolen Telegram account, a stolen WebSocket token, a malicious OMP plugin or MCP server, or a compromised client device. It also does not provide end-to-end encryption beyond the transport guarantees supplied by Telegram or your own network deployment.

## Deployment hardening

1. Run the gateway under a dedicated, non-administrator user when practical. Limit that user's workspace, SSH, network, and provider access to what the session requires.
2. Keep the default WebSocket bind address on loopback, such as `127.0.0.1`. Do not expose the WebSocket port directly to an untrusted network.
3. If remote WebSocket access is required, put it behind a TLS-terminating, access-controlled network boundary. Restrict firewall rules and protect the client token in transit. Do not rely on the health endpoint as authentication.
4. Use distinct high-entropy WebSocket tokens for each configured credential. Bind each credential subject explicitly to the intended principal with `identity-bind`.
5. Authorize only the specific Telegram identities that should operate the session. Prefer pairing codes over manually entering numeric IDs. Pairing requires a direct Telegram message plus a separate local approval; codes are stored only as salted hashes, expire after ten minutes, and are exhausted after five invalid attempts. Keep Telegram in long-polling mode and resolve any configured webhook before starting the gateway. `doctor` checks for this conflict.
6. Keep one gateway process and one Telegram poller per bot token. Do not share the state directory, token, or SQLite file among instances.
7. Leave `omp.allowRpcBash` disabled unless the operator has deliberately accepted the authority granted to OMP RPC bash commands.
8. Treat unattended scheduled prompts as standing authorization to use the configured OMP environment. Make prompts with external side effects idempotent, pause jobs that no longer need to run, and remove obsolete jobs.
9. Leave experimental learning disabled unless the operator accepts automatic provider use and gateway-profile managed-skill mutation. Review learned skills before using them in consequential automation.
10. Keep Bun, OMP, the gateway, operating system, and any reverse proxy current with their security updates.
11. Enable transactional self-update only for a trusted checkout owned by the service user. Staging runs repository-defined checks before compilation, so a compromised commit can execute with that user's non-secret build environment. Review the exact commit before activation.

## Secret handling

- Put Telegram and WebSocket token values in a separate environment file passed with `--env-file`; use only variable names in the JSON configuration.
- The environment file must be a regular file, owned by the current user, with mode `0600` or stricter on supported Unix systems. Do not commit it, upload it, or paste it into issue reports.
- The SQLite database stores principals, bindings, checkpoints, deduplication records, pending UI metadata, and durable job prompts and outcomes. Experimental learning also writes gateway-private memory data and managed skills. Treat the state directory and every backup as sensitive.
- Do not put provider tokens, bot tokens, WebSocket tokens, session exports, or private attachment files in source control, service definitions, shell history, screenshots, or telemetry.
- Rotate a token and restart the gateway if you suspect disclosure. Review and remove its principal binding if the associated operator should no longer have access.

## Safe disclosure and remediation

Maintainers may ask for a sanitized reproducer or a private follow-up through the GitHub advisory. Before sharing anything, replace token values, numeric user IDs, hostnames, workspace paths, session paths, attachment contents, and message text with safe placeholders. After a fix is available, coordinate a public advisory that describes affected versions, impact, mitigations, and upgrade guidance without publishing secrets or operational data.
