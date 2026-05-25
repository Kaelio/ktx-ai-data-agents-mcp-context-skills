from pathlib import Path

import pytest
import sqlglot

from semantic_layer.engine import SemanticEngine
from semantic_layer.generator import SqlGenerator
from semantic_layer.graph import JoinGraph
from semantic_layer.models import (
    JoinDeclaration,
    MeasureDefinition,
    SemanticQuery,
    SourceColumn,
    SourceDefinition,
)
from semantic_layer.planner import QueryPlanner


@pytest.fixture
def planner(ecommerce_sources):
    graph = JoinGraph(ecommerce_sources)
    graph.build()
    return QueryPlanner(ecommerce_sources, graph)


@pytest.fixture
def generator():
    return SqlGenerator(dialect="postgres")


def generate_sql(planner, generator, query_dict, sources):
    query = SemanticQuery(**query_dict)
    plan = planner.plan(query)
    return generator.generate(plan, sources)


def assert_valid_sql(sql: str):
    """Assert that the SQL is syntactically valid."""
    try:
        sqlglot.parse(sql)
    except Exception as e:
        pytest.fail(f"Generated SQL is not valid: {e}\n\nSQL:\n{sql}")


class TestSimpleSingleSource:
    """Test 1: Simple single source."""

    def test_basic_aggregation(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        assert "SUM(orders.amount)" in sql.upper() or "sum(orders.amount)" in sql
        assert "status" in sql.lower()
        assert "GROUP BY" in sql.upper()
        assert "public.orders" in sql


class TestCrossSourceM2O:
    """Test 2: Cross-source, all m2o (the LATAM query)."""

    def test_churn_risk_by_region(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["churn_risk.avg_risk"],
                "dimensions": ["churn_risk.customer_type", "regions.name"],
                "filters": ["regions.name = 'LATAM'", "churn_risk.score > 0.7"],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        # Should have CTE for churn_risk (SQL source)
        assert "churn_risk AS" in sql
        assert "calculate_churn_score" in sql  # SQL source content
        assert "AVG" in sql.upper() or "avg" in sql
        assert "WHERE" in sql.upper()
        assert "LATAM" in sql
        assert "GROUP BY" in sql.upper()


class TestFanOut:
    """Test 3: Fanout (aggregate locality)."""

    def test_orders_by_region_no_fanout(self, planner, generator, ecommerce_sources):
        """orders → customers → regions is all m2o. No fanout needed."""
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["regions.name"],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        assert "SUM" in sql.upper() or "sum" in sql
        assert "JOIN" in sql.upper()
        # Should NOT have aggregate locality CTEs
        assert "_agg" not in sql


class TestChasmTrap:
    """Test 4: Chasm trap (two o2m from same dimension source)."""

    def test_chasm_trap_generates_locality(self):
        customers = SourceDefinition(
            name="customers",
            table="public.customers",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="segment", type="string"),
            ],
        )
        orders = SourceDefinition(
            name="orders",
            table="public.orders",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="customer_id", type="number"),
                SourceColumn(name="amount", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )
        tickets = SourceDefinition(
            name="tickets",
            table="public.tickets",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="customer_id", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )

        sources = {"customers": customers, "orders": orders, "tickets": tickets}
        graph = JoinGraph(sources)
        graph.build()
        planner = QueryPlanner(sources, graph)
        generator = SqlGenerator(dialect="postgres")

        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        sql = generator.generate(plan, sources)

        assert_valid_sql(sql)
        # Should have pre-aggregation CTEs
        assert "orders_agg" in sql
        assert "tickets_agg" in sql
        assert "FULL JOIN" in sql.upper() or "full join" in sql.lower()
        assert "COALESCE" in sql.upper() or "coalesce" in sql.lower()


class TestDerivedExpression:
    """Test 5: Derived expression."""

    def test_profit_calculation(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": [
                    {"expr": "sum(orders.amount)", "name": "total_rev"},
                    {"expr": "sum(orders.cost)", "name": "total_cost"},
                    {"expr": "total_rev - total_cost", "name": "profit"},
                ],
                "dimensions": ["orders.status"],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        assert "total_rev" in sql
        assert "total_cost" in sql
        assert "profit" in sql
        # The derived expression should inline the aggregate expressions
        assert "GROUP BY" in sql.upper()


