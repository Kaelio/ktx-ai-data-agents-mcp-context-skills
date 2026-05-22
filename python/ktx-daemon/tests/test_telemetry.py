from __future__ import annotations

import json
import time
from pathlib import Path

from ktx_daemon.telemetry.emitter import track_telemetry_event
from ktx_daemon.telemetry.events import build_telemetry_event
from ktx_daemon.telemetry.identity import load_telemetry_identity, reset_identity_cache


def write_identity(home: Path, *, enabled: bool = True) -> None:
    target = home / ".ktx" / "telemetry.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        json.dumps(
            {
                "installId": "00000000-0000-4000-8000-000000000000",
                "enabled": enabled,
                "noticeShownAt": "2026-05-22T14:33:02.000Z",
                "noticeShownVersion": 1,
                "createdAt": "2026-05-22T14:33:02.000Z",
            }
        )
        + "\n",
        encoding="utf-8",
    )


def test_identity_reads_file_with_ttl_cache(tmp_path: Path) -> None:
    reset_identity_cache()
    write_identity(tmp_path)

    first = load_telemetry_identity(home_dir=tmp_path, now=lambda: 100.0)
    assert first.enabled is True
    assert first.install_id == "00000000-0000-4000-8000-000000000000"

    write_identity(tmp_path, enabled=False)
    cached = load_telemetry_identity(home_dir=tmp_path, now=lambda: 120.0)
    assert cached.enabled is True

    refreshed = load_telemetry_identity(home_dir=tmp_path, now=lambda: 161.0)
    assert refreshed.enabled is False


def test_identity_honors_python_env_kill_switches(tmp_path: Path) -> None:
    reset_identity_cache()
    write_identity(tmp_path)

    disabled = load_telemetry_identity(
        home_dir=tmp_path,
        env={"KTX_TELEMETRY_DISABLED": "1"},
        now=lambda: time.monotonic(),
    )

    assert disabled.enabled is False
    assert disabled.install_id == "00000000-0000-4000-8000-000000000000"


def test_event_builder_rejects_unknown_fields() -> None:
    event = build_telemetry_event(
        "sql_gen_completed",
        {
            "outcome": "ok",
            "dialect": "postgres",
            "durationMs": 5,
        },
    )

    assert event["event"] == "sql_gen_completed"
    assert event["properties"]["runtime"] == "daemon-py"

    try:
        build_telemetry_event(
            "sql_gen_completed",
            {
                "outcome": "ok",
                "dialect": "postgres",
                "durationMs": 5,
                "sql": "select * from private_table",
            },
        )
    except ValueError as error:
        assert "unknown telemetry fields" in str(error)
    else:
        raise AssertionError("expected unknown field rejection")


def test_debug_emitter_writes_payload_without_network(tmp_path: Path, capsys) -> None:
    reset_identity_cache()
    write_identity(tmp_path)

    track_telemetry_event(
        "sl_plan_completed",
        {
            "outcome": "ok",
            "stage": "transpile",
            "durationMs": 12,
            "sourceCount": 1,
            "joinCount": 0,
        },
        project_id="a" * 64,
        home_dir=tmp_path,
        env={"KTX_TELEMETRY_DEBUG": "1"},
    )

    captured = capsys.readouterr()
    assert '"event": "sl_plan_completed"' in captured.err
    assert (
        '"groups": {"project": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'
        in captured.err
    )
    assert "private_table" not in captured.err
