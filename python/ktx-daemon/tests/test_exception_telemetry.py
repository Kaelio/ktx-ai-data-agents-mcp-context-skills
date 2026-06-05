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