class TestAutoHaving:
    """Test 6: Auto-HAVING."""

    def test_having_filter(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["sum(orders.amount) > 10000"],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        assert "HAVING" in sql.upper()
        assert "10000" in sql


class TestTimeGranularity:
    """Test 7: Time granularity."""

    def test_month_truncation(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": [{"field": "orders.created_at", "granularity": "month"}],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        assert "DATE_TRUNC" in sql.upper()
        assert "month" in sql.lower()


class TestPreDefinedMeasureWithFilter:
    """Test 8: Pre-defined measure with filter."""

    def test_revenue_filter(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["orders.revenue"],
                "dimensions": ["orders.status"],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        # Revenue has filter: status != 'refunded'
        # Should generate: SUM(CASE WHEN status != 'refunded' THEN amount END)
        upper = sql.upper()
        assert "CASE WHEN" in upper or "case when" in sql
        assert "REFUNDED" in upper or "refunded" in sql
        assert "SUM" in upper


class TestDialectValidation:
    def test_invalid_dialect_raises(self):
        with pytest.raises(ValueError, match="Unknown SQL dialect"):
            SqlGenerator(dialect="not_real")

    def test_valid_dialect_postgres(self):
        gen = SqlGenerator(dialect="postgres")
        assert gen.dialect == "postgres"

    def test_valid_dialect_bigquery(self):
        gen = SqlGenerator(dialect="bigquery")
        assert gen.dialect == "bigquery"

    def test_valid_dialect_snowflake(self):
        gen = SqlGenerator(dialect="snowflake")
        assert gen.dialect == "snowflake"


class TestDialectTranspilation:
    """Test 9: Dialect transpilation."""

    def test_bigquery(self, planner, ecommerce_sources):
        gen = SqlGenerator(dialect="bigquery")
        sql = generate_sql(
            planner,
            gen,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": [{"field": "orders.created_at", "granularity": "month"}],
            },
            ecommerce_sources,
        )

        assert sql
        # BigQuery: col is a timestamp, so sqlglot emits TIMESTAMP_TRUNC(col, MONTH).
        # Either form is valid BQ; both must have MONTH as an unquoted part.
        assert "DATE_TRUNC(" in sql or "TIMESTAMP_TRUNC(" in sql
        assert ", MONTH)" in sql
        assert "DATE_TRUNC('month'" not in sql
        assert "TIMESTAMP_TRUNC('month'" not in sql

    def test_snowflake(self, planner, ecommerce_sources):
        gen = SqlGenerator(dialect="snowflake")
        sql = generate_sql(
            planner,
            gen,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            },
            ecommerce_sources,
        )

        assert sql


class TestSqlSourceAsCte:
    """Test 10: SQL source as CTE."""

    def test_churn_risk_cte(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["churn_risk.avg_risk"],
                "dimensions": ["churn_risk.customer_type"],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        # churn_risk is a SQL source, should appear as CTE
        assert "WITH" in sql.upper()
        assert "churn_risk AS" in sql
        assert "customer_type" in sql
        assert "AVG" in sql.upper() or "avg" in sql


class TestLimitClause:
    """Test: LIMIT appears in generated SQL."""

    def test_limit_in_sql(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "limit": 50,
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        assert "LIMIT 50" in sql.upper()

    def test_default_limit(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        assert "LIMIT 1000" in sql.upper()


class TestOrderByClause:
    """Test: ORDER BY appears in generated SQL."""

    def test_order_by_dimensions(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        assert "ORDER BY" in sql.upper()


class TestMultipleWhereFilters:
    """Test: Multiple WHERE filters combined with AND."""

    def test_two_where_filters(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["orders.status = 'completed'", "orders.amount > 100"],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        assert "WHERE" in sql.upper()
        assert "completed" in sql
        assert "100" in sql
        assert "AND" in sql.upper()


class TestCombinedWhereHaving:
    """Test: Both WHERE and HAVING in same query."""

    def test_where_and_having(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": [
                    "orders.status = 'completed'",
                    "sum(orders.amount) > 10000",
                ],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        assert "WHERE" in sql.upper()
        assert "HAVING" in sql.upper()
        assert "completed" in sql
        assert "10000" in sql


class TestMultiplePreDefinedMeasures:
    """Test: Multiple pre-defined measures from same source."""

    def test_revenue_and_order_count(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": ["orders.revenue", "orders.order_count"],
                "dimensions": ["orders.status"],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        assert "revenue" in sql.lower()
        assert "order_count" in sql.lower()
        # Revenue should have CASE WHEN (filtered measure)
        assert "CASE WHEN" in sql.upper()


class TestRuntimeAggregationCrossSource:
    """Test: Runtime aggregation across joined sources."""

    def test_runtime_agg_by_region(self, planner, generator, ecommerce_sources):
        sql = generate_sql(
            planner,
            generator,
            {
                "measures": [{"expr": "count(orders.id)", "name": "order_count"}],
                "dimensions": ["regions.name"],
            },
            ecommerce_sources,
        )

        assert_valid_sql(sql)
        assert "COUNT" in sql.upper()
        assert "regions" in sql.lower()
        assert "JOIN" in sql.upper()


class TestChasmTrapWithDerived:
    """Test: Chasm trap with derived measures referencing different CTEs."""

    def test_derived_across_ctes(self):
        customers = SourceDefinition(
            name="customers",
            table="public.customers",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="segment", type="string"),
            ],
        )
        orders = SourceDefinition(
            name="orders",
            table="public.orders",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="customer_id", type="number"),
                SourceColumn(name="amount", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )
        tickets = SourceDefinition(
            name="tickets",
            table="public.tickets",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="customer_id", type="number"),
                SourceColumn(name="cost", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="customers",
                    on="customer_id = customers.id",
                    relationship="many_to_one",
                )
            ],
        )
        sources = {"customers": customers, "orders": orders, "tickets": tickets}

        from semantic_layer.graph import JoinGraph

        graph = JoinGraph(sources)
        graph.build()
        planner = QueryPlanner(sources, graph)
        gen = SqlGenerator(dialect="postgres")

        query = SemanticQuery(
            measures=[
                {"expr": "sum(orders.amount)", "name": "total_rev"},
                {"expr": "sum(tickets.cost)", "name": "total_cost"},
                {"expr": "total_rev - total_cost", "name": "profit"},
            ],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert_valid_sql(sql)
        assert "orders_agg" in sql
        assert "tickets_agg" in sql
        assert "profit" in sql


SOURCES_DIR = str(Path(__file__).parent.parent / "sources" / "ecommerce")


# ── From test_edge_cases.py: generator edge cases ───────────────────


class TestGeneratorEdgeCases:
    def test_no_dimensions_no_group_by(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query({"measures": ["sum(orders.amount)"]})
        assert "GROUP BY" not in result.sql
        assert_valid_sql(result.sql)

    def test_multiple_time_dimensions(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": [
                    {"field": "orders.created_at", "granularity": "month"},
                    {"field": "customers.created_at", "granularity": "year"},
                ],
            }
        )
        sql = result.sql
        assert "DATE_TRUNC('month'" in sql
        assert "DATE_TRUNC('year'" in sql
        assert_valid_sql(sql)

    def test_limit_zero(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "limit": 0,
            }
        )
        assert_valid_sql(result.sql)

    def test_very_large_limit(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "limit": 999999,
            }
        )
        assert "LIMIT 999999" in result.sql
        assert_valid_sql(result.sql)

    def test_chasm_trap_no_dimensions(self):
        from conftest import make_engine

        customers = {
            "name": "customers",
            "table": "t",
            "grain": ["id"],
            "columns": [{"name": "id", "type": "number"}],
        }
        orders = {
            "name": "orders",
            "table": "t2",
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
        }
        tickets = {
            "name": "tickets",
            "table": "t3",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "customer_id", "type": "number"},
            ],
            "joins": [
                {
                    "to": "customers",
                    "on": "customer_id = customers.id",
                    "relationship": "many_to_one",
                }
            ],
        }
        engine = make_engine(
            {"customers": customers, "orders": orders, "tickets": tickets}
        )
        result = engine.query({"measures": ["sum(orders.amount)", "count(tickets.id)"]})
        assert_valid_sql(result.sql)

    def test_sql_source_with_chasm_trap(self):
        from conftest import make_engine

        customers = {
            "name": "customers",
            "table": "public.customers",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "segment", "type": "string"},
            ],
        }
        orders = {
            "name": "orders",
            "sql": "SELECT id, customer_id, amount FROM raw_orders WHERE amount > 0",
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
        }
        tickets = {
            "name": "tickets",
            "table": "public.tickets",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "customer_id", "type": "number"},
            ],
            "joins": [
                {
                    "to": "customers",
                    "on": "customer_id = customers.id",
                    "relationship": "many_to_one",
                }
            ],
        }
        engine = make_engine(
            {"customers": customers, "orders": orders, "tickets": tickets}
        )
        result = engine.query(
            {
                "measures": ["sum(orders.amount)", "count(tickets.id)"],
                "dimensions": ["customers.segment"],
            }
        )
        assert "orders AS" in result.sql
        assert "orders_agg" in result.sql
        assert_valid_sql(result.sql)

    def test_dialect_duckdb(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="duckdb")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert result.dialect == "duckdb"
        assert result.sql

    def test_dialect_mysql(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="mysql")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert result.dialect == "mysql"
        assert result.sql

    def test_pre_defined_measure_cross_source_join(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["orders.revenue"],
                "dimensions": ["regions.name"],
            }
        )
        assert "CASE WHEN" in result.sql
        assert "regions" in result.sql.lower()
        assert_valid_sql(result.sql)


