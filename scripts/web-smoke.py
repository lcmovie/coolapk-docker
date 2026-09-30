#!/usr/bin/env python3
"""Check the web deployment without logging response bodies or credentials."""

import argparse
import http.cookiejar
import json
from pathlib import Path
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


class SmokeFailure(Exception):
    pass


class SmokeClient:
    def __init__(self, base_url, timeout, origin=None):
        parsed = urllib.parse.urlsplit(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise SmokeFailure("base URL must use http or https")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise SmokeFailure("base URL must not contain credentials or query parameters")
        if parsed.path not in ("", "/"):
            raise SmokeFailure("base URL must be an origin without a path")
        self.base_url = base_url.rstrip("/")
        self.origin = origin
        self.timeout = timeout
        self.cookies = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(self.cookies)
        )

    def request(self, path, method="GET", payload=None):
        encoded = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Accept": "application/json, text/html;q=0.8"}
        if self.origin:
            headers["Origin"] = self.origin
        if encoded is not None:
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(
            self.base_url + path, data=encoded, method=method, headers=headers
        )
        try:
            with self.opener.open(request, timeout=self.timeout) as response:
                return response.status, response.headers, response.read(16 * 1024 * 1024)
        except urllib.error.HTTPError as error:
            return error.code, error.headers, error.read(1024 * 1024)
        except (urllib.error.URLError, OSError) as error:
            # The full exception may include URLs/headers; only expose its class.
            raise SmokeFailure("request failed ({})".format(type(error).__name__)) from None


def expect(condition, name, detail=""):
    if not condition:
        raise SmokeFailure(name + (": " + detail if detail else ""))
    print("PASS " + name)


def decoded_json(body, name):
    try:
        return json.loads(body)
    except (ValueError, UnicodeError):
        raise SmokeFailure(name + ": response is not JSON") from None


def public_checks(client):
    status, _, body = client.request("/healthz")
    expect(status == 200, "health HTTP", "HTTP {}".format(status))
    health = decoded_json(body, "health")
    expect(isinstance(health, dict) and health.get("status") == "ok", "health schema")

    status, headers, body = client.request("/")
    expect(status == 200 and "text/html" in headers.get("Content-Type", ""), "homepage")
    html = body.decode("utf-8", "replace")
    match = re.search(r'<script\b[^>]*\bsrc=["\']([^"\']+)["\']', html)
    expect(match is not None, "frontend entry script")
    path = urllib.parse.urlsplit(match.group(1)).path
    expect(path.startswith("/assets/") and ".." not in path, "same-origin static entry")
    status, headers, body = client.request(path)
    expect(
        status == 200 and len(body) > 0 and "text/html" not in headers.get("Content-Type", ""),
        "static entry asset", "HTTP {}".format(status),
    )

    status, headers, body = client.request("/feed/123456")
    expect(status == 200 and "text/html" in headers.get("Content-Type", ""), "SPA deep link")

    status, _, body = client.request("/api/auth/status")
    expect(status == 200, "auth status HTTP", "HTTP {}".format(status))
    auth = decoded_json(body, "auth status")
    expect(
        isinstance(auth, dict)
        and isinstance(auth.get("configured"), bool)
        and isinstance(auth.get("authenticated"), bool),
        "auth status schema",
    )
    expect(auth["authenticated"] is False, "anonymous session")
    status, _, _ = client.request("/api/invoke/get_accounts", "POST", {})
    expect(status == 401, "business API requires authentication", "HTTP {}".format(status))
    return auth


