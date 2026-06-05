from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ktx_daemon.telemetry.identity import reset_identity_cache


class FakePosthog:
    captures: list[dict[str, Any]] = []
    shutdowns = 0

    def __init__(self, *_args: Any, **_kwargs: Any) -> None:
        pass

    def capture_exception(
        self,
        exception: BaseException,
        *,
        distinct_id: str,
        properties: dict[str, Any],
        groups: dict[str, str] | None = None,
    ) -> None:
        self.captures.append(
            {
                "exception": exception,
                "distinct_id": distinct_id,
                "properties": properties,
                "groups": groups,
            }
        )

    def shutdown(self) -> None:
        type(self).shutdowns += 1


def write_identity(home: Path, *, enabled: bool = True) -> None:
    target = home / ".ktx" / "telemetry.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(
            {
                "installId": "00000000-0000-4000-8000-000000000000",
                "enabled": enabled,
                "createdAt": "2026-06-05T00:00:00.000Z",
            }
        )
        + "\n",
        encoding="utf-8",
    )


def test_report_exception_respects_disabled_gate(tmp_path: Path, monkeypatch) -> None:
    from ktx_daemon.telemetry.exception import report_exception

    reset_identity_cache()
    write_identity(tmp_path)
    monkeypatch.setenv("KTX_TELEMETRY_DISABLED", "1")
    FakePosthog.captures.clear()
    monkeypatch.setattr("posthog.Posthog", FakePosthog)

    report_exception(
        RuntimeError("boom"),
        source="semantic-query",
        handled=True,
        fatal=False,
        home_dir=tmp_path,
        env={"KTX_TELEMETRY_DISABLED": "1"},
    )

    assert FakePosthog.captures == []


def test_report_exception_sends_groups_and_properties(
    tmp_path: Path, monkeypatch
) -> None:
    from ktx_daemon.telemetry.exception import report_exception

    reset_identity_cache()
    write_identity(tmp_path)
    FakePosthog.captures.clear()
    monkeypatch.setattr("posthog.Posthog", FakePosthog)

    report_exception(
        RuntimeError("boom"),
        source="semantic-query",
        handled=True,
        fatal=False,
        project_id="a" * 64,
        home_dir=tmp_path,
        env={},
    )

    assert FakePosthog.captures == [
        {
            "exception": FakePosthog.captures[0]["exception"],
            "distinct_id": "00000000-0000-4000-8000-000000000000",
            "properties": FakePosthog.captures[0]["properties"],
            "groups": {"project": "a" * 64},
        }
    ]
    assert FakePosthog.captures[0]["properties"]["source"] == "semantic-query"
    assert FakePosthog.captures[0]["properties"]["handled"] is True
    assert FakePosthog.captures[0]["properties"]["fatal"] is False
    assert FakePosthog.captures[0]["properties"]["runtime"] == "daemon-py"


def test_report_exception_debug_prints_without_sending(tmp_path: Path, capsys) -> None:
    from ktx_daemon.telemetry.exception import report_exception

    reset_identity_cache()
    write_identity(tmp_path)
    FakePosthog.captures.clear()

    report_exception(
        RuntimeError("debug boom"),
        source="app:/health",
        handled=True,
        fatal=False,
        home_dir=tmp_path,
        env={"KTX_TELEMETRY_DEBUG": "1"},
    )

    captured = capsys.readouterr()
    assert "[telemetry-exception]" in captured.err
    assert '"source": "app:/health"' in captured.err
    assert FakePosthog.captures == []


def test_report_exception_redacts_snapshot_and_static_patterns(
    tmp_path: Path, monkeypatch
) -> None:
    from ktx_daemon.telemetry.exception import report_exception

    reset_identity_cache()
    write_identity(tmp_path)
    FakePosthog.captures.clear()
    monkeypatch.setattr("posthog.Posthog", FakePosthog)
    error = RuntimeError("dsn has plain-secret and password=hunter2")
    error.__cause__ = ValueError("Authorization: Bearer token-123")

    report_exception(
        error,
        source="database-introspect",
        handled=True,
        fatal=False,
        home_dir=tmp_path,
        env={},
        redaction_secrets=["plain-secret"],
    )

    sent = FakePosthog.captures[0]["exception"]
    assert "[redacted]" in str(sent)
    assert "plain-secret" not in str(sent)
    assert "hunter2" not in str(sent)
    assert "token-123" not in str(sent.__cause__)