# ── From test_edge_cases.py: duplicate aliases, granularity, ORDER BY


class TestDuplicateColumnAliases:
    def test_same_column_name_different_sources(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.created_at", "customers.created_at"],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)
        assert "orders_created_at" in sql
        assert "customers_created_at" in sql

    def test_same_column_name_one_with_granularity(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": [
                    {"field": "orders.created_at", "granularity": "month"},
                    "customers.created_at",
                ],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)
        assert "orders_created_at_month" in sql
        assert "customers_created_at" in sql


class TestEmptyGranularity:
    def test_empty_granularity_treated_as_no_granularity(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": [{"field": "orders.created_at", "granularity": ""}],
            }
        )
        sql = result.sql
        assert "DATE_TRUNC" not in sql
        assert "orders.created_at" in sql
        assert_valid_sql(sql)


class TestOrderBySupported:
    def test_order_by_desc(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "order_by": [{"field": "sum(orders.amount)", "direction": "desc"}],
            }
        )
        sql = result.sql
        assert "ORDER BY" in sql
        assert "DESC" in sql.upper()
        assert_valid_sql(sql)

    def test_order_by_multiple_fields(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "order_by": [
                    {"field": "orders.status", "direction": "asc"},
                    {"field": "sum(orders.amount)", "direction": "desc"},
                ],
            }
        )
        sql = result.sql
        assert "ORDER BY" in sql
        assert "DESC" in sql.upper()
        assert_valid_sql(sql)

    def test_default_order_by_when_not_specified(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert "ORDER BY 1" in result.sql


class TestMeasureNameCollision:
    def test_two_measures_same_auto_name(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)", "sum(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)
        assert "sum_orders_amount" in sql.lower() or "sum(orders.amount)" in sql.lower()

    def test_runtime_name_matches_predefined(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": [
                    "orders.revenue",
                    {"expr": "sum(orders.cost)", "name": "revenue"},
                ],
                "dimensions": ["orders.status"],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)


class TestChainedJoins:
    def test_four_hop_join(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(order_items.quantity)"],
                "dimensions": ["regions.name"],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)
        assert "order_items" in sql.lower()
        assert "orders" in sql.lower()
        assert "customers" in sql.lower()
        assert "regions" in sql.lower()

    def test_measure_from_leaf_dim_from_root(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(order_items.price)"],
                "dimensions": ["products.category"],
            }
        )
        assert_valid_sql(result.sql)
        assert "products" in result.sql.lower()


# ── From test_edge_cases.py: locality CTE filters, join types ────────


