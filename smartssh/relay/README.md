# SmartSSH relay

`createRelay({ store })` in `server.mjs` returns an unbound Node HTTP server.
By default each server gets its own in-memory store. It records dispatches; it
never executes a shell command. State, challenges and replay records do not
survive a restart. Use loopback or TLS and set `RELAY_TOKEN` before creating
the server. Every route checks the bearer token before processing a request.

The wire contract is `/work/relay-contract.md`. Context pushes validate the
sent window before recording metadata for its last 200 lines. The relay keeps
neither text nor masks. `received.truncated_lines` includes both client and
server drops; `received.server_dropped_lines` counts only server drops.

Proposals expire after 120 seconds. Danger confirmations have three attempts;
the relay issues four-digit codes without replacement for the store's lifetime.
Rejection records a reason and timestamp. Dispatch requires `Idempotency-Key`
matching `command_id`; a replay has `Idempotent-Replay: true` and creates no
new execution record.

Set `RELAY_DEV=1` **before importing** `server.mjs` to enable `POST /__fault`.
Faults apply once to their specified route; `timeout` leaves the request
unanswered. The module is not loaded in production.

Run `node smartssh/relay/relay.test.mjs` from the repository root.
