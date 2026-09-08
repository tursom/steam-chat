import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy_client', Path(__file__).with_name('deploy-webhook.py'))
client = importlib.util.module_from_spec(spec)
spec.loader.exec_module(client)


class Response:
    code = 200

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def read(self, limit):
        return b'{"status":"succeeded"}'


class ClientTest(unittest.TestCase):
    def setUp(self):
        self.enterContext(patch('builtins.print'))

    def test_signature_covers_exact_timestamp_and_body(self):
        payload = b'{ "run_number": 1 }\n'
        req = client.signed_request('https://example.test/api/deploy', 'secret', payload, 123)
        expected = hmac.new(b'secret', b'123.' + payload, hashlib.sha256).hexdigest()
        self.assertEqual(req.get_header('X-deploy-signature'), expected)
        self.assertEqual(req.data, payload)
        self.assertEqual(req.method, 'POST')
        self.assertEqual(req.get_header('User-agent'), 'steam-chat-deploy/1.0')

    def test_redirects_never_forward_signed_requests(self):
        self.assertIsNone(client.NoRedirect().redirect_request(None, None, 307, '', {}, 'https://other.test'))

    def test_missing_or_insecure_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(client.main(), 0)
        for url in ['http://example.test', 'https://user:pass@example.test', 'https://example.test/#secret']:
            with patch.dict(os.environ, {'DEPLOY_WEBHOOK_URL': url, 'DEPLOY_WEBHOOK_SECRET': 'a' * 64}, clear=True):
                self.assertEqual(client.main(), 1)

    def test_success_sends_the_build_digest_and_run_identity(self):
        env = {'DEPLOY_WEBHOOK_URL': 'https://example.test/api/deploy', 'DEPLOY_WEBHOOK_SECRET': 'a' * 64,
               'DEPLOY_IMAGE': 'ghcr.io/tursom/steam-chat@sha256:' + 'b' * 64,
               'GITHUB_SHA': 'c' * 40, 'GITHUB_RUN_NUMBER': '12', 'GITHUB_RUN_ATTEMPT': '2'}
        with patch.dict(os.environ, env, clear=True), patch.object(client.urllib.request, 'build_opener') as build:
            build.return_value.open.return_value = Response()
            self.assertEqual(client.main(), 0)
            request = build.return_value.open.call_args.args[0]
            self.assertEqual(json.loads(request.data), {'image': env['DEPLOY_IMAGE'], 'revision': env['GITHUB_SHA'], 'run_number': 12, 'run_attempt': 2})


if __name__ == '__main__':
    unittest.main()
