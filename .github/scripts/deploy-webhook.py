#!/usr/bin/env python3
"""Send and poll one idempotent signed deployment request from GitHub Actions."""
import hashlib
import hmac
import http.client
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def signed_request(url, secret, payload, timestamp):
    stamp = str(timestamp)
    signature = hmac.new(secret.encode(), stamp.encode() + b'.' + payload, hashlib.sha256).hexdigest()
    return urllib.request.Request(url, data=payload, method='POST', headers={
        'Content-Type': 'application/json', 'X-Deploy-Timestamp': stamp, 'X-Deploy-Signature': signature,
        'User-Agent': 'steam-chat-deploy/1.0',
    })


def main():
    url = os.environ.get('DEPLOY_WEBHOOK_URL', '')
    secret = os.environ.get('DEPLOY_WEBHOOK_SECRET', '')
    if not url and not secret:
        print('::notice::Automatic deployment disabled: configure deployment webhook secrets.')
        return 0
    parsed = urllib.parse.urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.fragment or len(secret) < 32:
        print('::error::Configure a valid HTTPS webhook URL and a deployment secret of at least 32 characters.')
        return 1
    payload = json.dumps({
        'image': os.environ['DEPLOY_IMAGE'], 'revision': os.environ['GITHUB_SHA'],
        'run_number': int(os.environ['GITHUB_RUN_NUMBER']), 'run_attempt': int(os.environ['GITHUB_RUN_ATTEMPT']),
    }, separators=(',', ':')).encode()
    opener = urllib.request.build_opener(NoRedirect)
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        request = signed_request(url, secret, payload, int(time.time()))
        try:
            try:
                response = opener.open(request, timeout=20)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                code = response.code
                raw = response.read(8193)
            try:
                result = json.loads(raw) if len(raw) <= 8192 else {}
            except (ValueError, UnicodeError):
                result = {}
            status = result.get('status') if isinstance(result, dict) else None
            if code == 200 and status in ('succeeded', 'superseded'):
                print('Deployment ' + status + '.')
                return 0
            if status in ('failed', 'conflict') or code not in (202, 404, 409, 429, 500, 502, 503, 504):
                print(f'::error::Deployment rejected or failed (HTTP {code}). Check the host updater journal.')
                return 1
            print(f'Deployment pending (HTTP {code}); retrying the same job.')
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError, http.client.HTTPException):
            # The relay container can restart after the host accepted the request.
            print('Deployment endpoint temporarily unavailable; retrying the same job.')
        time.sleep(5)
    print('::error::Deployment confirmation timed out; inspect the host before retrying.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