class TestWhereFilterInLocalityCTE:
    def test_where_filter_in_both_ctes(self):
        from conftest import make_engine

        customers = {
            "name": "customers",
            "table": "public.customers",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "segment", "type": "string"},
            ],
        }
        orders = {
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
        }
        tickets = {
            "name": "tickets",
            "table": "public.tickets",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "customer_id", "type": "number"},
            ],
            "joins": [
                {
                    "to": "customers",
                    "on": "customer_id = customers.id",
                    "relationship": "many_to_one",
                }
            ],
        }
        engine = make_engine(
            {"customers": customers, "orders": orders, "tickets": tickets}
        )
        result = engine.query(
            {
                "measures": ["sum(orders.amount)", "count(tickets.id)"],
                "dimensions": ["customers.segment"],
                "filters": ["customers.segment = 'Enterprise'"],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)
        assert "Enterprise" in sql
        assert sql.count("Enterprise") >= 2


class TestThreeCteFullJoinCoalesce:
    def test_three_cte_join_uses_coalesce(self):
        sources = {
            "hub": SourceDefinition(
                name="hub",
                table="public.hub",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="segment", type="string"),
                ],
            ),
            "fact_a": SourceDefinition(
                name="fact_a",
                table="public.fact_a",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="hub_id", type="number"),
                    SourceColumn(name="val", type="number"),
                ],
                joins=[
                    JoinDeclaration(
                        to="hub", on="hub_id = hub.id", relationship="many_to_one"
                    )
                ],
            ),
            "fact_b": SourceDefinition(
                name="fact_b",
                table="public.fact_b",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="hub_id", type="number"),
                    SourceColumn(name="val", type="number"),
                ],
                joins=[
                    JoinDeclaration(
                        to="hub", on="hub_id = hub.id", relationship="many_to_one"
                    )
                ],
            ),
            "fact_c": SourceDefinition(
                name="fact_c",
                table="public.fact_c",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="hub_id", type="number"),
                    SourceColumn(name="val", type="number"),
                ],
                joins=[
                    JoinDeclaration(
                        to="hub", on="hub_id = hub.id", relationship="many_to_one"
                    )
                ],
            ),
        }
        engine = SemanticEngine.from_sources(sources)
        result = engine.query(
            {
                "measures": ["sum(fact_a.val)", "sum(fact_b.val)", "sum(fact_c.val)"],
                "dimensions": ["hub.segment"],
            }
        )
        sql_upper = result.sql.upper()
        assert "COALESCE(" in result.sql
        assert sql_upper.count("FULL JOIN") == 2

    def test_two_cte_join_no_coalesce_needed(self):
        engine = SemanticEngine(SOURCES_DIR, dialect="postgres")
        result = engine.query(
            {
                "measures": ["sum(orders.amount)", "avg(churn_risk.score)"],
                "dimensions": ["customers.segment"],
            }
        )
        sql = result.sql
        lines = [
            line.strip() for line in sql.split("\n") if "FULL JOIN" in line.upper()
        ]
        for line in lines:
            assert "COALESCE" not in line


# ── From test_bug_fixes.py ───────────────────────────────────────────


BUG_FIX_SOURCES = {
    "orders": {
        "name": "orders",
        "table": "public.orders",
        "grain": ["id"],
        "columns": [
            {"name": "id", "type": "number"},
            {"name": "amount", "type": "number"},
            {"name": "cost", "type": "number"},
            {"name": "status", "type": "string"},
            {"name": "customer_id", "type": "number"},
            {"name": "created_at", "type": "time", "role": "time"},
        ],
        "joins": [
            {
                "to": "customers",
                "on": "customer_id = customers.id",
                "relationship": "many_to_one",
            },
        ],
        "measures": [
            {
                "name": "revenue",
                "expr": "sum(amount)",
                "filter": "status != 'refunded'",
            },
            {"name": "order_count", "expr": "count(id)"},
        ],
    },
    "customers": {
        "name": "customers",
        "table": "public.customers",
        "grain": ["id"],
        "columns": [
            {"name": "id", "type": "number"},
            {"name": "name", "type": "string"},
            {"name": "segment", "type": "string"},
        ],
    },
}


class TestPercentileAlias:
    def test_percentile_alias_has_no_comma(self):
        from conftest import make_engine

        engine = make_engine(BUG_FIX_SOURCES)
        result = engine.query(
            {
                "measures": ["percentile(orders.amount, 0.9)"],
                "dimensions": ["orders.status"],
            }
        )
        assert_valid_sql(result.sql)
        assert "," not in result.resolved_plan.measures[0].name
        assert "percentile_orders_amount_0_9" == result.resolved_plan.measures[0].name

    def test_median_alias_clean(self):
        from conftest import make_engine

        engine = make_engine(BUG_FIX_SOURCES)
        result = engine.query(
            {
                "measures": ["median(orders.amount)"],
                "dimensions": ["orders.status"],
            }
        )
        assert_valid_sql(result.sql)
        assert "," not in result.resolved_plan.measures[0].name


