# Host deployment receiver

Standalone Python 3 standard-library receiver and Bash deployment script. These files
are host tooling, not part of the application container. Nothing here installs itself.

## Integration contract

The backend relay must forward to a **fixed, operator-configured** host URL, normally
`http://127.0.0.1:3001/deploy` when it shares the host network. Container loopback is
not host loopback. Use a reachable private host address and firewall it to the relay
if running the relay in a container; do not expose this port publicly. HMAC provides
authentication, not encryption. Use TLS across an untrusted network. The relay must
preserve raw request bytes and both HMAC headers, not parse and reserialize JSON.

Only `POST /deploy` accepts jobs (no query string). Body is at most 4096 bytes:

```json
{"image":"ghcr.io/tursom/steam-chat@sha256:<64hex>","revision":"<40hex>","run_number":123,"run_attempt":1}
```

Exact keys only; counters must be positive JSON integers (not booleans), at most
`2^63-1`. Images must use this fixed repository and an immutable digest. Hex values
accept either case; job identity compares the submitted strings exactly, so clients
should consistently use lowercase. Use one stable GitHub workflow's `run_number`
and `run_attempt` namespace, not counters from multiple workflows.

Required headers:

- `Content-Length`: exact byte length; chunked requests are rejected.
- `X-Deploy-Timestamp`: decimal Unix seconds, within 300 seconds of receiver time.
- `X-Deploy-Signature`: hexadecimal HMAC-SHA256 using the shared secret, over
  `timestamp_ascii + b'.' + raw_body`. Keep both hosts' clocks synchronized.

Signing algorithm in Python (equivalent for the workflow client):

```python
raw_body = json.dumps(job, separators=(',', ':')).encode('utf-8')
timestamp = str(int(time.time()))
signature = hmac.new(secret.encode('utf-8'),
                     timestamp.encode('ascii') + b'.' + raw_body,
                     hashlib.sha256).hexdigest()
```

Every response for a handled POST is JSON with a `status` field:

| HTTP | Status | Meaning / caller action |
| --- | --- | --- |
| 202 | `accepted` | Durably recorded; asynchronous deployment started. Poll by POST. |
| 202 | `running` | Same job still in progress. Poll by POST. |
| 200 | `succeeded` | Deployment and identity/health checks succeeded. |
| 200 | `superseded` | Older run or previously unseen older attempt; never deploy it. |
| 409 | `busy` | Another job is active. Retry with backoff. |
| 409 | `conflict` | Same run has a different image or revision. Do not retry unchanged. |
| 500 | `failed` | This attempt failed. Replaying it will not execute again. |
| 400/401/404/408/413 | request error | Invalid input, authentication, path, timeout, or size. |
| 503 | `unavailable` | State persistence failed before acceptance. Operator intervention may be needed. |

Poll with the **same job**, a fresh timestamp and signature, and bounded backoff.
A network timeout is ambiguous; replay the same job to discover its status. Request
saturation can close the connection without a response, which is also retryable.
Do not declare workflow success on 202. A newer `run_attempt` can retry a failed
run; the same run cannot change its image or revision. A successful run is not
redeployed by a newer attempt. Once a higher run is accepted, lower runs are
superseded, even if the higher run eventually fails. Busy rejections do not advance
the high-water mark. Authentication is always checked, including status replays.

## Environment and invocation

| Variable | Required | Default / purpose |
| --- | --- | --- |
| `DEPLOY_WEBHOOK_SECRET` | Yes | No default; at least 32 characters; use a random secret shared with the signing client. |
| `DEPLOY_BIND` | No | `127.0.0.1` |
| `DEPLOY_PORT` | No | `3001` |
| `DEPLOY_STATE_DIR` | No | `/opt/steam-chat/deploy-state` |
| `DEPLOY_SCRIPT` | No | `/opt/steam-chat/deploy/deploy.sh`; must be absolute and executable. |
| `DEPLOY_ROOT` | No | `/opt/steam-chat`; absolute directory containing base Compose file and `data/`. |
| `DOCKER_CONFIG` | For private registry auth | Docker CLI convention; systemd example uses `/etc/steam-chat/docker`. |

After separately provisioning the environment, run the receiver:

```sh
python3 /opt/steam-chat/deploy/receiver.py
```

The receiver invokes the script directly, without a shell, as:

```sh
/opt/steam-chat/deploy/deploy.sh 'ghcr.io/tursom/steam-chat@sha256:<64hex>' '<40hex>'
```

The webhook secret is removed from the child's environment. Child stdout/stderr
are retained in root-only mode-0600 `run-<number>-<attempt>.log` files under the
state directory, never returned through HTTP. Treat these diagnostics as sensitive.
The journal reports only run/attempt numbers and completion status; HTTP access
logs and exception details are not emitted. Inspect the private log and container
status after failure; do not automatically rerun a failed script for diagnostics.
When retrying a failed GitHub run, rerun the failed deployment job with its original
build outputs. Rebuilding can produce a different digest, which conflicts with the
same run identity; use a new workflow dispatch/run for a different digest.

