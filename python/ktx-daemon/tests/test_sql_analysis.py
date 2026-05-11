from __future__ import annotations

from ktx_daemon.sql_analysis import (
    AnalyzeSqlBatchItem,
    AnalyzeSqlBatchRequest,
    analyze_sql_batch_response,
)


def test_analyze_sql_batch_extracts_tables_and_clause_columns() -> None:
    response = analyze_sql_batch_response(
        AnalyzeSqlBatchRequest(
            dialect="postgres",
            items=[
                AnalyzeSqlBatchItem(
                    id="orders_by_customer",
                    sql=(
                        "select o.status, count(*) "
                        "from public.orders o "
                        "join public.customers c on o.customer_id = c.id "
                        "where o.created_at >= current_date - interval '30 day' "
                        "group by o.status"
                    ),
                )
            ],
            max_workers=1,
        )
    )

    result = response.results["orders_by_customer"]
    assert result.error is None
    assert result.tables_touched == ["public.orders", "public.customers"]
    assert result.columns_by_clause == {
        "select": ["status"],
        "where": ["created_at"],
        "join": ["customer_id", "id"],
        "groupBy": ["status"],
    }


def test_analyze_sql_batch_returns_per_item_parse_errors() -> None:
    response = analyze_sql_batch_response(
        AnalyzeSqlBatchRequest(
            dialect="postgres",
            items=[AnalyzeSqlBatchItem(id="broken", sql="select * from where")],
            max_workers=1,
        )
    )

    result = response.results["broken"]
    assert result.tables_touched == []
    assert result.columns_by_clause == {}
    assert result.error is not None