class TestCountDistinct:
    def test_count_distinct_translated(self):
        from conftest import make_engine

        engine = make_engine(BUG_FIX_SOURCES)
        result = engine.query(
            {
                "measures": ["count_distinct(orders.customer_id)"],
                "dimensions": ["orders.status"],
            }
        )
        assert_valid_sql(result.sql)
        assert "COUNT(DISTINCT" in result.sql.upper()
        assert "count_distinct(" not in result.sql.lower()

    def test_count_distinct_in_chasm_cte(self):
        from conftest import make_engine

        sources = {
            "hub": {
                "name": "hub",
                "table": "public.hub",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "segment", "type": "string"},
                ],
            },
            "fact_a": {
                "name": "fact_a",
                "table": "public.fact_a",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "hub_id", "type": "number"},
                    {"name": "val", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "hub",
                        "on": "hub_id = hub.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
            "fact_b": {
                "name": "fact_b",
                "table": "public.fact_b",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "hub_id", "type": "number"},
                    {"name": "user_id", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "hub",
                        "on": "hub_id = hub.id",
                        "relationship": "many_to_one",
                    }
                ],
            },
        }
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": ["sum(fact_a.val)", "count_distinct(fact_b.user_id)"],
                "dimensions": ["hub.segment"],
            }
        )
        assert_valid_sql(result.sql)
        assert "COUNT(DISTINCT" in result.sql.upper()


class TestColumnValidation:
    def test_nonexistent_column_in_measure(self):
        from conftest import make_engine

        engine = make_engine(BUG_FIX_SOURCES)
        with pytest.raises(ValueError, match="does not exist in source"):
            engine.query(
                {
                    "measures": ["sum(orders.nonexistent_column)"],
                    "dimensions": ["orders.status"],
                }
            )

    def test_nonexistent_column_in_dimension(self):
        from conftest import make_engine

        engine = make_engine(BUG_FIX_SOURCES)
        with pytest.raises(ValueError, match="does not exist in source"):
            engine.query(
                {
                    "measures": ["sum(orders.amount)"],
                    "dimensions": ["orders.nonexistent_dim"],
                }
            )

    def test_nonexistent_column_in_filter(self):
        from conftest import make_engine

        engine = make_engine(BUG_FIX_SOURCES)
        with pytest.raises(ValueError, match="does not exist in source"):
            engine.query(
                {
                    "measures": ["sum(orders.amount)"],
                    "dimensions": ["orders.status"],
                    "filters": ["orders.nonexistent_col = 'x'"],
                }
            )

    def test_valid_columns_pass(self):
        from conftest import make_engine

        engine = make_engine(BUG_FIX_SOURCES)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["orders.status"],
                "filters": ["orders.status = 'completed'"],
            }
        )
        assert_valid_sql(result.sql)

    def test_error_lists_available_columns(self):
        from conftest import make_engine

        engine = make_engine(BUG_FIX_SOURCES)
        with pytest.raises(ValueError, match="Available:.*amount"):
            engine.query(
                {
                    "measures": ["sum(orders.bogus)"],
                    "dimensions": ["orders.status"],
                }
            )


class TestCrossSourceMeasureFilter:
    def test_measure_filter_adds_join(self):
        from conftest import make_engine

        cross_sources = {
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "amount", "type": "number"},
                    {"name": "status", "type": "string"},
                    {"name": "customer_id", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "customer_id = customers.id",
                        "relationship": "many_to_one",
                    },
                ],
                "measures": [
                    {
                        "name": "vip_revenue",
                        "expr": "sum(amount)",
                        "filter": "customers.segment = 'VIP'",
                    },
                ],
            },
            "customers": {
                "name": "customers",
                "table": "public.customers",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "segment", "type": "string"},
                ],
            },
        }
        engine = make_engine(cross_sources)
        result = engine.query(
            {
                "measures": ["orders.vip_revenue"],
                "dimensions": ["orders.status"],
            }
        )
        assert_valid_sql(result.sql)
        assert "customers" in result.resolved_plan.sources_used
        assert "JOIN" in result.sql.upper()
        assert "customers" in result.sql.lower()

    def test_measure_filter_produces_case_when(self):
        from conftest import make_engine

        cross_sources = {
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "amount", "type": "number"},
                    {"name": "status", "type": "string"},
                    {"name": "customer_id", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "customer_id = customers.id",
                        "relationship": "many_to_one",
                    },
                ],
                "measures": [
                    {
                        "name": "vip_revenue",
                        "expr": "sum(amount)",
                        "filter": "customers.segment = 'VIP'",
                    },
                ],
            },
            "customers": {
                "name": "customers",
                "table": "public.customers",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "segment", "type": "string"},
                ],
            },
        }
        engine = make_engine(cross_sources)
        result = engine.query(
            {
                "measures": ["orders.vip_revenue"],
                "dimensions": ["orders.status"],
            }
        )
        sql_upper = result.sql.upper()
        assert "CASE WHEN" in sql_upper
        assert "VIP" in result.sql


# ── From test_brainstorm_cases.py ────────────────────────────────────


class TestPredefinedMeasureWithFilterWrapping:
    def test_non_aggregate_predefined_formula_with_filter_wraps_entire_expr(self):
        orders = SourceDefinition(
            name="orders",
            table="public.orders",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="amount", type="number"),
                SourceColumn(name="status", type="string"),
            ],
            measures=[
                MeasureDefinition(
                    name="completed_amount_twice",
                    expr="amount * 2",
                    filter="status = 'completed'",
                )
            ],
        )
        sources = {"orders": orders}
        graph = JoinGraph(sources)
        graph.build()
        planner_local = QueryPlanner(sources, graph)
        gen = SqlGenerator(dialect="postgres")

        plan = planner_local.plan(
            SemanticQuery(measures=["orders.completed_amount_twice"])
        )
        sql = gen.generate(plan, sources)

        assert "CASE WHEN orders.status = 'completed' THEN orders.amount * 2 END" in sql
        sqlglot.parse(sql)


# ── From test_spec_gaps.py ───────────────────────────────────────────