## Host prerequisites and systemd example

Provision these manually through your existing host configuration process:

1. Linux host with Python 3.9+, Bash 4+, Docker Engine, Docker Compose v2 supporting
   `--wait` and `--wait-timeout`, `flock`, GNU `tar`, and coreutils including `sync -f`.
2. Existing `/opt/steam-chat/docker-compose.yml` (falls back to the repo's
   `docker-compose.yaml`), a real `data/` directory mounted into `steam-chat`, and
   exactly one existing service container. This is an update tool, not bootstrap.
   The service must have a working health check. The image must have
   `org.opencontainers.image.revision` equal to the submitted revision.
3. Root-owned receiver and executable script at `/opt/steam-chat/deploy/`; set
   script mode 0755. Host files, environment, state, and backups must not be writable
   by the application or untrusted users. Do not use symlinks for state/backups.
4. Root-owned `/etc/steam-chat/deploy.env`, mode 0600, based on `deploy.env.example`.
   Supply a real random secret; the placeholder deliberately fails validation.
5. Docker registry credentials provisioned independently if necessary. The systemd
   example hides `/root`, so place its Docker config at `/etc/steam-chat/docker`.
6. Install `steam-chat-deploy.service` separately in `/etc/systemd/system/`, review
   its paths and privileges, reload systemd, and enable/start it when ready.

The example runs as root because Docker socket access is already root-equivalent.
`ProtectSystem` is defense in depth, not a sandbox against Docker access. The service
uses `KillMode=control-group` so stopping it does not leave deployment children
running. Avoid receiver restarts while deploying. A restart marks persisted running
jobs **failed**, never succeeded; inspect the actual host before requesting a newer
attempt. An abrupt stop after migration may require manual recovery.

The HTTP server admits at most 16 concurrent request handlers, has a 32-connection
listen backlog, applies 5-second socket timeouts and a 5-second total body deadline,
and uses stdlib request-line/header count/line-length limits. Deployments serialize
in the receiver and independently with host `flock`. There is no deployment queue.
The state directory must be on a local filesystem supporting advisory locks,
atomic rename and fsync. Corrupt state fails startup; do not delete the state to
"fix" it, because that loses replay and monotonic protection. State is retained
without automatic compaction. Storage-write failure after execution leaves the
receiver busy until operator repair/restart rather than claiming success.

## Deployment and recovery safety

The script pulls the exact digest, checks its revision label and records its image
ID **before stopping** anything. It snapshots the previous override, metadata,
container ID, previous image reference/ID and base Compose file into a new 0700 backup
directory. It then stops the service with a 60-second grace period, verifies it is
stopped, and creates and flushes a full `data.tar.gz` with mode 0600. The data directory
must have no other writers; quiesce any external writers before using this tool.
Backup archives contain sensitive account data and must remain private.

Any failure after stopping but before attempting new startup triggers a best-effort
`docker start` of the **existing** old container. This includes tar/disk failures.
After backup, only the service image is written to an atomically replaced persistent
`compose.deploy.yml`. Startup uses:

```sh
docker compose --project-directory /opt/steam-chat \
  -f /opt/steam-chat/docker-compose.yml -f /opt/steam-chat/compose.deploy.yml \
  up -d --no-build --pull never --wait --wait-timeout 180 steam-chat
```

The script verifies health, the running image ID and exact configured digest, then
atomically saves `deploy-metadata.json`. Once `up` is attempted, **no automatic old
image rollback occurs**, even if Compose fails: schema migrations may already have
run. The new override stays installed for diagnosis. No backups are deleted and no
images are pruned. Monitor free disk space and manage retention explicitly.

For all subsequent manual Compose operations, explicitly include both `-f` files
(and substitute `.yaml` when that is your base filename). Compose does **not**
automatically load `compose.deploy.yml`. Omitting it may accidentally use a tag or
older image from the base configuration. Keep the Compose project name/environment
consistent with the existing deployment. Do not overlap manual deployment commands
with this receiver; manual operations must also acquire `.deploy.lock`.

Manual recovery after potential migration requires an operator to stop the service,
choose a consistent backup, restore the complete data directory and matching prior
configuration/image, and then start and verify it. Never restore data over a running
service, and never switch only the image back against possibly migrated data. An
image reference from an old tag is not an immutable recovery guarantee; retain the
old local image and use `previous-image-id.txt` to identify it. Compose recreation
may remove the old container; `previous-container.txt` is an audit record, not a
promise that the container still exists.
The previous override and metadata may be absent for the first managed deployment.

## Tests

From the repository root:

```sh
python3 -B -m unittest discover -s ops/deploy/tests -v
bash -n ops/deploy/deploy.sh
```

Tests use temporary directories, an ephemeral loopback port, a fake deployment
executable, and a fake `docker` first on a test-only PATH. No real Docker, registry,
account or production access is used. Real Compose health/migration behavior and
systemd integration still require operator validation in a separate staging host.