def test_report_exception_does_not_discover_env_values_without_snapshot(
    tmp_path: Path, monkeypatch
) -> None:
    from ktx_daemon.telemetry.exception import report_exception

    reset_identity_cache()
    write_identity(tmp_path)
    FakePosthog.captures.clear()
    monkeypatch.setenv("KTX_FAKE_SECRET", "plain-secret-without-pattern")
    monkeypatch.setattr("posthog.Posthog", FakePosthog)

    report_exception(
        RuntimeError("plain-secret-without-pattern"),
        source="sys.excepthook",
        handled=False,
        fatal=True,
        home_dir=tmp_path,
        env={},
    )

    assert "plain-secret-without-pattern" in str(FakePosthog.captures[0]["exception"])


def test_route_derived_boundary_reports_new_throwing_route(monkeypatch) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from ktx_daemon.app import create_app

    reports: list[dict[str, object]] = []

    def fake_report(exception: BaseException, **kwargs: object) -> None:
        reports.append({"exception": exception, **kwargs})

    monkeypatch.setattr("ktx_daemon.app.report_exception", fake_report)
    app: FastAPI = create_app()

    @app.get("/new-throwing-route")
    async def new_throwing_route() -> dict[str, str]:
        raise RuntimeError("route boom")

    client = TestClient(app, raise_server_exceptions=False)
    response = client.get("/new-throwing-route")

    assert response.status_code == 500
    assert reports
    assert reports[0]["source"] in {"app:/new-throwing-route", "app:new_throwing_route"}
    assert reports[0]["handled"] is True
    assert reports[0]["fatal"] is False


def test_route_derived_boundary_covers_existing_validate_route(monkeypatch) -> None:
    from fastapi.testclient import TestClient
    from ktx_daemon import app as app_module

    reports: list[dict[str, object]] = []

    def fake_report(exception: BaseException, **kwargs: object) -> None:
        reports.append({"exception": exception, **kwargs})

    monkeypatch.setattr(
        app_module,
        "validate_semantic_layer",
        lambda _request: (_ for _ in ()).throw(RuntimeError("validate boom")),
    )
    monkeypatch.setattr(app_module, "report_exception", fake_report)

    client = TestClient(app_module.create_app(), raise_server_exceptions=False)
    response = client.post("/semantic-layer/validate", json={"sources": []})

    assert response.status_code == 500
    assert reports
    assert reports[0]["source"] in {
        "app:/semantic-layer/validate",
        "app:semantic_validate",
    }


def test_daemon_stopped_clean_shutdown_emits_request_once(monkeypatch) -> None:
    from ktx_daemon.telemetry.daemon_lifecycle import (
        emit_daemon_stopped_once,
        reset_daemon_lifecycle_for_tests,
    )

    events: list[tuple[str, dict[str, object]]] = []
    monkeypatch.setattr(
        "ktx_daemon.telemetry.daemon_lifecycle.track_telemetry_event",
        lambda name, fields: events.append((name, fields)),
    )
    reset_daemon_lifecycle_for_tests()

    emit_daemon_stopped_once(reason="request", uptime_ms=1)
    emit_daemon_stopped_once(reason="request", uptime_ms=2)

    assert events == [("daemon_stopped", {"reason": "request", "uptimeMs": 1})]


def test_daemon_stopped_crash_wins_over_request(monkeypatch) -> None:
    from ktx_daemon.telemetry.daemon_lifecycle import (
        emit_daemon_stopped_once,
        reset_daemon_lifecycle_for_tests,
    )

    events: list[tuple[str, dict[str, object]]] = []
    monkeypatch.setattr(
        "ktx_daemon.telemetry.daemon_lifecycle.track_telemetry_event",
        lambda name, fields: events.append((name, fields)),
    )
    reset_daemon_lifecycle_for_tests()

    emit_daemon_stopped_once(reason="crash", uptime_ms=3)
    emit_daemon_stopped_once(reason="request", uptime_ms=4)

    assert events == [("daemon_stopped", {"reason": "crash", "uptimeMs": 3})]


def test_report_exception_dedupes_same_exception_object(
    tmp_path: Path, monkeypatch
) -> None:
    from ktx_daemon.telemetry.exception import report_exception

    reset_identity_cache()
    write_identity(tmp_path)
    FakePosthog.captures.clear()
    monkeypatch.setattr("posthog.Posthog", FakePosthog)
    error = RuntimeError("same object")

    report_exception(
        error,
        source="semantic-query",
        handled=True,
        fatal=False,
        home_dir=tmp_path,
        env={},
    )
    report_exception(
        error,
        source="app:/semantic-layer/query",
        handled=True,
        fatal=False,
        home_dir=tmp_path,
        env={},
    )

    assert len(FakePosthog.captures) == 1


