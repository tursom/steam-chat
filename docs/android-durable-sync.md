# Durable Message Sync

Backend contract for a direct-message Android client with images and Steam
emotes. No Android or Web changes and no group-chat model are included.
Existing Web history/conversation endpoints keep their timestamp-oriented paging.

## HTTP Contract

```http
GET /api/messages/sync?cursor=<opaque>&limit=100
Cookie: steam_chat_session=...
```

```ts
{
  items: Array<HistoryItem & { syncId: string }>;
  nextCursor: string;
  hasMore: boolean;
  steamAccountId: string;
}
```

- Requires a valid application session cookie and current access to the active
  Steam account. LAN access and legacy Basic authentication are not accepted.
  Unauthenticated requests return 401; denied accounts return 403. The Steam
  connection may be offline, provided a saved active account exists.
- Only the active account is queried. A supplied `steamAccountId` cannot select
  another account. Unattributed legacy JSONL is never included or scanned.
- Omit `cursor` to start at the beginning, across all direct-message peers in
  this account. An explicit empty cursor is invalid. `limit` defaults to 100;
  positive integers above 500 are capped at 500; zero, negative, fractional and
  nonnumeric limits return 400. Each range reads at most limit + 1 index rows.
- `syncId` is the existing stable `eventId`, not a timestamp or new identity.
  All other fields are the stored `HistoryItem` fields, including `id` (peer),
  `steamAccountId`, `type`, `message`, `echo`, `name`, `date`, `sentAt`, `ordinal`
  and `eventId`. Raw message text/BBCode, images and emotes are preserved.
- Results follow RocksDB ingestion/commit order, NOT `sentAt`. A late Steam
  history import or offline repair appears after the previous cursor even when
  its timestamp is older than every previously returned message.
- `nextCursor` is always a string, including empty pages. Empty pages retain
  the input boundary; an empty database returns a reusable beginning cursor.
  `hasMore` describes this page's snapshot, not future appends. Pages are not a
  single long-lived snapshot. Follow `nextCursor` until `hasMore` is false.
- Cursors bind the codec, database generation and account. They survive normal
  server/worker restarts and the in-place index upgrade. Invalid, cross-account,
  missing-boundary and rebuilt-database cursors return HTTP 409 with
  `{ "error": "Invalid or stale sync cursor", "resetRequired": true }`.
  Cursors are opaque continuation tokens, not authorization credentials.
- Responses use `Cache-Control: no-store`. Session, grant and active account are
  checked again after awaiting storage. Storage unavailability returns an error,
  normally 503, rather than a successful empty page or JSONL fallback.

## Client Durability And Hints

Persist each page's items and `nextCursor` in one local transaction, deduplicating
by `(steamAccountId, syncId)`. Keep cursors account-scoped. On 409/resetRequired,
restart from an omitted cursor and reconcile using stable IDs. Do not derive a
cursor from timestamps or advance it from WebSocket events or send responses.

`HistoryStorage.sync` runs through the RocksDB worker and its query admission
limit. The index, message, allocator, event mapping and conversation updates are
one RocksDB transaction. Sync reads pass the waiting SST flush gate too, so a
previous append whose commit succeeded but flush failed cannot be exposed as a
durable cursor advance until a flush succeeds.

The existing `onMessage` event remains an immediate, potentially pending Web hint.
`onDurable` fires only after the RocksDB append RPC confirms its waiting flush;
it also fires for silent Steam history supplementation (`notify: false`). The
server then sends authorized active-account sockets:

```json
{ "type": "sync_available", "steamAccountId": "76561198000000001" }
```

Hints are best-effort and may repeat after idempotent retries. They contain no
cursor or message body. JSONL success alone does not produce a durable hint.
Clients must sync on startup/reconnect/foreground and poll periodically while
active, as well as on hints. This covers disconnected sockets, delayed durability,
lost acknowledgments and offline repairs that emit no live hint. Polling cannot
recover a record absent from RocksDB: JSONL-only records require the documented
explicit reconciliation. There is no automatic JSONL replay.

Live WebSocket requests and broadcasts re-read the original handshake cookie
through the session manager, including expiry, revocation, disabled users and
session-version checks. Invalid sessions close with code 1008. Grants are checked
at access/delivery time; sending is rechecked after login/upload waits, and data
replies are rechecked after asynchronous queries. Legacy Web support remains for
existing endpoints but never grants sync API access or durable sync hints.

## Images And Emotes

The installed `steamcommunity.sendImageToUser(userID, buffer, options, callback)`
returns the committed Steam image URL as the callback's second argument, a
string. The server passes an options object and persists that URL in
`HistoryItem.message` with `type: "image"` through the same history append path
as text. Object-shaped `{url}` adapters remain supported; the committed URL takes
precedence over an input download URL. JSONL and RocksDB receive the same event.
This fixes base64 uploads previously persisting an empty image message.

Image bytes are not embedded in history. Clients use the stored source URL with
the existing authenticated `/proxy/image?url=...` path and its remote-host
allowlist. Existing `/api/emoticons`, sticker proxy and raw Steam BBCode remain
unchanged. A Steam acceptance response still does not mean both local writer
lanes have become durable; persistence failure must never cause automatic resend.

## Existing Database Upgrade

Stop and back up the complete database before deployment using
[history storage operations](history-storage-operations.md). Reserve disk for the
additional index, WAL and compaction; do not start an upgrade on an almost-full
production volume.

Opening a schema-1 database fences old writers by changing metadata to schema 2.
The message codec and generation stay unchanged. Index keys are
`0x22 + account(uint64 BE) + allocator recordId(uint64 BE)` (17 bytes); each value
is the original 37-byte message key. Existing message keys already contain the
allocator ID at offset 29, so backfill preserves original ingestion order without
sorting by message time or allocating new identities.

Backfill scans at most 500 message keys per transaction. Index writes and the
last scanned key (`0x01 0x03`) commit atomically, then flush. Restart resumes after
that checkpoint; repeated work is idempotent. Completion records
`syncIndexVersion: 1` in metadata and removes the checkpoint atomically. Reads and
new appends are not admitted until the complete index is available. A worker
startup timeout may interrupt a large upgrade; later starts resume durable
progress. JSONL continues independently, but bounded RocksDB queues can overflow
while unavailable, requiring later reconciliation. Plan an offline upgrade for
large databases to avoid this catch-up gap.

Do not run the old schema-1 executable on an upgraded or partially upgraded DB;
it rejects schema 2 rather than silently omitting index writes. Roll back using
a verified pre-upgrade backup and reconcile later messages, or use a
schema-2-aware build. A rebuild into a new database changes the generation and
requires client reset; a normal reopen does not.

## Verification

`npm test` exercises real RocksDB and worker-backed HTTP pagination beyond 500
rows, restart/account/generation cursor binding, late older timestamps,
idempotent retries, a flush failure, interrupted checkpointed backfill, offline
and denied account access, legacy rejection, durable hints including silent
imports, revoked live sockets/grants and image URL persistence in both stores.
No live Steam upload or physical power-loss test is implied by these tests.