def authenticated_checks(client, auth, args):
    if not args.password_file:
        if args.write_marker or args.verify_marker:
            raise SmokeFailure("persistence check requires --password-file")
        return
    try:
        password = Path(args.password_file).read_text(encoding="utf-8").rstrip("\r\n")
    except (OSError, UnicodeError):
        raise SmokeFailure("cannot read password file") from None
    if not auth["configured"] and not args.configure:
        raise SmokeFailure("access password is not configured; set it in UI or use --configure")
    action = "login" if auth["configured"] else "setup"
    status, _, _ = client.request("/api/auth/" + action, "POST", {"password": password})
    del password
    expect(status == 200, "application authentication", "HTTP {}".format(status))
    status, _, body = client.request("/api/auth/status")
    authenticated = decoded_json(body, "authenticated status")
    expect(status == 200 and authenticated.get("authenticated") is True, "authenticated session")
    for name in ("accounts.json", "access.json", "sessions.json", "device-profile.json"):
        status, _, _ = client.request("/api/store/" + name)
        expect(status == 400, "credential store is protected: " + name, "HTTP {}".format(status))
    status, _, _ = client.request("/api/media?url=http%3A%2F%2F127.0.0.1%3A8080%2Fhealthz")
    expect(status == 400, "media rejects local service URL", "HTTP {}".format(status))
    status, _, _ = client.request("/api/files/accounts/accounts.json")
    expect(status == 400, "file download rejects credential directory", "HTTP {}".format(status))
    old_origin = client.origin
    client.origin = "https://invalid.example"
    status, _, _ = client.request("/api/store/web-smoke.json")
    client.origin = old_origin
    expect(status == 403, "API rejects foreign Origin", "HTTP {}".format(status))

    if args.write_marker or args.verify_marker:
        if not args.marker_file:
            raise SmokeFailure("persistence check requires --marker-file")
        reference = Path(args.marker_file)
        if args.write_marker:
            marker = {"deployment_test": str(uuid.uuid4()), "schema": 1}
            status, _, _ = client.request("/api/store/web-smoke.json", "PUT", marker)
            expect(status == 200, "persistent test store write", "HTTP {}".format(status))
            try:
                reference.write_text(json.dumps(marker) + "\n", encoding="utf-8")
            except OSError:
                raise SmokeFailure("cannot write marker reference file") from None
        else:
            try:
                marker = json.loads(reference.read_text(encoding="utf-8"))
            except (OSError, ValueError, UnicodeError):
                raise SmokeFailure("cannot read marker reference file") from None
        status, _, body = client.request("/api/store/web-smoke.json")
        saved = decoded_json(body, "persistent test store")
        expect(status == 200 and saved == marker, "persistent test store readback")
        if args.data_dir:
            data_dir = Path(args.data_dir)
            files = list(data_dir.rglob("web-smoke.json")) if data_dir.is_dir() else []
            matching = False
            for path in files:
                try:
                    matching = json.loads(path.read_text(encoding="utf-8")) == marker
                except (OSError, ValueError, UnicodeError):
                    continue
                if matching:
                    break
            expect(matching, "test store exists in host data directory")

    status, _, _ = client.request("/api/auth/logout", "POST", {})
    expect(status == 200, "application logout", "HTTP {}".format(status))
    status, _, _ = client.request("/api/store/web-smoke.json")
    expect(status == 401, "store requires authentication after logout", "HTTP {}".format(status))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", required=True, help="Web app HTTP/HTTPS origin")
    parser.add_argument("--origin", help="Optional Origin header for origin validation checks")
    parser.add_argument("--timeout", type=float, default=30.0, help="Request timeout in seconds")
    parser.add_argument("--password-file", help="Read application access password from this file; never printed")
    parser.add_argument("--configure", action="store_true", help="Allow first-time password setup using password file")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--write-marker", action="store_true", help="Write dedicated test store before container recreation")
    modes.add_argument("--verify-marker", action="store_true", help="Read the same dedicated store after container recreation")
    parser.add_argument("--marker-file", help="Local reference JSON path; no passwords or account data")
    parser.add_argument("--data-dir", help="Also verify the dedicated test JSON exists within host data directory")
    args = parser.parse_args()
    try:
        client = SmokeClient(args.base_url, args.timeout, args.origin)
        auth = public_checks(client)
        authenticated_checks(client, auth, args)
        print("PASS web deployment smoke checks")
        return 0
    except SmokeFailure as error:
        print("FAIL " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