def test_report_exception_redacts_url_userinfo_and_authorization(
    tmp_path: Path, monkeypatch
) -> None:
    from ktx_daemon.telemetry.exception import report_exception

    reset_identity_cache()
    write_identity(tmp_path)
    FakePosthog.captures.clear()
    monkeypatch.setattr("posthog.Posthog", FakePosthog)

    db_password = ["db", "url", "secret"]
    auth_token = ["abc", "123"]
    report_exception(
        RuntimeError(
            "connect postgres://svc:"
            + "-".join(db_password)
            + "@db.example.test/analytics Authorization: Basic "
            + "".join(auth_token)
        ),
        source="database-introspect",
        handled=True,
        fatal=False,
        home_dir=tmp_path,
        env={},
    )

    sent = str(FakePosthog.captures[0]["exception"])
    assert "postgres://svc:[redacted]@db.example.test/analytics" in sent
    assert "Authorization: [redacted]" in sent
    assert "-".join(db_password) not in sent
    assert "".join(auth_token) not in sent


def test_report_exception_falls_back_when_exception_type_cannot_be_reconstructed(
    tmp_path: Path, monkeypatch
) -> None:
    from ktx_daemon.telemetry.exception import report_exception

    class KeywordOnlyException(Exception):
        def __init__(self, *, message: str) -> None:
            super().__init__(message)

    reset_identity_cache()
    write_identity(tmp_path)
    FakePosthog.captures.clear()
    monkeypatch.setattr("posthog.Posthog", FakePosthog)

    report_exception(
        KeywordOnlyException(message="custom secret-value"),
        source="app:/custom",
        handled=True,
        fatal=False,
        home_dir=tmp_path,
        env={},
        redaction_secrets=["secret-value"],
    )

    assert len(FakePosthog.captures) == 1
    sent = FakePosthog.captures[0]["exception"]
    assert "[redacted]" in str(sent)
    assert "secret-value" not in str(sent)


def test_report_exception_redacts_every_static_pattern_and_leaves_benign_text(
    tmp_path: Path, monkeypatch
) -> None:
    from ktx_daemon.telemetry.exception import report_exception

    reset_identity_cache()
    write_identity(tmp_path)
    FakePosthog.captures.clear()
    monkeypatch.setattr("posthog.Posthog", FakePosthog)

    cases = [
        ("dsn password=hunter2", "hunter2", "password=[redacted]"),
        ("dsn pwd=swordfish", "swordfish", "pwd=[redacted]"),
        ("Authorization: Basic abc123", "abc123", "Authorization: [redacted]"),
        ("Authorization: Bearer token-123", "token-123", "Authorization: [redacted]"),
        ("Bearer standalone-token", "standalone-token", "Bearer [redacted]"),
        ("api_key=sk-live-secret", "sk-live-secret", "api_key=[redacted]"),
        ("api-key: sk-dash-secret", "sk-dash-secret", "api-key=[redacted]"),
        (
            "KTX_PROVIDER_TOKEN=ktx-secret",
            "ktx-secret",
            "KTX_PROVIDER_TOKEN=[redacted]",
        ),
        (
            "REFRESH_SECRET: refresh-secret",
            "refresh-secret",
            "REFRESH_SECRET=[redacted]",
        ),
        (
            "https://s3.example.test/file?X-Amz-Signature=aws-secret&ok=1",
            "aws-secret",
            "X-Amz-Signature=[redacted]",
        ),
        (
            "https://storage.example.test/file?X-Goog-Signature=goog-secret&ok=1",
            "goog-secret",
            "X-Goog-Signature=[redacted]",
        ),
        (
            "https://cdn.example.test/file?sig=signed-secret&ok=1",
            "signed-secret",
            "sig=[redacted]",
        ),
        (
            "postgres://svc:url-password@db.example.test/analytics",  # pragma: allowlist secret
            "url-password",
            "postgres://svc:[redacted]@db.example.test/analytics",
        ),
    ]

    for message, leaked, expected in cases:
        report_exception(
            RuntimeError(message),
            source="database-introspect",
            handled=True,
            fatal=False,
            home_dir=tmp_path,
            env={},
        )
        sent = str(FakePosthog.captures[-1]["exception"])
        assert expected in sent
        assert leaked not in sent

    report_exception(
        RuntimeError("token bucket metrics and passwordless auth are benign"),
        source="database-introspect",
        handled=True,
        fatal=False,
        home_dir=tmp_path,
        env={},
    )
    assert str(FakePosthog.captures[-1]["exception"]) == (
        "token bucket metrics and passwordless auth are benign"
    )


def test_route_derived_boundary_covers_existing_health_route(monkeypatch) -> None:
    from fastapi.testclient import TestClient
    from ktx_daemon import app as app_module

    reports: list[dict[str, object]] = []

    def fake_report(exception: BaseException, **kwargs: object) -> None:
        reports.append({"exception": exception, **kwargs})

    class BrokenEnviron(dict[str, str]):
        def get(self, key: str, default: str | None = None) -> str | None:
            if key == "KTX_DAEMON_VERSION":
                raise RuntimeError("health boom")
            return default

    monkeypatch.setattr(app_module.os, "environ", BrokenEnviron())
    monkeypatch.setattr(app_module, "report_exception", fake_report)

    client = TestClient(app_module.create_app(), raise_server_exceptions=False)
    response = client.get("/health")

    assert response.status_code == 500
    assert reports
    assert reports[0]["source"] == "app:/health"
    assert reports[0]["handled"] is True
    assert reports[0]["fatal"] is False


