# Security policy

## Supported versions

Security fixes are provided for the latest released version.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use GitHub's private
vulnerability reporting flow:

<https://github.com/TerrifiedBug/omp-telegram/security/advisories/new>

Include:

- the affected version or commit;
- the required Telegram access state (unpaired DM, paired owner, configured group);
- reproduction steps and impact;
- whether a bot token or other credential may have been exposed.

If a credential was exposed, revoke or rotate it immediately. A report is not a
reason to keep using a compromised token.

## Security model

One paired private-DM operator owns control commands. Configured groups can send
normal omp user prompts but never receive bridge-control authority. Because those
prompts retain the session's normal workspace and tool access, only trusted groups
and sender IDs should be configured.

## Standalone RPC service

The standalone service gives the paired Telegram operator the normal authority
of the selected OMP profile, workspace, tools, and MCP servers. It is a remote
OMP terminal, not a limited chat bot.

The transport enforces:

- one immutable numeric Telegram operator;
- private chats only, with group policy rejected at startup;
- callback binding to the operator, chat, topic, and control message;
- one live writer for the resumed OMP session;
- RPC confirmations and input translated into authenticated Telegram controls;
- bot credentials removed from the OMP child environment;
- credential files required to be regular, owner-only, and mode `0600` or stricter;
- direct RPC bash disabled unless the operator starts with `--allow-rpc-bash`;
- atomic owner-only access and session state files;
- inbound size/retention limits and outbound path checks.

Mode checks do not inspect platform-specific extended ACLs. Keep the environment
and auth-broker token files free of ACL grants to other local principals.

`--inherit-harness` links read-mostly skills, rules, commands, agents,
documentation, and helper binaries, then copies selected configuration from the
default OMP profile. It excludes hooks, extensions, `.env`, credentials,
sessions, blobs, and runtime databases. Review inherited rules, skills, MCP
definitions, helper binaries, and workspace authority before enabling remote
access, especially on a VPS.
