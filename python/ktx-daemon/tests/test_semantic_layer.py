from __future__ import annotations

import json
from pathlib import Path

from ktx_daemon.semantic_layer import (
    SemanticLayerQueryRequest,
    ValidateSourcesRequest,
    query_semantic_layer,
    validate_semantic_layer,
)


ORDERS_SOURCE = {
    "name": "orders",
    "table": "public.orders",
    "grain": ["id"],
    "columns": [
        {"name": "id", "type": "number"},
        {"name": "status", "type": "string"},
        {"name": "amount", "type": "number"},
    ],
    "joins": [],
    "measures": [
        {"name": "order_count", "expr": "count(*)"},
        {"name": "revenue", "expr": "sum(amount)"},
    ],
}


def test_query_semantic_layer_generates_sql_and_plan() -> None:
    response = query_semantic_layer(
        SemanticLayerQueryRequest(
            sources=[ORDERS_SOURCE],
            dialect="postgres",
            query={
                "measures": ["orders.order_count"],
                "dimensions": ["orders.status"],
                "limit": 25,
            },
        )
    )

    assert response.dialect == "postgres"
    assert "public.orders" in response.sql
    assert "orders.status" in response.sql
    assert response.columns[0]["name"] == "orders.status"
    assert response.columns[1]["name"] == "orders.order_count"
    assert response.plan["sources_used"] == ["orders"]


def test_query_semantic_layer_emits_plan_and_sql_debug_events(
    tmp_path: Path,
    monkeypatch,
    capsys,
) -> None:
    from ktx_daemon.telemetry.identity import reset_identity_cache

    reset_identity_cache()
    identity_path = tmp_path / ".ktx" / "telemetry.json"
    identity_path.parent.mkdir(parents=True)
    identity_path.write_text(
        json.dumps(
            {
                "installId": "00000000-0000-4000-8000-000000000000",
                "enabled": True,
                "createdAt": "2026-05-22T14:33:02.000Z",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setenv("KTX_TELEMETRY_DEBUG", "1")
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.delenv("KTX_TELEMETRY_DISABLED", raising=False)
    monkeypatch.delenv("DO_NOT_TRACK", raising=False)

    query_semantic_layer(
        SemanticLayerQueryRequest(
            sources=[ORDERS_SOURCE],
            dialect="postgres",
            projectId="a" * 64,
            query={
                "measures": ["orders.order_count"],
                "dimensions": ["orders.status"],
                "limit": 25,
            },
        )
    )

    captured = capsys.readouterr()
    assert '"event": "sl_plan_completed"' in captured.err
    assert '"event": "sql_gen_completed"' in captured.err
    assert "public.orders" not in captured.err


def test_validate_semantic_layer_reports_duplicate_measure_names() -> None:
    invalid_source = {
        **ORDERS_SOURCE,
        "measures": [
            {"name": "revenue", "expr": "sum(amount)"},
            {"name": "revenue", "expr": "sum(amount)"},
        ],
    }

    response = validate_semantic_layer(
        ValidateSourcesRequest(sources=[invalid_source], dialect="postgres")
    )

    assert response.valid is False
    assert any("Duplicate measure" in error for error in response.errors)
    assert response.warnings == []
