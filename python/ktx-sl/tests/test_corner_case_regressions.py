from __future__ import annotations

from conftest import assert_valid_sql, make_engine


def _duplicate_predefined_sources() -> dict[str, dict]:
    return {
        "customers": {
            "name": "customers",
            "table": "public.customers",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "segment", "type": "string"},
            ],
        },
        "orders": {
            "name": "orders",
            "table": "public.orders",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "customer_id", "type": "number"},
                {"name": "amount", "type": "number"},
            ],
            "joins": [
                {
                    "to": "customers",
                    "on": "customer_id = customers.id",
                    "relationship": "many_to_one",
                }
            ],
            "measures": [{"name": "revenue", "expr": "sum(amount)"}],
        },
        "refunds": {
            "name": "refunds",
            "table": "public.refunds",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "customer_id", "type": "number"},
                {"name": "amount", "type": "number"},
            ],
            "joins": [
                {
                    "to": "customers",
                    "on": "customer_id = customers.id",
                    "relationship": "many_to_one",
                }
            ],
            "measures": [{"name": "revenue", "expr": "sum(amount)"}],
        },
    }


def _include_empty_sources() -> dict[str, dict]:
    return {
        "customers": {
            "name": "customers",
            "table": "public.customers",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "segment", "type": "string"},
            ],
        },
        "orders": {
            "name": "orders",
            "table": "public.orders",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "customer_id", "type": "number"},
                {"name": "amount", "type": "number"},
            ],
            "joins": [
                {
                    "to": "customers",
                    "on": "customer_id = customers.id",
                    "relationship": "many_to_one",
                }
            ],
        },
    }


def _alias_measure_sources() -> dict[str, dict]:
    return {
        "customers": {
            "name": "customers",
            "table": "public.customers",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "lifetime_value", "type": "number"},
            ],
            "measures": [{"name": "total_ltv", "expr": "sum(lifetime_value)"}],
        },
        "orders": {
            "name": "orders",
            "table": "public.orders",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "billing_customer_id", "type": "number"},
                {"name": "status", "type": "string"},
            ],
            "joins": [
                {
                    "to": "customers",
                    "on": "billing_customer_id = customers.id",
                    "relationship": "many_to_one",
                    "alias": "billing_customer",
                }
            ],
        },
    }


def test_duplicate_predefined_names_stay_distinct_in_derived_measure():
    engine = make_engine(_duplicate_predefined_sources())
    result = engine.query(
        {
            "measures": [
                "orders.revenue",
                "refunds.revenue",
                {"expr": "orders.revenue - refunds.revenue", "name": "net"},
            ],
            "dimensions": ["customers.segment"],
        }
    )

    assert result.resolved_plan.has_fan_out
    assert "orders_agg.orders_revenue" in result.sql
    assert "refunds_agg.refunds_revenue" in result.sql
    assert "revenue - revenue" not in result.sql
    assert_valid_sql(result.sql)


def test_duplicate_predefined_names_expand_having_filters_in_locality_mode():
    engine = make_engine(_duplicate_predefined_sources())
    result = engine.query(
        {
            "measures": ["orders.revenue", "refunds.revenue"],
            "dimensions": ["customers.segment"],
            "filters": ["orders.revenue > 100"],
        }
    )

    # In multi-CTE mode, HAVING refs are wrapped in COALESCE for FULL JOIN NULL safety
    assert "WHERE COALESCE(orders_agg.orders_revenue, 0) > 100" in result.sql
    assert_valid_sql(result.sql)


def test_include_empty_anchors_the_dimension_side():
    engine = make_engine(_include_empty_sources())
    result = engine.query(
        {
            "measures": ["sum(orders.amount)"],
            "dimensions": ["customers.segment"],
            "include_empty": True,
        }
    )

    assert result.resolved_plan.anchor_source == "customers"
    assert "FROM public.customers AS customers" in result.sql
    assert "LEFT JOIN public.orders AS orders" in result.sql
    assert_valid_sql(result.sql)


def test_cross_grain_measures_on_same_chain_use_aggregate_locality():
    engine = make_engine(
        {
            "customers": {
                "name": "customers",
                "table": "public.customers",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "segment", "type": "string"},
                    {"name": "credit_limit", "type": "number"},
                ],
            },
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "customer_id = customers.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
        }
    )
    result = engine.query(
        {
            "measures": ["sum(orders.amount)", "sum(customers.credit_limit)"],
            "dimensions": ["customers.segment"],
        }
    )

    assert result.resolved_plan.has_fan_out
    assert "orders_agg" in result.sql
    assert "customers_agg" in result.sql
    assert_valid_sql(result.sql)


def test_filtered_count_distinct_keeps_distinct_inside_count():
    engine = make_engine(
        {
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
                    {"name": "status", "type": "string"},
                ],
                "measures": [
                    {
                        "name": "paid_customers",
                        "expr": "count_distinct(customer_id)",
                        "filter": "status = 'paid'",
                    }
                ],
            }
        }
    )
    result = engine.query(
        {"measures": ["orders.paid_customers"], "dimensions": ["orders.status"]}
    )

    assert "COUNT(DISTINCT CASE WHEN orders.status = 'paid'" in result.sql
    assert_valid_sql(result.sql)


def test_filtered_count_star_uses_case_one_not_case_star():
    engine = make_engine(
        {
            "accounts": {
                "name": "accounts",
                "table": "public.accounts",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "risk_level", "type": "string"},
                ],
                "measures": [
                    {
                        "name": "high_risk_account_count",
                        "expr": "count(*)",
                        "filter": "risk_level = 'high'",
                    }
                ],
            }
        }
    )

    result = engine.query(
        {"measures": ["accounts.high_risk_account_count"], "dimensions": []}
    )

    assert "THEN *" not in result.sql
    assert "COUNT(CASE WHEN accounts.risk_level = 'high' THEN 1 END)" in result.sql
    assert_valid_sql(result.sql)


def test_predefined_measure_via_alias_uses_real_table_and_alias_qualification():
    engine = make_engine(_alias_measure_sources())
    result = engine.query(
        {
            "measures": ["billing_customer.total_ltv"],
            "dimensions": ["billing_customer.id"],
        }
    )

    assert "FROM public.customers AS billing_customer" in result.sql
    assert "SUM(billing_customer.lifetime_value)" in result.sql
    assert_valid_sql(result.sql)


def test_runtime_case_measure_gets_a_safe_auto_alias():
    engine = make_engine(
        {
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "amount", "type": "number"},
                    {"name": "status", "type": "string"},
                ],
            }
        }
    )
    result = engine.query(
        {
            "measures": [
                "sum(CASE WHEN orders.status = 'paid' THEN orders.amount ELSE 0 END)"
            ],
            "dimensions": ["orders.status"],
        }
    )

    assert (
        "sum_case_when_orders_status_paid_then_orders_amount_else_0_end" in result.sql
    )
    assert "=" not in result.resolved_plan.measures[0].name
    assert_valid_sql(result.sql)
