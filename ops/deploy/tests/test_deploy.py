"""Run: python3 -m unittest discover -s ops/deploy/tests -v. No real Docker."""
import hashlib
import hmac
import http.client
import importlib.util
import json
import os
from pathlib import Path
import socket
import subprocess
import tempfile
import threading
import time
import unittest

DEPLOY = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('receiver', DEPLOY / 'receiver.py')
receiver = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receiver)
IMAGE = 'ghcr.io/tursom/steam-chat@sha256:' + 'a' * 64
REVISION = 'b' * 40
SECRET = 'test-secret-' * 4


class HTTPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.script = self.root / 'fake-deploy'
        self.script.write_text('#!/usr/bin/env python3\nimport pathlib, sys, time\n'
                               'root = pathlib.Path(__file__).parent\n'
                               'with (root / "calls").open("a") as f: f.write(" ".join(sys.argv[1:]) + "\\n")\n'
                               'while not (root / "release").exists(): time.sleep(.01)\n'
                               'sys.exit(1 if (root / "fail").exists() else 0)\n')
        self.script.chmod(0o700)
        self.jobs = receiver.Jobs(self.root / 'state', str(self.script))
        self.server = receiver.Server(('127.0.0.1', 0), self.jobs, SECRET, body_timeout=.2)
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.start()

    def tearDown(self):
        (self.root / 'release').touch()
        self.wait_idle()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.jobs.owner.close()
        self.temp.cleanup()

    def job(self, **kw):
        return dict(image=IMAGE, revision=REVISION, run_number=10, run_attempt=1, **kw)

    def request(self, job=None, timestamp=None, tamper=False, path='/deploy', raw=None):
        raw = json.dumps(job or self.job()).encode() if raw is None else raw
        timestamp = str(int(time.time()) if timestamp is None else timestamp)
        signature = hmac.new(SECRET.encode(), timestamp.encode() + b'.' + raw, hashlib.sha256).hexdigest()
        if tamper:
            raw += b' '
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        conn.request('POST', path, raw, {'X-Deploy-Timestamp': timestamp, 'X-Deploy-Signature': signature})
        response = conn.getresponse()
        result = response.status, json.loads(response.read())['status']
        conn.close()
        return result

    def wait_idle(self):
        deadline = time.monotonic() + 3
        while self.jobs.active and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertFalse(self.jobs.active)

    def finish(self):
        (self.root / 'release').touch()
        self.wait_idle()

    def test_success_replay_and_arguments(self):
        self.assertEqual(self.request(), (202, 'accepted'))
        self.assertEqual(self.request(), (202, 'running'))
        self.finish()
        self.assertEqual(self.request(), (200, 'succeeded'))
        self.assertEqual((self.root / 'calls').read_text().splitlines(), [IMAGE + ' ' + REVISION])
        self.assertEqual((self.jobs.path.stat().st_mode & 0o777), 0o600)
        self.assertEqual(((self.jobs.directory / 'run-10-1.log').stat().st_mode & 0o777), 0o600)

    def test_tampering_expiry_and_future(self):
        self.assertEqual(self.request(tamper=True)[0], 401)
        for timestamp in (time.time() - 301, time.time() + 302):
            self.assertEqual(self.request(timestamp=int(timestamp))[0], 401)
        self.assertFalse((self.root / 'calls').exists())

    def test_validation_and_route(self):
        for key, value in [('image', 'other/image:latest'), ('revision', 'abc'),
                           ('run_number', True), ('run_attempt', 0), ('extra', 1)]:
            job = self.job()
            job[key] = value
            self.assertEqual(self.request(job)[0], 400)
        self.assertEqual(self.request(raw=b'[]')[0], 400)
        self.assertEqual(self.request(raw=b'{' + b' ' * 4096)[0], 413)
        self.assertEqual(self.request(path='/elsewhere')[0], 404)
        self.assertEqual(self.request(raw=b'{"image":1,"image":2}')[0], 400)

    def test_monotonic_busy_and_conflict(self):
        self.assertEqual(self.request()[0], 202)
        job = self.job()
        job['run_number'] = 11
        self.assertEqual(self.request(job), (409, 'busy'))
        job['run_number'] = 9
        self.assertEqual(self.request(job), (200, 'superseded'))
        job = self.job()
        job['image'] = IMAGE[:-1] + 'c'
        self.assertEqual(self.request(job), (409, 'conflict'))
        self.finish()
        job = self.job()
        job['run_number'] = 11
        self.assertEqual(self.request(job)[0], 202)
        self.wait_idle()
        self.assertEqual(self.request(), (200, 'superseded'))

    def test_failed_retry_new_attempt_only(self):
        (self.root / 'fail').touch()
        self.assertEqual(self.request()[0], 202)
        self.finish()
        self.assertEqual(self.request(), (500, 'failed'))
        (self.root / 'fail').unlink()
        job = self.job()
        job['run_attempt'] = 2
        self.assertEqual(self.request(job)[0], 202)
        self.wait_idle()
        self.assertEqual(self.request(job), (200, 'succeeded'))
        self.assertEqual(len((self.root / 'calls').read_text().splitlines()), 2)

    def test_concurrent_same_job_launches_once(self):
        barrier = threading.Barrier(8)
        results = []
        def send():
            barrier.wait()
            results.append(self.request())
        threads = [threading.Thread(target=send) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(results), 8)
        self.assertTrue(all(code == 202 for code, _ in results))
        self.assertEqual(sum(status == 'accepted' for _, status in results), 1)
        self.finish()
        self.assertEqual(len((self.root / 'calls').read_text().splitlines()), 1)

    def test_restart_marks_running_failed_and_preserves_success(self):
        state = {'highest': 12, 'runs': {
            '12': {'image': IMAGE, 'revision': REVISION, 'attempts': {'1': 'running'}},
            '11': {'image': IMAGE, 'revision': REVISION, 'attempts': {'1': 'succeeded'}}}}
        directory = self.root / 'restart'
        directory.mkdir()
        receiver.atomic_json(directory / 'state.json', state)
        restarted = receiver.Jobs(directory, str(self.script))
        try:
            self.assertEqual(restarted.state['runs']['12']['attempts']['1'], 'failed')
            self.assertEqual(restarted.state['runs']['11']['attempts']['1'], 'succeeded')
            self.server.jobs = restarted
            job = self.job()
            job['run_number'] = 12
            self.assertEqual(self.request(job), (500, 'failed'))
            self.assertEqual(self.request(), (200, 'superseded'))
            with self.assertRaises(BlockingIOError):
                receiver.Jobs(directory, str(self.script))
        finally:
            restarted.owner.close()

    def test_concurrency_limit_closes_excess_request(self):
        for _ in range(16):
            self.assertTrue(self.server.slots.acquire(blocking=False))
        try:
            sock = socket.create_connection(self.server.server_address)
            sock.settimeout(2)
            self.assertEqual(sock.recv(1), b'')
            sock.close()
            self.assertFalse(self.jobs.active)
        finally:
            for _ in range(16):
                self.server.slots.release()

    def test_persistence_failure_does_not_accept(self):
        from unittest.mock import patch
        with patch.object(receiver, 'atomic_json', side_effect=OSError('synthetic')):
            self.assertEqual(self.request(), (503, 'unavailable'))
        self.assertEqual(self.jobs.state['highest'], 0)
        self.assertFalse(self.jobs.active)
        self.assertFalse((self.root / 'calls').exists())

    def test_missing_auth_rejected(self):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=2)
        conn.request('POST', '/deploy', json.dumps(self.job()))
        response = conn.getresponse()
        self.assertEqual(response.status, 400)
        response.read()
        conn.close()
        self.assertFalse(self.jobs.active)

    def test_body_timeout(self):
        sock = socket.create_connection(self.server.server_address)
        timestamp = str(int(time.time()))
        sock.sendall(('POST /deploy HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n'
                      'X-Deploy-Timestamp: ' + timestamp + '\r\nX-Deploy-Signature: ' + 'a' * 64 + '\r\n\r\n').encode())
        sock.settimeout(2)
        self.assertIn(b'408', sock.recv(4096))
        sock.close()