class TestIncludeEmpty:
    def test_include_empty_true_uses_left_join(self):
        from conftest import make_engine

        sources = {
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
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["customers.segment"],
                "include_empty": True,
            }
        )
        assert "LEFT JOIN" in result.sql.upper()
        assert_valid_sql(result.sql)

    def test_include_empty_false_uses_inner_join(self):
        from conftest import make_engine

        sources = {
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
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["customers.segment"],
                "include_empty": False,
            }
        )
        sql_upper = result.sql.upper()
        assert "LEFT JOIN" not in sql_upper
        assert "JOIN" in sql_upper
        assert_valid_sql(result.sql)

    def test_include_empty_true_different_from_false(self):
        from conftest import make_engine

        sources = {
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
        engine = make_engine(sources)
        result_true = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["customers.segment"],
                "include_empty": True,
            }
        )
        result_false = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["customers.segment"],
                "include_empty": False,
            }
        )
        assert result_true.sql != result_false.sql

    def test_include_empty_in_resolved_plan(self):
        from conftest import make_engine

        sources = {
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
        engine = make_engine(sources)
        plan = engine.plan_only(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["customers.segment"],
                "include_empty": True,
            }
        )
        assert plan.include_empty is True

    def test_include_empty_locality_uses_full_join(self):
        from conftest import make_engine

        chasm = {
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
            "tickets": {
                "name": "tickets",
                "table": "public.tickets",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
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
        engine = make_engine(chasm)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)", "count(tickets.id)"],
                "dimensions": ["customers.segment"],
                "include_empty": True,
            }
        )
        assert "FULL JOIN" in result.sql.upper()
        assert_valid_sql(result.sql)

    def test_include_empty_false_locality_uses_inner_join_between_ctes(self):
        from conftest import make_engine

        chasm = {
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
            "tickets": {
                "name": "tickets",
                "table": "public.tickets",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
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
        engine = make_engine(chasm)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)", "count(tickets.id)"],
                "dimensions": ["customers.segment"],
                "include_empty": False,
            }
        )
        sql_upper = result.sql.upper()
        assert "FULL JOIN" not in sql_upper
        assert_valid_sql(result.sql)


class TestFilterPushDown:
    def test_where_filter_only_pushed_to_relevant_cte(self):
        from conftest import make_engine

        chasm = {
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
            "tickets": {
                "name": "tickets",
                "table": "public.tickets",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
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
        engine = make_engine(chasm)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)", "count(tickets.id)"],
                "dimensions": ["customers.segment"],
                "filters": ["orders.amount > 100"],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)

        tickets_start = sql.find("tickets_agg AS (")
        assert tickets_start >= 0
        depth = 0
        tickets_body_start = tickets_start + len("tickets_agg AS (")
        tickets_end = tickets_body_start
        for i, c in enumerate(sql[tickets_body_start:], tickets_body_start):
            if c == "(":
                depth += 1
            elif c == ")":
                if depth == 0:
                    tickets_end = i
                    break
                depth -= 1
        tickets_body = sql[tickets_body_start:tickets_end]
        assert "orders.amount" not in tickets_body

        orders_start = sql.find("orders_agg AS (")
        assert orders_start >= 0
        depth = 0
        orders_body_start = orders_start + len("orders_agg AS (")
        orders_end = orders_body_start
        for i, c in enumerate(sql[orders_body_start:], orders_body_start):
            if c == "(":
                depth += 1
            elif c == ")":
                if depth == 0:
                    orders_end = i
                    break
                depth -= 1
        orders_body = sql[orders_body_start:orders_end]
        assert "orders.amount > 100" in orders_body

    def test_filter_on_shared_dimension_pushed_to_all_ctes(self):
        from conftest import make_engine

        chasm = {
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
            "tickets": {
                "name": "tickets",
                "table": "public.tickets",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "customer_id", "type": "number"},
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
        engine = make_engine(chasm)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)", "count(tickets.id)"],
                "dimensions": ["customers.segment"],
                "filters": ["customers.segment = 'Enterprise'"],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)
        count = sql.count("customers.segment = 'Enterprise'")
        assert count >= 2


class TestJoinAliases:
    def test_alias_used_in_sql_generation(self):
        from conftest import make_engine

        sources = {
            "orders": {
                "name": "orders",
                "table": "public.orders",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "billing_customer_id", "type": "number"},
                    {"name": "shipping_customer_id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "billing_customer_id = customers.id",
                        "relationship": "many_to_one",
                        "alias": "billing_customer",
                    },
                    {
                        "to": "customers",
                        "on": "shipping_customer_id = customers.id",
                        "relationship": "many_to_one",
                        "alias": "shipping_customer",
                    },
                ],
            },
            "customers": {
                "name": "customers",
                "table": "public.customers",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "name", "type": "string"},
                ],
            },
        }
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": ["sum(orders.amount)"],
                "dimensions": ["billing_customer.name"],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)
        assert "billing_customer" in sql

    def test_self_referencing_alias(self):
        from conftest import make_engine

        sources = {
            "employees": {
                "name": "employees",
                "table": "public.employees",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "name", "type": "string"},
                    {"name": "manager_id", "type": "number"},
                ],
                "joins": [
                    {
                        "to": "employees",
                        "on": "manager_id = employees.id",
                        "relationship": "many_to_one",
                        "alias": "manager",
                    },
                ],
            },
        }
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": ["count(employees.id)"],
                "dimensions": ["manager.name"],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)
        assert "manager" in sql


