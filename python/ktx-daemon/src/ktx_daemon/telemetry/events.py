from __future__ import annotations

import json
import os
import platform
import sys
from pathlib import Path
from typing import Any

from ktx_daemon import VERSION

SCHEMA_PATH = Path(__file__).with_name("events.schema.json")
COMMON_FIELDS = {
    "cliVersion",
    "nodeVersion",
    "osPlatform",
    "osRelease",
    "arch",
    "runtime",
    "isCi",
}
DAEMON_EVENTS = {
    "daemon_started",
    "daemon_stopped",
    "sl_plan_completed",
    "sql_gen_completed",
}


def _schema_catalog() -> dict[str, set[str]]:
    raw = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    return {
        event["name"]: set(event["fields"])
        for event in raw["x-ktx-catalog"]
        if event["name"] in DAEMON_EVENTS
    }


EVENT_FIELDS = _schema_catalog()


def _common_envelope() -> dict[str, Any]:
    return {
        "cliVersion": os.environ.get("KTX_DAEMON_VERSION", VERSION),
        "nodeVersion": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
        "osPlatform": sys.platform,
        "osRelease": platform.release(),
        "arch": platform.machine(),
        "runtime": "daemon-py",
        "isCi": bool(os.environ.get("CI")),
    }


def build_telemetry_event(name: str, fields: dict[str, Any]) -> dict[str, Any]:
    allowed = EVENT_FIELDS.get(name)
    if allowed is None:
        raise ValueError(f"unknown telemetry event: {name}")

    extra = set(fields) - allowed
    if extra:
        raise ValueError(f"unknown telemetry fields for {name}: {sorted(extra)}")

    missing = {
        field for field in allowed if field not in fields and field != "errorClass"
    }
    if missing:
        raise ValueError(f"missing telemetry fields for {name}: {sorted(missing)}")

    return {
        "event": name,
        "properties": {**_common_envelope(), **fields},
    }
