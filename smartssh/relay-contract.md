# SmartSSH relay wire contract

Version: SmartSSH 1.0.238 (contract v2) · Scope: `smartssh/relay/`

This document is derived from the implemented behavior of `smartssh/relay/server.mjs`,
`smartssh/relay/state.mjs`, `smartssh/relay/response.mjs` and the assertions in
`smartssh/relay/relay.test.mjs` (25 tests, all passing), plus a direct probe of the
running server. Every statement below is something the relay was observed to do. Where a
behavior is *not* enforced, this document says so explicitly — see
[Non-requirements](#non-requirements-things-the-relay-does-not-enforce).

`createRelay({ store })` returns an unbound Node `http` server. It records dispatches for a
desktop client; **it never executes a shell command**. All state is in process memory
(`createStore()`), so state, proposals and replay records vanish on restart.

## Transport and authentication

- HTTP/1.1 over a single origin. Run it on loopback or behind TLS; the relay itself
  terminates no TLS.
- Every response is `Content-Type: application/json` and `Cache-Control: no-store`.
- **Every route requires** `Authorization: Bearer <RELAY_TOKEN>`. The header is compared
  with `crypto.timingSafeEqual` against `Bearer ` + `process.env.RELAY_TOKEN`, read once when
  `createRelay()` is called.
  - Any mismatch, missing header, or *unset* `RELAY_TOKEN` (which makes every request
    invalid) → `401` with `{"error":"token_invalid"}`.
  - Auth is checked **before** the body is read or parsed: a malformed JSON body with a bad
    token returns `401 token_invalid`, and the same body with a good token returns
    `400 bad_request`.
- The query string is stripped before routing (`req.url.split('?')`); path segments are
  matched verbatim and are **not** percent-decoded.

## Routes

| Method | Path | Success | Errors |
| --- | --- | --- | --- |
| POST | `/v1/context.push` | `200` push result | `400 bad_request`, `413 truncation_refused` |
| GET | `/v1/tabs/:tab_id/context` | `200` stored metadata | `404 not_found` (tab never pushed) |
| POST | `/v1/proposal` | `200` proposal | `400 bad_request`, `503 internal_error` (code space exhausted) |
| GET | `/v1/proposal/:proposal_id` | `200` proposal state | `410 proposal_dead` |
| POST | `/v1/proposal/:proposal_id/reject` | `200` rejected | `400 bad_request`, `410 proposal_dead`, `410 proposal_done` |
| POST | `/v1/command.dispatch` | `200` executing | `400 missing_idempotency_key`, `400 bad_request`, `409 stale_approval`, `410 proposal_dead`, `422 confirm_mismatch` |
| POST | `/__fault` | `200 {"armed":true}` — **dev only** | `400 bad_request`; `404 not_found` unless `RELAY_DEV=1` |

Any other path or method falls through to `404 {"error":"not_found"}` — including `PUT` /
`DELETE` on a real route, and `/__reset` (which does not exist in any mode).

A `POST` whose body is absent, invalid JSON, or valid JSON that is not a plain object
(array, `null`, scalar) gets `400 bad_request`.

### Error envelope

All errors share one shape, with a stable machine `error` code and a human `message` from
`response.mjs`:

```json
{"error": "stale_approval", "message": "Approval is no longer valid for this dispatch."}
```

| Status | `error` | Extra fields |
| --- | --- | --- |
| 400 | `bad_request` | — |
| 400 | `missing_idempotency_key` | — |
| 401 | `token_invalid` | — |
| 404 | `not_found` | — |
| 409 | `stale_approval` | — |
| 410 | `proposal_dead` | `attempts_left: 0` |
| 410 | `proposal_done` | — |
| 413 | `truncation_refused` | — |
| 422 | `confirm_mismatch` | `attempts_left` |
| 500 / 503 | `internal_error` | — |

## `POST /v1/context.push`

Pushes a window of terminal output **for redaction scoring and truncation counting only**.

Request body:

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `tab_id` | string | yes | non-empty after trim |
| `session_id` | string | yes | non-empty after trim |
| `text` | string | yes | the window to validate; UTF-8 bytes ≤ 262144 |
| `line_count` | integer | yes | **must equal** `text.split('\n').length` |
| `truncated_lines` | integer | yes | client-side drops, `>= 0` |
| `redacted_segments` | integer | yes | **must equal** `masks.length` |
| `masks` | array | yes | validated for length only; contents are never stored |
| `severity` | string | yes | one of `none`, `suspicious`, `deception` |
| `range.fromLine` | integer | yes | `>= 1` |
| `range.toLine` | integer | yes | `toLine - fromLine + 1 === line_count` |
| `range.at` | string \| integer | no | defaults to the server's ISO-8601 timestamp |

Extra fields such as `host`, `cwd`, `exit_code` or `invisible_escalation` are accepted but
**ignored**: they are not stored and never appear in a response. Client-supplied `warnings`
are ignored too.

Validation is all-or-nothing: any of the checks above failing returns a single
`400 bad_request` with no field detail. The only distinct validation code is the byte cap:
`text` over **262144 bytes** of UTF-8 returns `413 truncation_refused` (exactly 262144 bytes
is accepted).

### Server-side truncation

The relay keeps only the **last 200 lines** of a window
(`MAX_LINES = 200`). Let

```
server_dropped_lines = max(0, line_count - 200)
```

The response reports both counters, and they are different numbers on purpose:

- `received.line_count` = `line_count - server_dropped_lines` (lines actually retained)
- `received.truncated_lines` = **client `truncated_lines` + `server_dropped_lines`** — the
  cumulative drop count across both ends
- `received.server_dropped_lines` = the server's own share only
- `received.range` = `{fromLine: fromLine + server_dropped_lines, toLine}`, so the kept range
  still brackets exactly `received.line_count` lines

Response `200`:

```json
{
  "session_id": "s1",
  "received": {
    "line_count": 200,
    "truncated_lines": 150,
    "redacted_segments": 0,
    "severity": "none",
    "range": {"fromLine": 151, "toLine": 350},
    "server_dropped_lines": 50
  },
  "warnings": []
}
```

`warnings` is **server-generated only**; the client cannot add any:

| Warning | When |
| --- | --- |
| `{"code":"server_truncated","dropped_lines":n}` | the server dropped `n > 0` lines |
| `{"code":"severity_recorded"}` | `severity !== "none"` (recorded, not acted on) |

### `GET /v1/tabs/:tab_id/context`

Returns the stored metadata for the last push on that tab, flattened (no `received` wrapper):

```json
{"tab_id":"t1","session_id":"s1","line_count":200,"truncated_lines":150,
 "redacted_segments":0,"severity":"none","range":{"fromLine":151,"toLine":350},
 "at":"2026-11-26T14:21:00Z"}
```

Unknown tab → `404 not_found`. This endpoint — like the push response — contains no
terminal text and no mask contents; the test suite asserts a canary string pushed in `text`
never appears in the serialized response.

## Proposals

### `POST /v1/proposal`

Request: `{tab_id, session_id, risk, command}`.

- `tab_id`, `session_id`, `command` must be non-empty strings; `command.length` ≤ **4096
  characters** (not bytes); `risk` must be `read`, `write` or `danger`. Anything else →
  `400 bad_request`.
- Client-supplied `confirm_expected`, `attempts` or `expires_at` are ignored.

Response `200`:

```json
{"proposal_id":"<uuid-v4>","risk":"danger","confirm_expected":"0417","expires_at":1795738280000}
```

- `confirm_expected` is present **only** for `risk: "danger"` and always matches `^\d{4}$`.
  The four-digit code is drawn from `0..9999` **without replacement for the store's
  lifetime**; a code is never released when its proposal expires, retries, or is rejected.
  When all 10 000 codes are consumed, creation returns `503 internal_error`.
- Proposals expire **120 seconds** after creation: `expires_at = now() + 120000` (epoch
  milliseconds). A proposal is usable while `now <= expires_at`; one millisecond later it is
  dead.
- `attempts_left` starts at **3** and is consumed only by wrong danger confirmations.

### `GET /v1/proposal/:proposal_id`

```json
{"proposal_id":"…","status":"proposed","rejection_reason":null,
 "attempts_left":3,"expires_at":1795738280000}
```

`status` is `proposed`, `executing` or `rejected`; `rejected_at` is added when rejected.

**Unknown, expired, and out-of-attempts proposals all return `410 proposal_dead`
(`attempts_left: 0`) — not `404`.** Clients cannot distinguish "never existed" from
"expired" from "burned", and should not try.

### `POST /v1/proposal/:proposal_id/reject`

Request: `{reason, ts?}` — `reason` a non-empty string, `ts` an optional integer.

- Dead proposal → `410 proposal_dead`.
- Already `executing` or `done` → `410 proposal_done`.
- Already `rejected` → `200` and **idempotent**: the first `reason`/`rejected_at` win; later
  rejections neither overwrite them nor consume attempts.
- `200`: `{proposal_id, status:"rejected", reason, rejected_at, attempts_left}`.
- Rejection does **not** consume a confirmation attempt and does **not** release the code.
  After a rejection the proposal can never be dispatched (`409 stale_approval`).

## `POST /v1/command.dispatch`

Request headers: `Idempotency-Key: <key>` — **required**, non-empty.
Request body: `{proposal_id, command_id, tab_id, session_id, confirm?}`.

Server-side evaluation order (each step returns immediately):

1. `Idempotency-Key` missing/empty → `400 missing_idempotency_key`. A body field
   `idempotency_key` is never used as a substitute.
2. Proposal not active (unknown / expired / attempts exhausted) → `410 proposal_dead`.
3. `command_id` empty, or `tab_id` / `session_id` not matching the proposal →
   `400 bad_request`.
4. Proposal status `rejected` → `409 stale_approval`.
5. An execution record already exists for this `Idempotency-Key`:
   - same `proposal_id` → **replay**: `200` + `Idempotent-Replay: true` (see below);
   - different `proposal_id` → `409 stale_approval`.
6. Status not `proposed` (already executing under a different key) → `409 stale_approval`.
7. `risk: "danger"` and `confirm` (spaces stripped) ≠ `confirm_expected` →
   `422 confirm_mismatch` with `attempts_left` decremented. The client's own `attempts`
   field is ignored.

First successful dispatch → `200`:

```json
{"status":"executing","command_id":"…","proposal_id":"…","started_at":1795738160000}
```

`started_at` is epoch milliseconds.

### Idempotent replay

Re-sending the same `Idempotency-Key` for the same proposal returns, while the proposal is
still active:

```
HTTP/1.1 200
Idempotent-Replay: true
{"status":"executing","command_id":"…","replay":true}
```

- No new execution record is created — `store.dispatchCount` stays at 1 (asserted).
- The replay path runs **after** the active-proposal check, so a replay stops working the
  moment the proposal expires (`410 proposal_dead`), even though the execution was recorded.
  Replay works *at* the TTL boundary (`at === expires_at`) but not one millisecond past it.
- No `confirm` is needed on a replay.

### `Idempotency-Key` vs `command_id`

These are **two independent identifiers**:

- `Idempotency-Key` (header) is the dedupe key: it is what the relay stores in the execution
  map and what a replay must repeat.
- `command_id` (body) is the client's identifier for the command, echoed back in the
  response and stored in the execution record.

The relay does **not** require the two values to be equal. Measured: a dispatch with
`Idempotency-Key: KEY-BBB` and `command_id: CMD-AAA` returns `200`. Convention for clients
is to send the command id as the header value, which is what makes the two look identical in
practice — but a mismatch is accepted, and nothing keys on `command_id`.

> Correction note: `smartssh/relay/README.md` previously stated dispatch "requires
> `Idempotency-Key` matching `command_id`". The implementation never enforced that; the
> README was corrected in the same change that added this contract.

## Proposal state machine

```
                  ┌──────────── reject ────────────► rejected ──┐
   create ──► proposed                                            │
                  └── dispatch (+confirm if danger) ─► executing  │
                                                            │     │
   TTL 120 s elapsed, or attempts_left == 0 ──► dead (410 proposal_dead, terminal)
```

- `executing` and `rejected` are terminal for dispatch purposes; `rejected` is terminal for
  everything except repeated (idempotent) rejections.
- A dead proposal is terminal and its four-digit code is never reused.

## Retention and privacy

The relay is a metadata ledger, not a log sink.

| Stored | Not stored |
| --- | --- |
| `tab_id`, `session_id`, `line_count`, `truncated_lines`, `redacted_segments`, `severity`, `range`, `at` | any terminal text |
| `proposal_id`, `risk`, `status`, `expires_at`, `attempts_left`, `rejection_reason` | any mask contents (only `masks.length` is checked) |
| `command_id`, `proposal_id`, `started_at` per execution | anything on disk |

Two precision points:

- **No terminal text and no masks are retained.** `text` is used to validate the window and
  then discarded; the store keeps counters only. `masks` is validated as an array and its
  length compared with `redacted_segments`; the mask spans themselves are never stored.
- A proposal record does hold the proposed `command` string **in memory** for the proposal's
  lifetime, because that is what the client proposed and what a dispatcher must later
  match. No route returns it. Everything is process memory, so it is gone after a restart.

Security notes: bind to loopback or put TLS in front; the token is compared in constant
time; there is no rate limiting, no per-tab authorisation and no persistence.

## Dev-only fault injection

Set `RELAY_DEV=1` **before importing** `server.mjs` (the module is conditionally imported at
module load) to enable `POST /__fault`:

```json
{"route":"/v1/command.dispatch","mode":"status","status":500,"delay_ms":0}
```

- `mode`: `status` (arbitrary status, defaults 500), `timeout` (never responds; holds the
  socket until the client aborts), or `body` (substitutes a JSON body).
- `route` must start with `/v1/`; `delay_ms` ≤ 2 147 483 647.
- A fault fires **once** for its route and is then removed.
- Without `RELAY_DEV=1`, `/__fault` is `404 not_found`; the module is never loaded in
  production.

## Non-requirements (things the relay does not enforce)

Listing these keeps client authors from inventing guarantees:

- `Idempotency-Key` ≠ `command_id` is accepted (see above).
- No authentication beyond the single shared bearer token; no per-tab or per-session scope.
- No ordering or delivery guarantee for `context.push`; the last push per tab wins and
  replaces the previous metadata.
- No execution: the relay never spawns a process, and it does not verify that a command was
  actually run.
- No persistence, and no retention limits other than process lifetime.

## Running the tests

From the repository root:

```sh
node smartssh/relay/relay.test.mjs   # 25 tests, exit 0
```
