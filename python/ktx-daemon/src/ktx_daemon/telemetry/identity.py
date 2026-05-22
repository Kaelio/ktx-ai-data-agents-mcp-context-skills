from __future__ import annotations

import json
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Mapping

IDENTITY_TTL_SECONDS = 60.0


@dataclass(frozen=True)
class TelemetryIdentity:
    install_id: str | None
    enabled: bool
    path: Path


_cache: tuple[float, Path, TelemetryIdentity] | None = None


def _telemetry_path(home_dir: Path | None = None) -> Path:
    return (home_dir or Path.home()) / ".ktx" / "telemetry.json"


def _env_disables(env: Mapping[str, str] | None = None) -> bool:
    source = env or os.environ
    return bool(source.get("KTX_TELEMETRY_DISABLED") or source.get("DO_NOT_TRACK"))


def _read_identity(path: Path) -> TelemetryIdentity:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return TelemetryIdentity(install_id=None, enabled=False, path=path)

    install_id = raw.get("installId")
    enabled = raw.get("enabled")
    if not isinstance(install_id, str) or enabled is not True:
        return TelemetryIdentity(
            install_id=install_id if isinstance(install_id, str) else None,
            enabled=False,
            path=path,
        )

    return TelemetryIdentity(install_id=install_id, enabled=True, path=path)


def load_telemetry_identity(
    *,
    home_dir: Path | None = None,
    env: Mapping[str, str] | None = None,
    now: Callable[[], float] | None = None,
) -> TelemetryIdentity:
    global _cache

    path = _telemetry_path(home_dir)
    clock = now or time.monotonic
    current = float(clock())

    if _cache and _cache[1] == path and current - _cache[0] < IDENTITY_TTL_SECONDS:
        cached = _cache[2]
    else:
        cached = _read_identity(path)
        _cache = (current, path, cached)

    if _env_disables(env):
        return TelemetryIdentity(install_id=cached.install_id, enabled=False, path=path)

    return cached


def reset_identity_cache() -> None:
    global _cache
    _cache = None
