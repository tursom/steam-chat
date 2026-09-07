# Offline History Operations

These commands are explicit maintenance, not the realtime write path. Read
[the storage design](chat-history-lsm-storage.md) for the independent dual-writer
contract. Run from `steam-chat`. `npm run history:maintain -- ...` builds and runs
the compiled maintenance module.

## Stop Before Maintenance

Stop steam-chat and every process writing the database or source logs. Allow both
writer queues to drain and both stores to close first. Keep them stopped through
validation, repair, publication and backup. The CLI warns but cannot prove that
all JSONL writers are stopped. RocksDB open/lock errors are fatal: do not delete
LOCK files, bypass locking, kill processes from the CLI, or run a second writer.
The source must be a regular, immutable offline file. Size, identity and timestamp
checks catch common changes during scanning, but are not a substitute for stopping
writers. The source index freezes validated records for the repair pass.

Runtime paths are controlled by `STEAM_CHAT_DATA_DIR`, `STEAM_CHAT_LOG_PATH` and
`STEAM_CHAT_DB_PATH`. Pass explicit `--db` and `--file` paths to maintenance; it
does not infer the database or source from runtime environment variables. Confirm
the deployed configuration before running any command. The storage wrapper uses
`@harperfast/rocksdb-js`; maintenance does not open another binding or bypass its
conflict and locking rules.

## Import

Keep a source manifest with the immutable file, account, timezone and stable
32-hex source identity. Generate the identity once, for example with
`node -e "console.log(require('node:crypto').randomBytes(16).toString('hex'))"`, and
record it in the manifest before importing.

```sh
npm run history:maintain -- import --db /backup/chat.rocksdb --file /backup/legacy.jsonl --account 76561198000000001 --timezone +08:00 --source-id 0123456789abcdef0123456789abcdef
```

`--account` supplies missing account ownership, never overrides an explicit
account. A file containing explicit accounts may contain multiple accounts; this
option is not a filter. `--timezone` is required for imports and reconciliation:
use `UTC` or a fixed offset from `-14:00` to `+14:00`. Named zones and implicit host
local time are rejected. Legacy dates use this offset unless they already carry
an explicit zone. `sentAt` must carry its own zone. Invalid dates are rejected,
not replaced with the current time. Missing ordinal becomes zero.

New-format records retain their event identity and instant, normalized through the
shared message API. Missing event IDs are the first 128 bits of SHA-256 over UTF-8
`steam-chat-history-import:v1`, NUL, lowercase source ID, NUL, decimal line-start
byte offset. `--source-id` is mandatory only when a record lacks an event ID.
Copies of an unchanged source must reuse its identity, timezone and account.
Reordering, editing, newline conversion or truncation changes offsets and can
cause conflicts or duplicates. Different source IDs do not deduplicate the same
legacy business messages. Preserve the manifest and original bytes permanently.

The current core has no atomic source cursor API. Every rerun scans from byte zero;
event-ID checks make inserts idempotent. This is not transactional cursor resume
or cross-file business deduplication. An interrupted repair may commit a prefix;
rerun against the unchanged source to finish. The CLI prints JSON counts for
source physical lines, newly inserted events and exported events; duplicate
physical lines with identical IDs/content count as source lines but not inserts.

## Export And Restore

```sh
npm run history:maintain -- export --db /backup/chat.rocksdb --output /backup/history-export-001.jsonl
npm run history:maintain -- import --db /backup/rebuilt.rocksdb --file /backup/history-export-001.jsonl --account 76561198000000001 --timezone UTC
```

Exports include all accounts, preserve event IDs and can rebuild a new database.
The output must be NEW, with an existing parent directory. Data is written to a
private temporary file in that directory, fsynced, and published with an exclusive
hard link, then the parent directory is fsynced. Existing files, symlinks and
directories are never overwritten. The filesystem must support hard links and
directory fsync; failures are reported rather than using unsafe rename fallback.
A publication failure after linking can leave a complete output visible; inspect
it before choosing a new filename. Abrupt process termination may leave private
`.history-output-*` temporary directories; inspect and remove these only offline.

## Reconcile

```sh
npm run history:maintain -- reconcile --db /backup/chat.rocksdb --file /backup/chat.jsonl --account 76561198000000001 --timezone +08:00 --source-id 0123456789abcdef0123456789abcdef --output /backup/recovery-001.jsonl
```

The complete source is indexed in a temporary RocksHistoryStore. Duplicate IDs
must have identical canonical content. Every source ID is also checked against
the target before any repair. Conflicts abort; the CLI never chooses a winner.
After validation, source-only events are inserted into the database and DB-only
events are published in a separate recovery JSONL. It never appends to or edits
the source log, never broadcasts repairs, and never starts a tailer.

Reconciliation compares the entire database against exactly the supplied source,
not an account-filtered subset or every log on disk. Use a complete offline source
covering the intended accounts and sealed segments; otherwise records absent from
that particular file will be exported as DB-only. Review the recovery segment and
include it in the managed log/backup manifest and subsequent reconciliation input.
Running against the same unaugmented source again emits the same DB-only events
into a new file. There is no persistent published-segment ledger or exactly-once
external import guarantee. Database repair and file publication are not one atomic
transaction; a disk failure can leave committed DB repairs without a published
segment. Rerunning with unchanged input is safe for the DB, and can regenerate the
segment. Do not repeatedly ingest duplicate recovery segments into downstream
consumers that lack event-ID deduplication.

## Invalid Input And Resources

Input is streamed in 64 KiB reads with a 1 MiB maximum JSONL line. Invalid UTF-8,
blank/malformed records, invalid fields, oversized lines and an unterminated final
line abort with a line/byte diagnostic and a nonzero exit status. Validation occurs
before target inserts. No invalid line is silently skipped, repaired or deleted;
the untouched source is the retained evidence, not a separately generated
quarantine file. Preserve it and the error output. Resolve the reported problem
on a reviewed copy and assess legacy offset/identity consequences before rerunning.
A syntactically valid final record still requires a newline.

The temporary source index lives under the OS temporary directory (`TMPDIR` can
select another volume). Reserve space for another indexed copy of the source,
RocksDB WAL/compaction, and the recovery output. JavaScript memory is line-bounded;
engine cache/memtable budgets belong to RocksHistoryStore. Validation stops at the
first bad line or conflict. Cleanup closes all stores and removes temporary files
on normal success/failure. A crash can leave `history-source-*` directories; remove
only abandoned maintenance directories after confirming no maintenance process is
using them.

## Backups And Failure Semantics

Without an exposed, verified live checkpoint API, use stop-copy backups: stop all
writers, drain and close both stores, copy the ENTIRE RocksDB directory and sealed
JSONL files plus source/segment manifests to another volume or remote storage,
then restart. Never copy an actively changing RocksDB directory as a consistent
backup. Test restoration into a separate new directory, export/reconcile and
inspect counts and conflicts before switching runtime paths. Keep the original
backup until verification succeeds; database rebuilds invalidate old query cursors.

Realtime JSONL and RocksDB receive the same immutable event independently. JSONL
success with DB failure requires explicit import/repair; DB success with JSONL
failure requires a recovery segment. Neither success waits for the other, neither
failure cancels the other, and storage repair never resends a Steam message. Both
copies failing means there is no confirmed local recovery source. There is no
automatic JSONL tail/import in normal operation. Two copies on one disk are not a
disaster backup, and these commands cannot recover events missing from both.
