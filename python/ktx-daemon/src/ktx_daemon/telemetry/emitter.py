from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any
from collections.abc import Mapping

from ktx_daemon.telemetry.events import build_telemetry_event
from ktx_daemon.telemetry.identity import load_telemetry_identity

# PostHog public project ingestion key - safe to embed; capture-only, no read access.
POSTHOG_PROJECT_API_KEY = (
    "phc_xbvZpbu8ZNLnogTbY7MEMWhCF2rzzApYsDndjKaRBXXx"  # pragma: allowlist secret
)
POSTHOG_HOST = "https://us.i.posthog.com"


def _host(env: Mapping[str, str]) -> str:
    return env.get("KTX_TELEMETRY_ENDPOINT") or POSTHOG_HOST


def _live_configured(host: str) -> bool:
    return bool(POSTHOG_PROJECT_API_KEY.strip() and host.strip())


def _debug_enabled(env: Mapping[str, str]) -> bool:
    return env.get("KTX_TELEMETRY_DEBUG") == "1"


def _scrub_error_class(error: BaseException) -> str | None:
    name = type(error).__name__
    if len(name) > 80:
        return None
    if any(marker in name for marker in ("/", "\\", "@", "://")):
        return None
    if not name[:1].isupper() or not name.replace("_", "").isalnum():
        return None
    return name


def error_class(error: BaseException) -> str | None:
    return _scrub_error_class(error)


def track_telemetry_event(
    name: str,
    fields: dict[str, Any],
    *,
    project_id: str | None = None,
    home_dir: Path | None = None,
    env: Mapping[str, str] | None = None,
) -> None:
    source_env = env or os.environ
    identity = load_telemetry_identity(home_dir=home_dir, env=source_env)
    if not identity.enabled or not identity.install_id:
        return

    try:
        event = build_telemetry_event(name, fields)
    except ValueError:
        return

    groups = {"project": project_id} if project_id else None

    if _debug_enabled(source_env):
        sys.stderr.write(
            "[telemetry] "
            + json.dumps(
                {
                    "distinctId": identity.install_id,
                    "event": event["event"],
                    "properties": event["properties"],
                    "groups": groups,
                },
                sort_keys=True,
            )
            + "\n"
        )
        return

    host = _host(source_env)
    if not _live_configured(host):
        return

    try:
        from posthog import Posthog

        client = Posthog(
            POSTHOG_PROJECT_API_KEY,
            host=host,
            flush_at=1,
            flush_interval=0,
            sync_mode=True,
            timeout=1,
        )
        client.capture(
            event=event["event"],
            distinct_id=identity.install_id,
            properties=event["properties"],
            groups=groups,
        )
        client.shutdown()
    except Exception:
        return
