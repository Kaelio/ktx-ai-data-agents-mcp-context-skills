from __future__ import annotations

from typing import Literal

from ktx_daemon.telemetry.emitter import track_telemetry_event

StopReason = Literal["signal", "request", "crash"]

_daemon_stop_emitted = False


def emit_daemon_stopped_once(*, reason: StopReason, uptime_ms: float) -> bool:
    global _daemon_stop_emitted
    if _daemon_stop_emitted:
        return False
    _daemon_stop_emitted = True
    track_telemetry_event(
        "daemon_stopped",
        {
            "reason": reason,
            "uptimeMs": max(0, uptime_ms),
        },
    )
    return True


def reset_daemon_lifecycle_for_tests() -> None:
    global _daemon_stop_emitted
    _daemon_stop_emitted = False
