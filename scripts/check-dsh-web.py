"""Smoke-test dsh web (or rdsh web) with an isolated home and browser cookies.

Run: python3 scripts/check-dsh-web.py [path/to/dsh-or-rdsh]
Port 3080 must be free.
"""

import http.cookiejar
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

with socket.socket() as probe:
    probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    probe.bind(("127.0.0.1", 3080))

with tempfile.TemporaryDirectory(prefix="dsh-test-") as home, tempfile.TemporaryFile(mode="w+") as log:
    process = subprocess.Popen(
        [sys.argv[1] if len(sys.argv) > 1 else "dsh", "web", "--no-open"],
        env={**os.environ, "DSH_HOME": home},
        stdout=log,
        stderr=log,
        start_new_session=True,
    )
    try:
        for _ in range(150):
            log.seek(0)
            output = log.read()
            match = re.search(r"http://127\.0\.0\.1:3080/\?token=\S+", output)
            if match:
                break
            if process.poll() is not None:
                detail = re.sub(r"token=\S+", "token=<redacted>", output)
                raise RuntimeError(f"web process exited with status {process.returncode}: {detail}")
            time.sleep(0.2)
        else:
            raise TimeoutError("dsh web did not print its launch URL within 30 seconds")

        browser = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
        )
        with browser.open(match.group(), timeout=5) as response:
            assert response.status == 200
            assert b"<html" in response.read().lower()
        print("PASS: web startup, token exchange, and HTML response")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
