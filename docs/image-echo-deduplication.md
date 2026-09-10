# Outgoing image echo identity

## Cause and reproduction

`steamcommunity.sendImageToUser` can return only the uploaded image URL, without
Steam's message timestamp or ordinal. The chat service persists an `image` event
with a local timestamp. Steam separately emits a `message` event containing a
complete `[img src=...]...[url=...]...[/url][/img]` block and a server timestamp.
Text-based Steam event keys cannot identify these representations as the same send.

The production example supplied for investigation contains two JSONL rows with
image event ID `8f5aff9290bb36c04bde4fab8afa349e` at
`2026-09-10T08:26:37.283`, plus BBCode event ID
`7a8392e2469bd335467ad43616e6b4e6` at `2026-09-10T08:26:37.000`.
Identical-ID JSONL rows are expected counterpart/retry writes. The distinct BBCode
ID is a separate logical history/sync row. These timestamps alone do not prove
which callback created that row; no new production inspection was performed.

Regression tests reproduce the historical-import bypass through the actual chat
service, message logger, Steam history callback, and both writer processes. Before
the fix, both cache-expiry and process-restart cases exposed two outgoing rows.
The earlier implementation remembered the Steam alias only in a 30-second cache.
The immutable upload record did not retain Steam's timestamp, payload or key.

## Pairing and durable aliases

The upload callback and realtime message logger annotate inputs with an internal
`imageSendSource`. Shared history ingestion pairs one upload with one image echo,
in either arrival order, when account, peer and full-size source URL agree.
Both arrival times and message timestamps must be within the 30-second window.
URL query parameters remain significant; thumbnails are not used for matching.
Captioned messages, multiple image blocks and historical imports do not perform
URL/time pairing. Independent uploads are never paired with each other.

The first accepted immutable event wins. Its identity and content are reused by
the HTTP response, WebSocket notification, RocksDB history and durable sync.
The in-memory candidate cache remains bounded to 1024 entries and 4 MiB.

When a complete outgoing Steam image has an exact Steam event key, each writer
persists a mapping from that key to the full immutable canonical record. The key
includes account, peer, direction, exact BBCode payload, Steam timestamp and
ordinal. The logger preserves server timestamp precision in `sentAt`; display
`date` formatting is not used to discard milliseconds before hashing.
Different Steam keys remain distinct even for identical image URLs.

The logger uses the asynchronous `appendSteamImage` path for both realtime and
historical complete outgoing images. Identity requests are serialized and bounded
by the storage queue count/byte limits. Each lookup waits for earlier queued
writes in each lane, preventing a history callback from overtaking an alias write.
It then resolves both durable copies before admitting the event. A known alias
reuses immutable content and repairs either primary copy through normal enqueues.
Historical replay still does not broadcast old messages. The synchronous `append`
API alone does not resolve durable aliases; new Steam image ingestion callers must
use the asynchronous path.

Both storage lanes receive the immutable event again when a counterpart or replay
is accepted, allowing either lane to recover an earlier failed enqueue. JSONL may
therefore contain identical copies with the same event ID. RocksDB and sync expose
one logical event.

## Storage, failure behavior and backup

Aliases live in additive, versioned sidecar directories:

- `<JSONL path>.steam-image-aliases-v1/`
- `<RocksDB path>.steam-image-aliases-v1/`

Each contains one JSON file per exact Steam image key, sharded by the first two
hexadecimal key characters. Values contain the original canonical message and
therefore need the same access controls as history. Lookups are direct filesystem
reads in the writer processes; no full-history scan or in-memory preload occurs.
Space and inode use grow with the number of indexed images, with two independent
copies. This intentionally trades additional files/fsync work for a bounded change
to the existing writers, without adding another RocksDB instance or changing its
schema. The directories are owned by their existing single writer processes.

The worker writes and fsyncs a temporary alias, renames it, and fsyncs the containing
directories **before** writing the primary message. Retries retain the first
canonical value, repeat the directory durability gate, and reject conflicting
values. Thus a crash may leave an alias before its primary record; replay can
restore that record with its original ID. Incomplete temporary files are ignored.
Neither the JSONL canonical format nor the RocksDB schema/sync cursor changes.

Both missing copies permit a new identity. A known alias from either available
copy permits replay. Conflicting values reject lookup. If a copy is unavailable
and no mapping was found in the other, lookup fails closed because the unavailable
copy could contain the only alias. The logger logs the failure; this path has no
persistent import-retry queue. A later Steam import/reconnect is needed to retry.
Other message types retain their existing independent-writer behavior.

Back up and restore these directories together with their primary histories.
Existing JSONL export/reconcile and RocksDB maintenance commands do not export,
rebuild or relocate aliases. JSONL-only reconstruction cannot recover an upload's
missing Steam key. A rollback to older binaries can read the unchanged primary
formats, but will ignore aliases and can reintroduce the duplicate bypass.
No automatic backfill or schema migration is performed.

## Limits and existing duplicate repair

The durable guarantee begins once an exact alias has been observed and written.
It does not infer aliases for old records. Upload-only records still cannot be
paired if their first echo arrives after cache expiry/restart. If historical
import created a different ID before realtime pairing established the alias,
this change does not merge those existing identities. Changed BBCode, missing
Steam timestamp/ordinal, or different Steam event keys are not fuzzy-matched.
A crash before either alias copy becomes durable remains outside the guarantee.
The short realtime URL/time pairing heuristic still cannot prove identity when
unrelated sends of the same URL interleave; durable lookup does not broaden it.

Existing duplicates and Android caches are not modified. A separate repair should:

1. Back up both primary histories and alias sidecars. Produce a dry-run report
   grouping identical event IDs separately from suspected cross-ID duplicates.
2. Treat identical-ID JSONL copies as one logical event without rewriting the
   append log. For cross-ID candidates, require reviewed evidence linking the
   exact Steam event to the original upload; URL/time proximity alone is not
   enough for automatic merging of repeated sends.
3. Design an explicit canonical-ID/alias or tombstone migration that updates
   history, conversation counts and durable sync consistently, with a client
   cache reset or reconciliation protocol. Merely deleting a server row would
   leave already-synced devices inconsistent.
4. Apply an approved, reversible maintenance operation only after that design
   and its dry-run output are reviewed. This change performs no such repair.

## Verification

`test/image-echo.test.ts` covers real callback/echo flows, historical import after
cache expiry and restart, concurrent replay before queued writes finish, both
pairing orders, repeated same-URL sends with distinct Steam timestamps, immutable
metadata, both primary histories and sync, and degraded-copy behavior. Existing
negative cases cover account/peer isolation, URL differences, markup boundaries,
historical URL/time exclusion and expiry.

`test/history-steam-alias.test.ts` covers sidecar reopen, immutable retries,
conflict rejection, format validation and invalid keys. History storage, logger,
RocksDB, durable-sync and maintenance suites cover the unchanged primary storage
and client sync behavior.
