from __future__ import annotations

import gzip
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Any

from ktx_daemon.telemetry.identity import reset_identity_cache


class CaptureHandler(BaseHTTPRequestHandler):
    payloads: list[dict[str, Any]] = []

    def do_POST(self) -> None:
        length = int(self.headers.get("content-length", "0"))
        raw = self.rfile.read(length)
        if self.headers.get("content-encoding") == "gzip":
            raw = gzip.decompress(raw)
        self.payloads.append(json.loads(raw.decode("utf-8")))
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, _format: str, *_args: object) -> None:
        return


def write_identity(home: Path) -> None:
    target = home / ".ktx" / "telemetry.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(
            {
                "installId": "00000000-0000-4000-8000-000000000000",
                "enabled": True,
                "createdAt": "2026-06-05T00:00:00.000Z",
            }
        )
        + "\n",
        encoding="utf-8",
    )


def find_exception_event(payloads: list[dict[str, Any]]) -> dict[str, Any]:
    for payload in payloads:
        batch = payload.get("batch")
        events = batch if isinstance(batch, list) else [payload]
        for event in events:
            if isinstance(event, dict) and event.get("event") == "$exception":
                return event
    raise AssertionError(f"No $exception payload found: {payloads}")


def test_prepared_python_exception_payload_groups_and_redacts(tmp_path: Path) -> None:
    from ktx_daemon.telemetry.exception import report_exception

    reset_identity_cache()
    write_identity(tmp_path)
    CaptureHandler.payloads.clear()
    server = HTTPServer(("127.0.0.1", 0), CaptureHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        snapshot_secret = "-".join(["plain", "secret", "value"])
        db_password = "-".join(["db", "url", "secret"])
        auth_token = "".join(["abc", "123"])
        report_exception(
            RuntimeError(
                f"{snapshot_secret} postgres://svc:{db_password}@db.example.test/analytics "
                f"Authorization: Basic {auth_token}"
            ),
            source="database-introspect",
            handled=True,
            fatal=False,
            project_id="a" * 64,
            home_dir=tmp_path,
            env={"KTX_TELEMETRY_ENDPOINT": f"http://127.0.0.1:{server.server_port}"},
            redaction_secrets=[snapshot_secret],
        )
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)

    event = find_exception_event(CaptureHandler.payloads)
    properties = event["properties"]
    assert event.get("$groups") == {"project": "a" * 64} or properties.get(
        "$groups"
    ) == {"project": "a" * 64}
    serialized = json.dumps(properties.get("$exception_list", []))
    assert "[redacted]" in serialized
    assert snapshot_secret not in serialized
    assert db_password not in serialized
    assert auth_token not in serialized
    forbidden_keys = {
        "argv",
        "args",
        "env",
        "environment",
        "sql",
        "query",
        "prompt",
        "mcpArguments",
        "tableName",
        "schemaName",
        "columnName",
        "databaseUrl",
        "connectionString",
        "url",
        "password",
        "token",
        "apiKey",
        "authorization",
    }
    assert forbidden_keys.isdisjoint(properties.keys())