class TestMedianPercentile:
    def test_median_generates_percentile_cont(self):
        from conftest import make_engine

        sources = {
            "scores": {
                "name": "scores",
                "table": "public.scores",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "value", "type": "number"},
                    {"name": "category", "type": "string"},
                ],
            },
        }
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": [{"expr": "median(scores.value)", "name": "med_val"}],
                "dimensions": ["scores.category"],
            }
        )
        sql_upper = result.sql.upper()
        assert "PERCENTILE_CONT" in sql_upper
        assert "0.5" in result.sql
        assert_valid_sql(result.sql)

    def test_percentile_generates_percentile_cont(self):
        from conftest import make_engine

        sources = {
            "scores": {
                "name": "scores",
                "table": "public.scores",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "value", "type": "number"},
                    {"name": "category", "type": "string"},
                ],
            },
        }
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": [{"expr": "percentile(scores.value, 0.9)", "name": "p90"}],
                "dimensions": ["scores.category"],
            }
        )
        sql_upper = result.sql.upper()
        assert "PERCENTILE_CONT" in sql_upper
        assert "0.9" in result.sql
        assert_valid_sql(result.sql)


class TestSqlSourceWithClause:
    """BUG 3: SQL sources with inner WITH clauses should not produce nested WITH."""

    def test_sql_source_with_inner_with_clause(self):
        """SQL source containing WITH base AS (...) SELECT ... should not produce nested WITH."""
        from conftest import make_engine

        sources = {
            "enriched_orders": {
                "name": "enriched_orders",
                "sql": "WITH base AS (SELECT id, amount FROM raw_orders WHERE amount > 0) SELECT id, amount FROM base",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
            },
        }
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": ["sum(enriched_orders.amount)"],
                "dimensions": [],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)
        # Should NOT have nested WITH (WITH ... WITH ...)
        # The inner WITH should be promoted/flattened
        upper_sql = sql.upper()
        # Only one WITH keyword should appear at the top level
        with_count = upper_sql.count("WITH ")
        assert with_count == 1, f"Expected 1 WITH, got {with_count}. SQL:\n{sql}"
        # The inner CTE name should be promoted with prefix
        assert "enriched_orders__base" in sql

    def test_sql_source_without_with_unchanged(self):
        """Regular SQL source (no inner WITH) should work as before."""
        from conftest import make_engine

        sources = {
            "simple_view": {
                "name": "simple_view",
                "sql": "SELECT id, amount FROM raw_orders WHERE amount > 0",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
            },
        }
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": ["sum(simple_view.amount)"],
                "dimensions": [],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)
        assert "simple_view AS" in sql
        assert "raw_orders" in sql

    def test_sql_source_inner_cte_unaliased_references(self):
        """Inner CTEs referenced without explicit aliases should get AS old_name after promotion."""
        from conftest import make_engine

        sources = {
            "analysis": {
                "name": "analysis",
                "sql": (
                    "WITH q AS (SELECT id, amount, status FROM raw_data), "
                    "filtered AS (SELECT q.id, q.amount FROM q WHERE q.status = 'active') "
                    "SELECT filtered.id, filtered.amount FROM filtered"
                ),
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "amount", "type": "number"},
                ],
            },
        }
        engine = make_engine(sources)
        result = engine.query(
            {
                "measures": ["sum(analysis.amount)"],
                "dimensions": [],
            }
        )
        sql = result.sql
        assert_valid_sql(sql)
        assert "analysis__q" in sql
        assert "analysis__filtered" in sql
        # Unaliased CTE refs should get AS old_name so column qualifiers work
        assert "analysis__q AS q" in sql or 'analysis__q AS "q"' in sql
        assert (
            "analysis__filtered AS filtered" in sql
            or 'analysis__filtered AS "filtered"' in sql
        )


class TestSqliteTimeGranularity:
    """SQLite uses strftime/date arithmetic instead of DATE_TRUNC."""

    @pytest.fixture
    def sqlite_generator(self):
        return SqlGenerator(dialect="sqlite")

    @pytest.mark.parametrize(
        "granularity,expected_fragment",
        [
            ("year", "STRFTIME('%Y-01-01'"),
            ("month", "STRFTIME('%Y-%m-01'"),
            ("day", "STRFTIME('%Y-%m-%d'"),
            ("hour", "STRFTIME('%Y-%m-%d %H:00:00'"),
            ("quarter", "PRINTF('%02d'"),
            ("week", "weekday 1"),
        ],
    )
    def test_granularity(
        self,
        ecommerce_sources,
        sqlite_generator,
        granularity,
        expected_fragment,
    ):
        graph = JoinGraph(ecommerce_sources)
        graph.build()
        planner = QueryPlanner(ecommerce_sources, graph)
        plan = planner.plan(
            SemanticQuery(
                measures=["count(orders.id)"],
                dimensions=[{"field": "orders.created_at", "granularity": granularity}],
            )
        )
        sql = sqlite_generator.generate(plan, ecommerce_sources)
        assert expected_fragment in sql, f"Expected '{expected_fragment}' in:\n{sql}"
        assert "DATE_TRUNC" not in sql

    def test_postgres_unchanged(self, ecommerce_sources):
        """Postgres still generates DATE_TRUNC as before."""
        gen = SqlGenerator(dialect="postgres")
        graph = JoinGraph(ecommerce_sources)
        graph.build()
        planner = QueryPlanner(ecommerce_sources, graph)
        plan = planner.plan(
            SemanticQuery(
                measures=["count(orders.id)"],
                dimensions=[{"field": "orders.created_at", "granularity": "month"}],
            )
        )
        sql = gen.generate(plan, ecommerce_sources)
        assert "DATE_TRUNC" in sql


