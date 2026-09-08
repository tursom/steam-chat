#!/usr/bin/env python3
"""Authenticated, single-deployment host receiver. Python 3 standard library only."""
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

IMAGE = re.compile(r"ghcr\.io/tursom/steam-chat@sha256:[0-9a-fA-F]{64}\Z")
REVISION = re.compile(r"[0-9a-fA-F]{40}\Z")


def atomic_json(path, value):
    fd, name = tempfile.mkstemp(prefix='.state-', dir=path.parent)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, separators=(',', ':'))
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(name):
            os.unlink(name)


class Jobs:
    def __init__(self, directory, script):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.directory.chmod(0o700)
        self.path = self.directory / 'state.json'
        self.script = script
        if not os.path.isabs(script):
            raise ValueError('DEPLOY_SCRIPT must be absolute')
        # Hold an OS lock for this receiver's lifetime, including worker threads.
        import fcntl
        self.owner = open(self.directory / 'receiver.lock', 'a')
        try:
            fcntl.flock(self.owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.owner.close()
            raise
        self.lock = threading.Lock()
        self.state = json.loads(self.path.read_text()) if self.path.exists() else {'highest': 0, 'runs': {}}
        for run in self.state['runs'].values():
            run['attempts'] = {k: ('failed' if v == 'running' else v)
                               for k, v in run['attempts'].items()}
        atomic_json(self.path, self.state)
        self.active = False

    def submit(self, job):
        number, attempt = job['run_number'], job['run_attempt']
        with self.lock:
            if number < self.state['highest']:
                return 200, 'superseded'
            run = self.state['runs'].get(str(number))
            if run:
                if run['image'] != job['image'] or run['revision'] != job['revision']:
                    return 409, 'conflict'
                previous = run['attempts'].get(str(attempt))
                if previous:
                    return {'running': 202, 'succeeded': 200, 'failed': 500}[previous], previous
                if attempt < max(map(int, run['attempts'])):
                    return 200, 'superseded'
                if 'succeeded' in run['attempts'].values():
                    return 200, 'succeeded'
            if self.active:
                return 409, 'busy'
            # Do not acknowledge or mutate live state unless the durable write succeeds.
            state = json.loads(json.dumps(self.state))
            run = state['runs'].setdefault(str(number), {
                'image': job['image'], 'revision': job['revision'], 'attempts': {}})
            run['attempts'][str(attempt)] = 'running'
            state['highest'] = number
            atomic_json(self.path, state)
            self.state = state
            self.active = True
            threading.Thread(target=self.execute, args=(job,), daemon=False).start()
            return 202, 'accepted'

    def execute(self, job):
        status = 'failed'
        try:
            # Keep command diagnostics private; never return them through the webhook.
            environment = dict(os.environ)
            environment.pop('DEPLOY_WEBHOOK_SECRET', None)
            log_path = self.directory / f"run-{job['run_number']}-{job['run_attempt']}.log"
            fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as output:
                result = subprocess.run([self.script, job['image'], job['revision']],
                                        env=environment, stdin=subprocess.DEVNULL,
                                        stdout=output, stderr=subprocess.STDOUT)
            if result.returncode == 0:
                status = 'succeeded'
        except (OSError, ValueError):
            pass
        with self.lock:
            state = json.loads(json.dumps(self.state))
            state['runs'][str(job['run_number'])]['attempts'][str(job['run_attempt'])] = status
            try:
                atomic_json(self.path, state)
            except OSError:
                # Fail closed: no further deployments until an operator fixes storage/restarts.
                return
            self.state = state
            self.active = False
            print(f"Deployment run {job['run_number']} attempt {job['run_attempt']}: {status}", flush=True)


class Server(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 32

    def __init__(self, address, jobs, secret, max_requests=16, body_timeout=5):
        if len(secret) < 32:
            raise ValueError('DEPLOY_WEBHOOK_SECRET must contain at least 32 characters')
        self.jobs, self.secret = jobs, secret.encode()
        self.slots = threading.BoundedSemaphore(max_requests)
        self.body_timeout = body_timeout
        super().__init__(address, Handler)

    def get_request(self):
        conn, addr = super().get_request()
        conn.settimeout(self.body_timeout)
        return conn, addr

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # Never print request contents, headers, or exception values.
        pass


class Handler(BaseHTTPRequestHandler):
    server_version = 'DeployReceiver'
    sys_version = ''

    def log_message(self, *_args):
        pass

    def reply(self, code, status):
        data = json.dumps({'status': status}).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(data)
        self.close_connection = True

    def do_POST(self):
        if self.path != '/deploy':
            return self.reply(404, 'not_found')
        for name in ('Content-Length', 'X-Deploy-Timestamp', 'X-Deploy-Signature'):
            if len(self.headers.get_all(name, [])) != 1:
                return self.reply(400, 'invalid_request')
        length = self.headers['Content-Length']
        if self.headers.get('Transfer-Encoding') or not re.fullmatch(r'[0-9]{1,4}', length):
            return self.reply(400, 'invalid_request')
        size = int(length)
        if size > 4096:
            return self.reply(413, 'too_large')
        timestamp, signature = self.headers['X-Deploy-Timestamp'], self.headers['X-Deploy-Signature']
        if (not re.fullmatch(r'[0-9]{1,12}', timestamp)
                or abs(time.time() - int(timestamp)) > 300
                or not re.fullmatch(r'[0-9a-fA-F]{64}', signature)):
            return self.reply(401, 'unauthorized')
        try:
            # Read against a total deadline, not a per-byte slow-client timeout.
            deadline = time.monotonic() + self.server.body_timeout
            chunks = bytearray()
            while len(chunks) < size:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise socket.timeout()
                self.connection.settimeout(remaining)
                chunk = self.rfile.read1(size - len(chunks))
                if not chunk:
                    return self.reply(400, 'invalid_request')
                chunks.extend(chunk)
            raw = bytes(chunks)
        except (socket.timeout, OSError):
            return self.reply(408, 'timeout')
        expected = hmac.new(self.server.secret, timestamp.encode() + b'.' + raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, signature.lower()):
            return self.reply(401, 'unauthorized')
        try:
            def unique(pairs):
                result = {}
                for key, value in pairs:
                    if key in result:
                        raise ValueError('duplicate key')
                    result[key] = value
                return result
            job = json.loads(raw, object_pairs_hook=unique)
            if (not isinstance(job, dict) or set(job) != {'image', 'revision', 'run_number', 'run_attempt'}
                    or not isinstance(job['image'], str) or not IMAGE.fullmatch(job['image'])
                    or not isinstance(job['revision'], str) or not REVISION.fullmatch(job['revision'])
                    or any(type(job[k]) is not int or not 0 < job[k] <= 2**63 - 1
                           for k in ('run_number', 'run_attempt'))):
                raise ValueError('invalid job')
        except (ValueError, UnicodeError, RecursionError):
            return self.reply(400, 'invalid_request')
        try:
            code, status = self.server.jobs.submit(job)
        except OSError:
            return self.reply(503, 'unavailable')
        self.reply(code, status)


def main():
    secret = os.environ.get('DEPLOY_WEBHOOK_SECRET', '')
    if len(secret) < 32:
        raise SystemExit('DEPLOY_WEBHOOK_SECRET must contain at least 32 characters')
    jobs = Jobs(os.environ.get('DEPLOY_STATE_DIR', '/opt/steam-chat/deploy-state'),
                os.environ.get('DEPLOY_SCRIPT', '/opt/steam-chat/deploy/deploy.sh'))
    server = Server((os.environ.get('DEPLOY_BIND', '127.0.0.1'),
                     int(os.environ.get('DEPLOY_PORT', '3001'))), jobs, secret)
    server.serve_forever()


if __name__ == '__main__':
    main()
