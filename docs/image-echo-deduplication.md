# Outgoing image echo identity

## Cause

`steamcommunity.sendImageToUser` can return only the uploaded image URL, without
Steam's message timestamp or ordinal. The chat service persisted this as an
`image` event with a local timestamp. Steam separately emitted a `message` event
containing a complete `[img src=...]...[url=...]...[/url][/img]` block and a
second-resolution server timestamp. Text-based Steam event keys cannot identify
these two representations as the same send.

## Reconciliation

The upload callback and realtime message logger annotate their inputs with an
internal `imageSendSource`. This annotation is not part of stored messages or the
client protocol. Shared history ingestion pairs one upload with one image echo,
in either arrival order, when account, peer and full-size source URL agree.
Both arrival times and message timestamps must be within the 30-second window.
URL query parameters remain significant; thumbnails are not used for matching.
Captioned messages, multiple image blocks and historical imports are excluded.

The first accepted immutable event wins. Its identity and content are reused by
the HTTP response, WebSocket notification, RocksDB history and durable sync.
Steam event-key aliases prevent repeated echoes from consuming another pending
upload. Multiple independent uploads are never paired with each other. The
existing cache bounds (1024 entries, 4 MiB) still apply.

Both storage lanes receive the same immutable event again when a counterpart is
accepted, allowing either lane to recover an earlier failed enqueue. JSONL may
therefore contain identical copies with the same event ID, as it already does
for text echoes. RocksDB and sync expose one logical event.

## Limits And Verification

Matching is deliberately bounded and process-local. It does not merge late
counterparts after expiry or restart, and does not repair existing duplicate
records or existing Android caches. Historical cleanup requires a separate,
backed-up maintenance operation with a client-cache strategy.

`test/image-echo.test.ts` reproduces both callback/echo orders through the actual
chat service, Steam event logger, JSONL and RocksDB writers, history and sync.
It also covers one-to-one pairing, repeated Steam events, repeated sends,
account/peer isolation, URL differences, markup boundaries and expiry.