class TestTranspileWithNativeCtes:
    def test_bigquery_hyphenated_project_ref_survives_in_sql_source(
        self, make_engine_factory
    ):
        """sql: source body with BigQuery-specific hyphenated project ref must survive verbatim."""
        # A project ref like `my-project.dataset.table` is not valid postgres,
        # so feeding it to a postgres parser at transpile time would fail.
        source = {
            "name": "raw_events",
            "sql": "SELECT id, user_id FROM `my-project.analytics.events`",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "user_id", "type": "number"},
            ],
            "measures": [{"name": "event_count", "expr": "count(*)"}],
        }
        engine = make_engine_factory({"raw_events": source}, dialect="bigquery")
        result = engine.query(
            {"measures": ["raw_events.event_count"], "dimensions": [], "filters": []}
        )
        assert "my-project.analytics.events" in result.sql, (
            f"Hyphenated BigQuery project ref was rewritten:\n{result.sql}"
        )

    def test_postgres_only_idiom_in_outer_gets_translated(self, make_engine_factory):
        """Postgres-only idioms in the engine scaffold are translated to target."""
        source = {
            "name": "events",
            "table": "events",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "amount", "type": "number"},
                {"name": "created_at", "type": "time"},
            ],
            "measures": [{"name": "total", "expr": "sum(amount)"}],
        }
        engine = make_engine_factory({"events": source}, dialect="bigquery")
        result = engine.query(
            {
                "measures": ["events.total"],
                "dimensions": [{"field": "events.created_at", "granularity": "month"}],
                "filters": [],
            }
        )
        # BigQuery's DATE_TRUNC (or TIMESTAMP_TRUNC) uses (col, MONTH) order.
        sql = result.sql.upper()
        assert "DATE_TRUNC(" in sql or "TIMESTAMP_TRUNC(" in sql
        assert ", MONTH)" in sql


class TestNativeDialectExprPreservation:
    """User-authored expr: in native dialect must survive composition intact.

    Regression coverage for the fct_orders.daily_active_orders 400 bug:
    BigQuery segments authored with `INTERVAL 30 DAY` were being parsed as
    postgres, silently dropping the `DAY` unit.
    """

    def test_bigquery_segment_with_interval_day_preserves_unit(
        self, make_bq_fct_orders_engine
    ):
        """Production repro: segment with `interval 30 day` must emit `INTERVAL 30 DAY`."""
        engine = make_bq_fct_orders_engine
        result = engine.query(
            {
                "measures": ["fct_orders.daily_active_orders"],
                "dimensions": [],
                "filters": [],
            }
        )
        sql = result.sql
        assert "INTERVAL '30'" not in sql or "INTERVAL '30' DAY" in sql, (
            f"BigQuery INTERVAL unit was dropped.\nSQL:\n{sql}"
        )
        # More specific: the DAY unit must be present somewhere
        assert "DAY" in sql.upper(), f"DAY unit missing from emitted SQL:\n{sql}"

    def test_bigquery_measure_filter_with_timestamp_sub(self, make_engine_factory):
        """Measure filter using TIMESTAMP_SUB(INTERVAL 7 DAY) must preserve unit."""
        source = {
            "name": "events",
            "table": "events",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "user_id", "type": "number"},
                {"name": "ts", "type": "time"},
            ],
            "measures": [
                {
                    "name": "recent_users",
                    "expr": "count(distinct user_id)",
                    "filter": "ts >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)",
                }
            ],
        }
        engine = make_engine_factory({"events": source}, dialect="bigquery")
        result = engine.query(
            {"measures": ["events.recent_users"], "dimensions": [], "filters": []}
        )
        sql = result.sql.upper()
        assert "TIMESTAMP_SUB" in sql
        assert "INTERVAL 7 DAY" in sql or "INTERVAL '7' DAY" in sql

    def test_snowflake_segment_with_dateadd(self, make_engine_factory):
        """Snowflake DATEADD(day, -30, CURRENT_TIMESTAMP()) must survive."""
        source = {
            "name": "orders",
            "table": "orders",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "placed_at", "type": "time"},
            ],
            "segments": [
                {
                    "name": "recent",
                    "expr": "placed_at >= DATEADD(day, -30, CURRENT_TIMESTAMP())",
                }
            ],
            "measures": [{"name": "cnt", "expr": "count(*)", "segments": ["recent"]}],
        }
        engine = make_engine_factory({"orders": source}, dialect="snowflake")
        result = engine.query(
            {"measures": ["orders.cnt"], "dimensions": [], "filters": []}
        )
        assert "DATEADD" in result.sql.upper()

    def test_postgres_interval_baseline_still_works(self, make_engine_factory):
        """Baseline: postgres INTERVAL '30 days' round-trips correctly."""
        source = {
            "name": "orders",
            "table": "orders",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "placed_at", "type": "time"},
            ],
            "segments": [
                {
                    "name": "recent",
                    "expr": "placed_at >= current_date - interval '30 days'",
                }
            ],
            "measures": [{"name": "cnt", "expr": "count(*)", "segments": ["recent"]}],
        }
        engine = make_engine_factory({"orders": source}, dialect="postgres")
        result = engine.query(
            {"measures": ["orders.cnt"], "dimensions": [], "filters": []}
        )
        sql_upper = result.sql.upper()
        assert "INTERVAL" in sql_upper
        assert "30 DAYS" in sql_upper or "30' DAY" in sql_upper
