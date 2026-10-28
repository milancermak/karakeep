#!/usr/bin/env python3
"""Exercise real Chrome in an isolated container, without published ports."""
import json
import subprocess
import sys
import time
import uuid

image = sys.argv[1] if len(sys.argv) > 1 else "karakeep-browser:e2e"
name = "karakeep-browser-test-" + uuid.uuid4().hex[:12]


def call(method, path):
    request = f"{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    output = subprocess.check_output(
        ["docker", "exec", "-i", name, "socat", "-", "TCP4:127.0.0.1:9224"],
        input=request.encode(), stderr=subprocess.DEVNULL, timeout=35,
    )
    header, body = output.split(b"\r\n\r\n", 1)
    assert b"200 OK" in header, header
    return json.loads(body)


try:
    subprocess.run(
        ["docker", "run", "-d", "--name", name, "--network", "none", "--init",
         "-e", "KARAKEEP_BROWSER_IDLE_SECS=2", "-e", "KARAKEEP_BROWSER_LEASE_SECS=15", image],
        check=True, stdout=subprocess.DEVNULL,
    )
    for _ in range(40):
        try:
            assert call("GET", "/health")["running"] is False
            break
        except subprocess.CalledProcessError:
            time.sleep(0.25)
    else:
        raise AssertionError("Browser host did not start")
    lease = call("POST", "/acquire")["token"]
    assert call("GET", "/health")["running"] is True
    time.sleep(3)
    assert call("GET", "/health")["running"] is True, "Active lease was ignored"
    call("POST", "/release/" + lease)
    for _ in range(40):
        if call("GET", "/health")["running"] is False:
            break
        time.sleep(0.25)
    else:
        raise AssertionError("Chrome did not stop after its idle window")
    print("PASS: Chrome starts on demand, respects leases, and stops when idle")
finally:
    subprocess.run(["docker", "rm", "-f", name], check=False, stdout=subprocess.DEVNULL)