def test_route_boundary_passes_request_scoped_database_secrets(monkeypatch) -> None:
    from fastapi.testclient import TestClient
    from ktx_daemon import app as app_module

    reports: list[dict[str, object]] = []

    def fake_report(exception: BaseException, **kwargs: object) -> None:
        reports.append({"exception": exception, **kwargs})

    monkeypatch.setattr(
        app_module,
        "introspect_database_response",
        lambda _request: (_ for _ in ()).throw(RuntimeError("db-url-secret")),
    )
    monkeypatch.setattr(app_module, "report_exception", fake_report)

    client = TestClient(app_module.create_app(), raise_server_exceptions=False)
    response = client.post(
        "/database/introspect",
        json={
            "connection_id": "warehouse",
            "url": "postgres://svc:db-url-secret@db.example.test/analytics",  # pragma: allowlist secret
            "password": "db-password-secret",  # pragma: allowlist secret
        },
    )

    assert response.status_code == 500
    assert reports
    assert (
        reports[0]["redaction_secrets"]
        == [
            "postgres://svc:db-url-secret@db.example.test/analytics",  # pragma: allowlist secret
            "db-password-secret",  # pragma: allowlist secret
        ]
    )


def test_serve_http_run_crash_reports_exception_and_crash_stop(monkeypatch) -> None:
    import sys

    from ktx_daemon import __main__ as main_module

    reports: list[dict[str, object]] = []
    stops: list[dict[str, object]] = []

    def fake_report(exception: BaseException, **kwargs: object) -> None:
        reports.append({"exception": exception, **kwargs})

    def fake_stop(*, reason: str, uptime_ms: float) -> bool:
        stops.append({"reason": reason, "uptimeMs": uptime_ms})
        return True

    class FakeUvicorn:
        @staticmethod
        def run(*_args: object, **_kwargs: object) -> None:
            raise RuntimeError("uvicorn crash")

    monkeypatch.setitem(sys.modules, "uvicorn", FakeUvicorn)
    monkeypatch.setattr("ktx_daemon.telemetry.report_exception", fake_report)
    monkeypatch.setattr(
        "ktx_daemon.telemetry.daemon_lifecycle.emit_daemon_stopped_once",
        fake_stop,
    )

    try:
        main_module.run_http_server(
            host="127.0.0.1",
            port=9999,
            log_level="info",
            enable_code_execution=False,
        )
    except RuntimeError as error:
        assert str(error) == "uvicorn crash"
    else:
        raise AssertionError("run_http_server did not re-raise the crash")

    assert reports
    assert reports[0]["source"] == "serve-http"
    assert reports[0]["handled"] is False
    assert reports[0]["fatal"] is True
    assert stops and stops[0]["reason"] == "crash"


def test_one_shot_command_reports_without_excepthook_or_daemon_stopped(
    monkeypatch,
) -> None:
    import sys

    from ktx_daemon import __main__ as daemon_main

    original_hook = sys.excepthook
    reports: list[dict[str, object]] = []
    stops: list[dict[str, object]] = []

    def fake_report(exception: BaseException, **kwargs: object) -> None:
        reports.append({"exception": exception, **kwargs})

    def fake_stop(*, reason: str, uptime_ms: float) -> bool:
        stops.append({"reason": reason, "uptimeMs": uptime_ms})
        return True

    monkeypatch.setattr(
        daemon_main,
        "_read_stdin_json",
        lambda: {
            "connection_id": "warehouse",
            "driver": "postgres",
            "url": "postgresql://readonly@example.test/warehouse",
            "schemas": ["public"],
        },
    )
    monkeypatch.setattr(
        daemon_main,
        "introspect_database_response",
        lambda _request: (_ for _ in ()).throw(RuntimeError("one-shot boom")),
    )
    monkeypatch.setattr("ktx_daemon.telemetry.report_exception", fake_report)
    monkeypatch.setattr(
        "ktx_daemon.telemetry.daemon_lifecycle.emit_daemon_stopped_once",
        fake_stop,
    )

    assert daemon_main.main(["database-introspect"]) == 1
    assert sys.excepthook is original_hook
    assert stops == []
    assert reports
    assert reports[0]["source"] == "database-introspect"
    assert reports[0]["handled"] is True
    assert reports[0]["fatal"] is False