DOCKER = '''#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
args = sys.argv[1:]
root = Path(os.environ['DEPLOY_ROOT'])
with (root / 'commands').open('a') as f: f.write(json.dumps(args) + '\\n')
mode = os.environ.get('FAKE_FAIL', '')
image = 'ghcr.io/tursom/steam-chat@sha256:' + 'a' * 64
if args[0] == 'pull':
    sys.exit(1 if mode == 'pull' else 0)
if args[:2] == ['image', 'inspect']:
    if 'Labels' in args[3]: print('c' * 40 if mode == 'label' else 'b' * 40)
    else: print('sha256:' + 'd' * 64)
elif args[0] == 'compose':
    if 'stop' in args:
        (root / 'stopped').touch()
        sys.exit(1 if mode == 'stop' else 0)
    if 'up' in args:
        (root / 'started').touch()
        sys.exit(1 if mode == 'up' else 0)
    if 'ps' in args: print('new' if (root / 'started').exists() else 'old')
elif args[0] == 'inspect':
    fmt = args[2]
    if 'State.Running' in fmt: print('false')
    elif 'Health' in fmt: print('unhealthy' if mode == 'health' else 'healthy')
    elif 'Config.Image' in fmt: print(image if args[-1] == 'new' else 'old:image')
    elif '.Image' in fmt: print('sha256:' + ('e' if mode == 'digest' else 'd') * 64)
elif args[0] == 'start':
    (root / 'restarted').touch()
'''


class ScriptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / 'data').mkdir()
        (self.root / 'data' / 'account-test.txt').write_text('synthetic test data')
        (self.root / 'docker-compose.yml').write_text('services:\n  steam-chat:\n    image: old:image\n')
        self.old = 'services:\n  steam-chat:\n    image: previous:image\n'
        (self.root / 'compose.deploy.yml').write_text(self.old)
        (self.root / 'deploy-metadata.json').write_text('{"image":"previous:image"}')
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        docker = self.bin / 'docker'
        docker.write_text(DOCKER)
        docker.chmod(0o700)
        self.env = dict(os.environ, DEPLOY_ROOT=str(self.root), PATH=str(self.bin) + ':' + os.environ['PATH'])

    def tearDown(self):
        self.temp.cleanup()

    def run_script(self, failure='', image=IMAGE):
        self.env['FAKE_FAIL'] = failure
        return subprocess.run(['bash', str(DEPLOY / 'deploy.sh'), image, REVISION],
                              env=self.env, capture_output=True, text=True, timeout=10)

    def test_success_backup_override_and_exact_commands(self):
        result = self.run_script()
        self.assertEqual(result.returncode, 0, result.stderr)
        backups = list((self.root / 'backups').iterdir())
        self.assertEqual(len(backups), 1)
        backup = backups[0]
        self.assertEqual(backup.stat().st_mode & 0o777, 0o700)
        self.assertEqual((backup / 'data.tar.gz').stat().st_mode & 0o777, 0o600)
        self.assertEqual((backup / 'compose.deploy.yml').read_text(), self.old)
        import tarfile
        with tarfile.open(backup / 'data.tar.gz') as archive:
            self.assertEqual(archive.extractfile('data/account-test.txt').read(), b'synthetic test data')
        self.assertEqual((self.root / 'compose.deploy.yml').read_text(),
                         'services:\n  steam-chat:\n    image: ' + IMAGE + '\n')
        commands = [json.loads(line) for line in (self.root / 'commands').read_text().splitlines()]
        self.assertEqual(commands[0], ['pull', IMAGE])
        up = next(command for command in commands if 'up' in command)
        self.assertEqual(up[up.index('up'):], ['up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180', 'steam-chat'])
        stop = next(command for command in commands if 'stop' in command)
        self.assertEqual(stop[-4:], ['stop', '--timeout', '60', 'steam-chat'])
        self.assertFalse((self.root / 'restarted').exists())

    def test_preflight_failure_never_stops(self):
        for failure in ('pull', 'label'):
            with self.subTest(failure=failure):
                self.assertNotEqual(self.run_script(failure).returncode, 0)
                self.assertFalse((self.root / 'stopped').exists())
                self.assertEqual((self.root / 'compose.deploy.yml').read_text(), self.old)

    def test_invalid_digest_never_calls_docker(self):
        self.assertNotEqual(self.run_script(image='other/image:latest').returncode, 0)
        self.assertFalse((self.root / 'commands').exists())

    def test_backup_failure_restarts_old(self):
        tar = self.bin / 'tar'
        tar.write_text('#!/bin/sh\nexit 1\n')
        tar.chmod(0o700)
        self.assertNotEqual(self.run_script().returncode, 0)
        self.assertTrue((self.root / 'restarted').exists())
        self.assertFalse((self.root / 'started').exists())
        self.assertEqual((self.root / 'compose.deploy.yml').read_text(), self.old)

    def test_stop_failure_restarts_old(self):
        self.assertNotEqual(self.run_script('stop').returncode, 0)
        self.assertTrue((self.root / 'restarted').exists())
        self.assertFalse((self.root / 'started').exists())

    def test_post_start_failures_never_rollback(self):
        for failure in ('up', 'health', 'digest'):
            with self.subTest(failure=failure):
                self.assertNotEqual(self.run_script(failure).returncode, 0)
                self.assertTrue((self.root / 'started').exists())
                self.assertFalse((self.root / 'restarted').exists())
                self.assertIn(IMAGE, (self.root / 'compose.deploy.yml').read_text())

    def test_lock_blocks_deployment(self):
        import fcntl
        with (self.root / '.deploy.lock').open('w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assertNotEqual(self.run_script().returncode, 0)
            self.assertFalse((self.root / 'commands').exists())


if __name__ == '__main__':
    unittest.main()
