# API reference

## Stability contract

- **`/api/v1/*` is the stable surface.** Fields are only added within v1,
  never renamed or removed. Script against it freely.
- **`/stats/*` backs the dashboard** and may change in any release — don't
  script against it.
- `/stats/admin` and `/stats/timeseries` take an optional `company=<domain>` filter (normalized like `X-Tokenleader-Company`; garbage is a 400); the admin payload always carries the global `companies` list.
- All other routes (`/ingest`, `/manifest.json`, `/bin/*`, …) are the
  daemon/installer wire protocol — stable in practice, not part of the public
  contract.

## The range contract

Every range is **half-open `[since, until)` in unix-ms UTC**: an event at
`timestamp === since` is in; at `timestamp === until` it is out. All calendar
math (`period` months and days) is UTC. ISO-8601 input is accepted, strictly:
uppercase `T`/`Z` only; offsets need the colon (`+02:00`, not `+0200`); no
explicit offset means UTC, never server-local; date-only strings are UTC
midnight. Responses echo both forms (`since`/`until` in unix-ms,
`sinceIso`/`untilIso`).

## Authentication

Optional bearer auth, resolved in this order:

| Server config | `/api/v1/*` behavior |
|---|---|
| `TOKENLEADER_API_TOKEN` set | requires `Authorization: Bearer <api token>` |
| unset, `TOKENLEADER_DASHBOARD_TOKEN` set | inherits the dashboard token |
| both unset | open |

Failures (timing-safe compare):

| Status | Body |
|---|---|
| `401` | `{"error":"missing bearer token"}` |
| `403` | `{"error":"invalid bearer token"}` |

## `GET /api/v1/usage`

Per-user token totals and cost for a date range. Three ways to specify it:

```bash
# 1. Whole UTC month
curl 'https://leaderboard.example.com/api/v1/usage?period=2026-05'

# 2. Single UTC day
curl 'https://leaderboard.example.com/api/v1/usage?period=2026-05-15'

# 3. Explicit half-open range — unix-ms or ISO-8601 (mixing is fine)
curl 'https://leaderboard.example.com/api/v1/usage?since=2026-05-01&until=2026-06-01'
curl 'https://leaderboard.example.com/api/v1/usage?since=1746057600000&until=1748736000000'
```

With auth:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  'https://leaderboard.example.com/api/v1/usage?period=2026-05'
```

### Response

```json
{
  "since": 1746057600000,
  "until": 1748736000000,
  "sinceIso": "2026-05-01T00:00:00.000Z",
  "untilIso": "2026-06-01T00:00:00.000Z",
  "users": [
    { "user": "alice", "inputTokens": 1234567890, "outputTokens": 12345678, "totalTokens": 1246913568, "costUsd": 1234.56 },
    { "user": "bob",   "inputTokens": 987654321,  "outputTokens": 8765432,  "totalTokens": 996419753,  "costUsd": 876.54 }
  ],
  "totals": { "inputTokens": 2222222211, "outputTokens": 21111110, "totalTokens": 2243333321, "costUsd": 2111.10 }
}
```

### Field semantics

- **`inputTokens`** = `input + cacheCreation + cacheRead` — every token the
  model read; cost still bills each bucket at its own rate.
- **`outputTokens`** — everything produced; reasoning tokens are already in
  the source's output figure where reported, never added twice.
- **`costUsd`** — source-provided cost wins (Cursor reports its own); other
  rows are priced per-model from a bundled LiteLLM snapshot, refreshed daily;
  models missing from the table contribute zero cost. Identical math to the
  dashboard, so the two reconcile exactly.
- **Sort:** `costUsd` descending; ties alphabetical by `user`.
- **`totals`** — re-summed from unrounded values (one rounding pass).

### Errors (HTTP 400, `{"error": "..."}`)

| Condition | `error` |
|---|---|
| malformed `period` | `period must be YYYY-MM (UTC month) or YYYY-MM-DD (UTC day)` |
| neither `period` nor both `since`+`until` | ``provide either `period=YYYY-MM`/`period=YYYY-MM-DD` or both `since` and `until` (unix-ms integer or ISO-8601 UTC)`` |
| malformed `since` | `` `since` must be a unix-ms integer or ISO-8601 datetime`` |
| malformed `until` | `` `until` must be a unix-ms integer or ISO-8601 datetime`` |
| `until <= since` | `` `until` must be strictly greater than `since` (range is half-open)`` |

## `GET /health`

Open, never auth-gated. For load balancers and uptime checks:

```json
{ "ok": true, "uptimeMs": 123456, "eventsCount": 1048576 }
```

## Daemon-facing routes

Daemons and the rendered scripts are the only intended clients:

| Route | What |
|---|---|
| `POST /ingest` | daemon posts event batches (max 1000/request); auth = per-user TOFU secret header, plus the join token on first claim of a new name; an optional `X-Tokenleader-Company` header (from `TOKENLEADER_COMPANY`) upserts the user's company domain |
| `POST /events/uninstall` | uninstall script revokes this machine's device; the name becomes re-claimable only when the last device goes (same secret auth) |
| `POST /devices/link` | mint a one-time pairing code (10-min TTL) for adding another machine to your handle; auth = any of your devices' secrets |
| `GET /devices?user=` | list your active devices (same secret auth); `current` marks the calling machine |
| `POST /devices/revoke` | revoke one device by id (same secret auth); revoking the last device marks the user uninstalled |
| `POST /admin/link` | mint a pairing code with the admin bearer instead of a device secret — for when a user's only machine is gone |
| `GET /manifest.json` | current daemon release manifest (503 until the server's mirror has synced) |
| `GET /bin/*` | daemon binaries, streamed from the server's local mirror cache |
| `GET /install`, `GET /uninstall` | rendered bash scripts, parameterized by the server's URL and join posture |
| `GET /login`, `POST /login` | dashboard cookie auth (only when a dashboard token is set) |
| `POST /admin/clear` | destructive maintenance, admin bearer only — see [self-hosting.md](self-hosting.md#operations) |
