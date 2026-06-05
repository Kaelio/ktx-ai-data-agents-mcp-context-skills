from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from ktx_daemon import VERSION
from ktx_daemon.telemetry.emitter import POSTHOG_HOST, POSTHOG_PROJECT_API_KEY
from ktx_daemon.telemetry.events import _common_envelope
from ktx_daemon.telemetry.identity import load_telemetry_identity

_KTX_REPORTED_ATTR = "__ktx_posthog_exception_reported"


def _debug_enabled(env: Mapping[str, str]) -> bool:
    return env.get("KTX_TELEMETRY_DEBUG") == "1"


def _host(env: Mapping[str, str]) -> str:
    return env.get("KTX_TELEMETRY_ENDPOINT") or POSTHOG_HOST


def _redact_static(value: str) -> str:
    patterns = [
        (
            r"([a-z][a-z0-9+.-]*://[^:\s/@]+:)([^@\s/]+)(@)",
            r"\1[redacted]\3",
        ),
        (r"\b(password|pwd)=([^;&\s]+)", r"\1=[redacted]"),
        (r"\bAuthorization\s*:\s*[^\r\n,;]+", "Authorization: [redacted]"),
        (r"\bBearer\s+[A-Za-z0-9._~+/=-]+", "Bearer [redacted]"),
        (r"\b(api[_-]?key)\s*[:=]\s*([^\s,;]+)", r"\1=[redacted]"),
        (
            r"\b(KTX_[A-Z0-9_]*|[A-Z0-9_]*(?:TOKEN|SECRET))\s*[:=]\s*([^\s,;]+)",
            r"\1=[redacted]",
        ),
        (r"([?&](?:X-Amz-Signature|X-Goog-Signature|sig)=)[^&\s]+", r"\1[redacted]"),
    ]
    redacted = value
    for pattern, replacement in patterns:
        redacted = re.sub(pattern, replacement, redacted, flags=re.IGNORECASE)
    return redacted


def _redact_text(value: str, secrets: Sequence[str]) -> str:
    redacted = value
    for secret in secrets:
        if secret:
            redacted = redacted.replace(secret, "[redacted]")
    return _redact_static(redacted)


def _clone_exception(exception: BaseException, secrets: Sequence[str]) -> BaseException:
    redacted_args = [_redact_text(str(arg), secrets) for arg in exception.args]
    try:
        cloned = type(exception)(*redacted_args)
    except Exception:
        cloned = RuntimeError(_redact_text(str(exception), secrets))
    cloned.__traceback__ = exception.__traceback__
    cloned.__cause__ = (
        _clone_exception(exception.__cause__, secrets) if exception.__cause__ else None
    )
    cloned.__context__ = (
        _clone_exception(exception.__context__, secrets)
        if exception.__context__
        else None
    )
    return cloned


def _should_skip_as_reported(exception: BaseException) -> bool:
    if getattr(exception, _KTX_REPORTED_ATTR, False):
        return True
    try:
        setattr(exception, _KTX_REPORTED_ATTR, True)
    except Exception:
        return False
    return False


def _properties(*, source: str, handled: bool, fatal: bool) -> dict[str, Any]:
    return {
        **_common_envelope(),
        "daemonVersion": os.environ.get("KTX_DAEMON_VERSION", VERSION),
        "source": source,
        "handled": handled,
        "fatal": fatal,
    }


def report_exception(
    exception: BaseException,
    *,
    source: str,
    handled: bool,
    fatal: bool,
    project_id: str | None = None,
    home_dir: Path | None = None,
    env: Mapping[str, str] | None = None,
    redaction_secrets: Sequence[str] | None = None,
) -> None:
    source_env = env if env is not None else os.environ
    try:
        identity = load_telemetry_identity(home_dir=home_dir, env=source_env)
        if not identity.enabled or not identity.install_id:
            return

        if _should_skip_as_reported(exception):
            return

        properties = _properties(source=source, handled=handled, fatal=fatal)
        groups = {"project": project_id} if project_id else None
        safe_exception = _clone_exception(exception, redaction_secrets or [])

        if _debug_enabled(source_env):
            sys.stderr.write(
                "[telemetry-exception] "
                + json.dumps(
                    {
                        "distinctId": identity.install_id,
                        "message": str(safe_exception),
                        "properties": properties,
                        "groups": groups,
                    },
                    sort_keys=True,
                )
                + "\n"
            )
            return

        if not POSTHOG_PROJECT_API_KEY.strip() or not _host(source_env).strip():
            return

        from posthog import Posthog

        client = Posthog(
            POSTHOG_PROJECT_API_KEY,
            host=_host(source_env),
            flush_at=1,
            flush_interval=0,
            sync_mode=True,
            timeout=1,
        )
        client.capture_exception(
            safe_exception,
            distinct_id=identity.install_id,
            properties=properties,
            groups=groups,
        )
        client.shutdown()
    except Exception:
        return
