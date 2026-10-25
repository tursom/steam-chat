# Web behavior on high-latency connections

The Web client displays cached conversations immediately and reconciles them with the server. A local send preview is not a delivery acknowledgement. The existing durable message cursor and server send-operation states remain authoritative.

## Local history

- Up to 20 visited conversations are retained in memory, including pagination, date browsing and reading position. A conversation exceeding 1,000 loaded messages is not copied into this cache; its active history remains available.
- IndexedDB stores one snapshot for the current backend user, session version and Steam account. It expires after 24 hours and includes at most 100 conversation summaries and 20 threads of at most 500 messages each. Serialized snapshots are limited to 2 million UTF-16 code units (approximately 4 MiB).
- Disk data is restored only after `/api/auth/me` confirms the user and account access. Logout, account changes, lost authorization and expired authentication clear the cache. A network error during startup keeps the disk snapshot for the next authenticated opening, but does not expose it offline.
- New network results win over disk hydration, even when the server returns an empty list. Latest history restored from disk is rebased against the server to avoid hiding an offline gap behind a stale pagination cursor. Date views remain date views until the user requests latest messages.
- A rejected durable cursor invalidates pagination in every cached thread. The next read establishes fresh boundaries (including date pages); overlap with a realtime tail is not treated as proof that the missing interval was loaded.
- IndexedDB failure is nonfatal; the in-memory cache and network path remain usable.

## Requests and reconnection

- `/api/auth/me` includes Web configuration. Older servers can still use the `/api/config` fallback. Friends and groups load independently; Steam emoji/sticker inventory loads on first picker use.
- Initial durable sync captures its boundary before loading conversations and the active history concurrently. This ordering must be preserved: accepting a later boundary with an earlier baseline can skip messages.
- Returning to the foreground probes an existing open WebSocket instead of unconditionally closing it. A missing pong has a 45-second deadline. Ordinary reads and sync pages have a 30-second deadline.
- With a healthy socket and Steam online, status is checked every 30 seconds; durable catch-up has a 60-second fallback. Disconnected foreground status/sync intervals are 10/15 seconds. Hidden tabs defer these checks to 120 seconds. Durable push hints coalesce for 250 ms, without delaying the separate realtime message push.
- Storage health is checked at most once per minute by polling (plus initial page load); reactions at most once per 30 seconds outside explicit history loads. Image-operation queries are normally spaced 15 seconds with an open socket, 5 seconds while sending without one, and 60 seconds in hidden tabs. Explicit recovery queries still run immediately.

## Images and static resources

- Capable clients upload to `/api/send-operations/upload` with a random client operation ID. Identity and image bytes travel in one request. The browser saves the ID before uploading; a lost response causes a lookup of that ID, not an automatic second send. Older servers/clients retain the two-stage API.
- Explicit image-format/size rejections remain failed when lookup finds an unstarted task or no task. A later confirmed queued/sending/sent state takes precedence over that local failure.
- Message images and stickers use native lazy loading and asynchronous decoding. Known Steam image dimensions reserve their layout; unknown image sizes have a temporary placeholder. Conversation rows are reused when their visible data has not changed.
- `npm run build` creates content-versioned JS/CSS references and a matching Service Worker manifest. Only verified public build resources are cached by the worker. Auth APIs and user media do not enter its cache.
- A worker update waits for old controlled tabs to close, so a running page keeps one matching HTML/JS/CSS build. Close all app tabs/windows and reopen to activate a downloaded update. First deployment of this cache requires a successful online installation.

## Verification

Run `npm test` and `npm run typecheck`. Frontend tests hold responses pending to verify immediate cached rendering, out-of-order results, account isolation, pagination boundaries, connection reuse and upload-response recovery. Backend tests verify operation ownership and idempotency; Service Worker tests execute install/fetch/activation against mocked caches and fetches.

For browser acceptance, use DevTools custom throttling with an RTT representative of the deployment (for example 800–1,500 ms), then:

1. Open two conversations, scroll up in one, and switch repeatedly. Cached history and reading position should appear before requests complete.
2. Refresh with a warm cache. The shell can load locally; private data appears only after the authentication response. Check that there is no additional initial status/config request.
3. Switch tabs briefly and return. The existing healthy WebSocket should remain, and missing messages should catch up once.
4. Lose connectivity during an image upload after request transmission. The row must remain uncertain until the original operation is queried; no second upload should occur automatically.
5. Switch accounts or log out and log in as another user. Old cached history must not appear.
6. Load older/date history, restore from cache, and reconnect after more than one page of arrivals. Confirm there are no duplicate rows or inaccessible gaps.

These automated checks do not establish a measured latency or frame-rate improvement on a real device. Long-history virtualization and transport/proxy tuning should follow browser profiling if they remain necessary.
