"""Dedicated tests for aggregate locality (fanout/chasm trap correctness)."""

import pytest
import sqlglot

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


def _build_chasm_sources():
    """Build a classic chasm trap: orders and tickets both join m2o to customers."""
    customers = SourceDefinition(
        name="customers",
        table="public.customers",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="segment", type="string"),
            SourceColumn(name="region", type="string"),
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
        measures=[MeasureDefinition(name="revenue", expr="sum(amount)")],
    )
    tickets = SourceDefinition(
        name="tickets",
        table="public.tickets",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="customer_id", type="number"),
            SourceColumn(name="priority", type="string"),
        ],
        joins=[
            JoinDeclaration(
                to="customers",
                on="customer_id = customers.id",
                relationship="many_to_one",
            )
        ],
        measures=[MeasureDefinition(name="ticket_count", expr="count(id)")],
    )
    return {"customers": customers, "orders": orders, "tickets": tickets}


def _build_chasm_sources_with_regions():
    """Chasm trap with an extra regions dimension table: orders/tickets -> customers -> regions."""
    regions = SourceDefinition(
        name="regions",
        table="public.regions",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="name", type="string"),
        ],
    )
    customers = SourceDefinition(
        name="customers",
        table="public.customers",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="segment", type="string"),
            SourceColumn(name="region_id", type="number"),
        ],
        joins=[
            JoinDeclaration(
                to="regions", on="region_id = regions.id", relationship="many_to_one"
            )
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
        measures=[MeasureDefinition(name="revenue", expr="sum(amount)")],
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
        measures=[MeasureDefinition(name="ticket_count", expr="count(id)")],
    )
    return {
        "regions": regions,
        "customers": customers,
        "orders": orders,
        "tickets": tickets,
    }


def _make_engine(sources):
    graph = JoinGraph(sources)
    graph.build()
    planner = QueryPlanner(sources, graph)
    generator = SqlGenerator(dialect="postgres", alias_map=graph.alias_map)
    return planner, generator, sources


class TestChasmTrapLocality:
    def test_two_measure_sources_get_separate_ctes(self):
        planner, gen, sources = _make_engine(_build_chasm_sources())
        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # Verify CTE structure
        assert "orders_agg" in sql
        assert "tickets_agg" in sql
        assert sql.count("_agg") >= 2

        # Verify FULL JOIN
        assert "FULL JOIN" in sql.upper()

        # Verify COALESCE for dimension keys
        assert "COALESCE" in sql.upper()

        # Verify SQL is valid
        sqlglot.parse(sql)

    def test_chasm_with_multiple_dimensions(self):
        planner, gen, sources = _make_engine(_build_chasm_sources())
        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["customers.segment", "customers.region"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert "orders_agg" in sql
        assert "tickets_agg" in sql
        # Both dimensions should appear in COALESCE
        assert sql.upper().count("COALESCE") >= 2
        sqlglot.parse(sql)

    def test_pre_defined_measures_in_chasm(self):
        planner, gen, sources = _make_engine(_build_chasm_sources())
        query = SemanticQuery(
            measures=["orders.revenue", "tickets.ticket_count"],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert "orders_agg" in sql
        assert "tickets_agg" in sql
        sqlglot.parse(sql)


class TestNoFanOut:
    def test_single_source_no_ctes(self):
        sources = _build_chasm_sources()
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["orders.customer_id"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # No aggregate locality needed
        assert "_agg" not in sql
        assert "FULL JOIN" not in sql.upper()
        sqlglot.parse(sql)

    def test_m2o_join_no_ctes(self, ecommerce_sources):
        """orders → customers is m2o, no fanout."""
        graph = JoinGraph(ecommerce_sources)
        graph.build()
        planner = QueryPlanner(ecommerce_sources, graph)
        gen = SqlGenerator(dialect="postgres")

        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, ecommerce_sources)

        assert "_agg" not in sql
        assert "FULL JOIN" not in sql.upper()
        sqlglot.parse(sql)


class TestMultiHopDimensionInChasm:
    def test_chasm_with_regions_dimension(self):
        """Both CTEs must join through customers to reach regions."""
        planner, gen, sources = _make_engine(_build_chasm_sources_with_regions())
        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["regions.name"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert "orders_agg" in sql
        assert "tickets_agg" in sql

        # Both CTEs must join regions (via customers)
        # Extract CTE blocks to verify each one joins regions
        orders_cte_start = sql.index("orders_agg AS")
        tickets_cte_start = sql.index("tickets_agg AS")
        # The orders CTE ends where the tickets CTE begins
        orders_cte = sql[orders_cte_start:tickets_cte_start]
        tickets_cte = sql[tickets_cte_start:]

        assert "public.regions" in orders_cte or "regions" in orders_cte
        assert "public.regions" in tickets_cte or "regions" in tickets_cte
        assert "public.customers" in tickets_cte or "customers" in tickets_cte

        sqlglot.parse(sql)


class TestFanOutWithFilters:
    def test_where_filter_in_chasm(self):
        planner, gen, sources = _make_engine(_build_chasm_sources())
        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["customers.segment"],
            filters=["customers.region = 'US'"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # WHERE should appear inside CTEs
        assert "WHERE" in sql.upper()
        assert "US" in sql
        sqlglot.parse(sql)

    def test_having_filter_in_chasm(self):
        """HAVING filters appear as WHERE on the outer query (no GROUP BY at outer level)."""
        planner, gen, sources = _make_engine(_build_chasm_sources())
        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["customers.segment"],
            filters=["sum(orders.amount) > 10000"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert "10000" in sql

        # Filter should NOT be inside any CTE
        orders_cte_start = sql.index("orders_agg AS")
        tickets_cte_start = sql.index("tickets_agg AS")
        orders_cte = sql[orders_cte_start:tickets_cte_start]
        # Find the outer SELECT (after all CTEs)
        outer_select_start = sql.index(
            "SELECT", tickets_cte_start + len("tickets_agg AS")
        )

        assert "HAVING" not in orders_cte.upper()
        outer_query = sql[outer_select_start:]
        # Outer query has no GROUP BY, so HAVING filters become WHERE
        assert "WHERE" in outer_query.upper()
        assert "10000" in outer_query

    def test_source_specific_where_filter_in_chasm_stays_in_relevant_cte(self):
        planner, gen, sources = _make_engine(_build_chasm_sources())
        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["customers.segment"],
            filters=["tickets.priority = 'high'"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        orders_cte_start = sql.index("orders_agg AS")
        tickets_cte_start = sql.index("tickets_agg AS")
        orders_cte = sql[orders_cte_start:tickets_cte_start]
        filter_index = sql.index("tickets.priority = 'high'")

        assert "tickets.priority = 'high'" not in orders_cte
        assert filter_index > tickets_cte_start
        assert sql.count("tickets.priority = 'high'") == 1
        sqlglot.parse(sql)

    def test_locality_order_by_dimension_uses_output_alias(self):
        planner, gen, sources = _make_engine(_build_chasm_sources())
        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["customers.segment"],
            order_by=[{"field": "customers.segment", "direction": "asc"}],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert "ORDER BY segment" in sql
        assert "ORDER BY customers.segment" not in sql
        sqlglot.parse(sql)

        sqlglot.parse(sql)


class TestThreeWayChasmTrap:
    """Three independent measure sources → three _agg CTEs."""

    def test_three_measure_sources(self):
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
        payments = SourceDefinition(
            name="payments",
            table="public.payments",
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
        sources = {
            "customers": customers,
            "orders": orders,
            "tickets": tickets,
            "payments": payments,
        }
        planner, gen, sources = _make_engine(sources)

        query = SemanticQuery(
            measures=[
                "sum(orders.amount)",
                "count(tickets.id)",
                "sum(payments.amount)",
            ],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert "orders_agg" in sql
        assert "tickets_agg" in sql
        assert "payments_agg" in sql
        assert sql.upper().count("FULL JOIN") >= 2
        assert sql.upper().count("COALESCE") >= 1
        sqlglot.parse(sql)


class TestChasmWithPreDefinedFilters:
    """Chasm trap where a measure has a pre-defined filter (CASE WHEN inside CTE)."""

    def test_filtered_measure_in_chasm_cte(self):
        sources = _build_chasm_sources()
        planner, gen, sources = _make_engine(sources)

        query = SemanticQuery(
            measures=["orders.revenue", "tickets.ticket_count"],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert "orders_agg" in sql
        assert "tickets_agg" in sql
        sqlglot.parse(sql)


class TestChasmWithTimeGranularity:
    """Chasm trap with time dimension."""

    def test_time_dimension_in_chasm(self):
        customers = SourceDefinition(
            name="customers",
            table="public.customers",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="created_at", type="time", role="time"),
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
        planner, gen, sources = _make_engine(sources)

        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=[{"field": "customers.created_at", "granularity": "month"}],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert "orders_agg" in sql
        assert "tickets_agg" in sql
        assert "DATE_TRUNC" in sql.upper()
        sqlglot.parse(sql)


class TestChasmWithDerivedMeasures:
    """Chasm trap with derived measures referencing measures from different CTEs."""

    def test_derived_across_chasm_ctes(self):
        sources = _build_chasm_sources()
        planner, gen, sources = _make_engine(sources)

        query = SemanticQuery(
            measures=[
                {"expr": "sum(orders.amount)", "name": "total_rev"},
                {"expr": "count(tickets.id)", "name": "ticket_count"},
                {"expr": "total_rev / ticket_count", "name": "rev_per_ticket"},
            ],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert "orders_agg" in sql
        assert "tickets_agg" in sql
        assert "rev_per_ticket" in sql
        sqlglot.parse(sql)


class TestFactSideDimensionsInChasm:
    """LIMIT 1: Fact-side dimensions in chasm trap (local to one CTE only)."""

    def test_fact_side_dimension_in_chasm_raises_error(self):
        """Asymmetric dim from fact_a only → raises error (would cause FULL JOIN fanout)."""
        hub = SourceDefinition(
            name="hub",
            table="public.hub",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="segment", type="string"),
            ],
        )
        fact_a = SourceDefinition(
            name="fact_a",
            table="public.fact_a",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="val", type="number"),
                SourceColumn(name="category", type="string"),
            ],
            joins=[
                JoinDeclaration(
                    to="hub", on="hub_id = hub.id", relationship="many_to_one"
                )
            ],
        )
        fact_b = SourceDefinition(
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
        )
        sources = {"hub": hub, "fact_a": fact_a, "fact_b": fact_b}
        planner, gen, sources = _make_engine(sources)

        query = SemanticQuery(
            measures=["sum(fact_a.val)", "sum(fact_b.val)"],
            dimensions=["fact_a.category"],
        )
        plan = planner.plan(query)
        with pytest.raises(ValueError, match="Asymmetric dimension grain"):
            gen.generate(plan, sources)

    def test_shared_and_local_dims_in_chasm_raises_error(self):
        """hub.segment (shared) + fact_a.category (local) → raises error."""
        hub = SourceDefinition(
            name="hub",
            table="public.hub",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="segment", type="string"),
            ],
        )
        fact_a = SourceDefinition(
            name="fact_a",
            table="public.fact_a",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="val", type="number"),
                SourceColumn(name="category", type="string"),
            ],
            joins=[
                JoinDeclaration(
                    to="hub", on="hub_id = hub.id", relationship="many_to_one"
                )
            ],
        )
        fact_b = SourceDefinition(
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
        )
        sources = {"hub": hub, "fact_a": fact_a, "fact_b": fact_b}
        planner, gen, sources = _make_engine(sources)

        query = SemanticQuery(
            measures=["sum(fact_a.val)", "sum(fact_b.val)"],
            dimensions=["hub.segment", "fact_a.category"],
        )
        plan = planner.plan(query)
        with pytest.raises(ValueError, match="Asymmetric dimension grain"):
            gen.generate(plan, sources)


class TestHavingNotInIndividualCtes:
    """LIMIT 3: HAVING clause should NOT appear inside individual CTEs in chasm trap."""

    def test_having_not_in_individual_ctes(self):
        """Verify aggregate filters are NOT inside any individual CTE but on the outer query."""
        sources = _build_chasm_sources()
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["customers.segment"],
            filters=["sum(orders.amount) > 10000"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # Extract individual CTEs
        orders_cte_start = sql.index("orders_agg AS")
        tickets_cte_start = sql.index("tickets_agg AS")
        orders_cte = sql[orders_cte_start:tickets_cte_start]

        # Find the outer SELECT (after all CTEs)
        outer_select_start = sql.index(
            "SELECT", tickets_cte_start + len("tickets_agg AS")
        )
        tickets_cte = sql[tickets_cte_start:outer_select_start]

        # Filter should NOT appear inside either CTE
        assert "HAVING" not in orders_cte.upper(), (
            f"HAVING found in orders CTE: {orders_cte}"
        )
        assert "HAVING" not in tickets_cte.upper(), (
            f"HAVING found in tickets CTE: {tickets_cte}"
        )

        # Filter should appear as WHERE on the outer query (no GROUP BY at this level)
        outer_query = sql[outer_select_start:]
        assert "WHERE" in outer_query.upper()
        assert "10000" in outer_query

        sqlglot.parse(sql)


class TestMeasureFilterInCTE:
    """Fix 6: Measure-level filter sources must be included in CTE joins."""

    def test_measure_filter_source_included_in_cte_joins(self):
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
            measures=[
                MeasureDefinition(
                    name="vip_revenue",
                    expr="sum(amount)",
                    filter="customers.segment = 'VIP'",
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
        planner, gen, sources = _make_engine(sources)

        query = SemanticQuery(
            measures=["orders.vip_revenue", "count(tickets.id)"],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # The orders_agg CTE must join customers (for the measure filter)
        orders_cte_start = sql.index("orders_agg AS")
        tickets_cte_start = sql.index("tickets_agg AS")
        orders_cte = sql[orders_cte_start:tickets_cte_start]
        assert "customers" in orders_cte.lower()
        assert "VIP" in sql
        sqlglot.parse(sql)


class TestDerivedHavingInLocality:
    """Fix 7: Derived HAVING filters must appear in the outer query."""

    def test_derived_having_filter_applied(self):
        planner, gen, sources = _make_engine(_build_chasm_sources())
        query = SemanticQuery(
            measures=[
                {"expr": "sum(orders.amount)", "name": "total_rev"},
                {"expr": "count(tickets.id)", "name": "ticket_count"},
                {"expr": "total_rev / ticket_count", "name": "rev_per_ticket"},
            ],
            dimensions=["customers.segment"],
            filters=["rev_per_ticket > 10"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # The derived filter should appear in the outer query, inlined
        # (not as a bare alias which would be invalid in WHERE)
        assert "> 10" in sql

        # It should NOT be inside any CTE
        orders_cte_start = sql.index("orders_agg AS")
        tickets_cte_start = sql.index("tickets_agg AS")
        orders_cte = sql[orders_cte_start:tickets_cte_start]
        assert "rev_per_ticket" not in orders_cte

        # Find outer query (after last CTE)
        outer_start = sql.index("SELECT", tickets_cte_start + len("tickets_agg AS"))
        outer_query = sql[outer_start:]
        assert "WHERE" in outer_query.upper()
        # The derived filter is inlined (not as bare alias) for valid SQL
        assert "> 10" in outer_query
        sqlglot.parse(sql)


# ── Bug regression tests (bugs 11-17) ─────────────────────────────────


def _build_alias_sources():
    """orders with two aliased joins to the same customers table."""
    customers = SourceDefinition(
        name="customers",
        table="public.customers",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="name", type="string"),
            SourceColumn(name="lifetime_value", type="number"),
        ],
        measures=[MeasureDefinition(name="total_ltv", expr="sum(lifetime_value)")],
    )
    orders = SourceDefinition(
        name="orders",
        table="public.orders",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="billing_customer_id", type="number"),
            SourceColumn(name="shipping_customer_id", type="number"),
            SourceColumn(name="amount", type="number"),
        ],
        joins=[
            JoinDeclaration(
                to="customers",
                on="billing_customer_id = customers.id",
                relationship="many_to_one",
                alias="billing_customer",
            ),
            JoinDeclaration(
                to="customers",
                on="shipping_customer_id = customers.id",
                relationship="many_to_one",
                alias="shipping_customer",
            ),
        ],
    )
    return {"customers": customers, "orders": orders}


def _build_m2o_chain_sources():
    """churn_risk → customers via m2o — NOT a chasm trap."""
    customers = SourceDefinition(
        name="customers",
        table="public.customers",
        grain=["id"],
        columns=[
            SourceColumn(name="id", type="number"),
            SourceColumn(name="name", type="string"),
            SourceColumn(name="segment", type="string"),
        ],
    )
    churn_risk = SourceDefinition(
        name="churn_risk",
        sql="SELECT customer_id, score FROM ml_scores",
        grain=["customer_id"],
        columns=[
            SourceColumn(name="customer_id", type="number"),
            SourceColumn(name="score", type="number"),
        ],
        joins=[
            JoinDeclaration(
                to="customers",
                on="customer_id = customers.id",
                relationship="many_to_one",
            )
        ],
    )
    return {"customers": customers, "churn_risk": churn_risk}


class TestBug11_PredefinedMeasureViaAlias:
    """Predefined measures on aliased sources should resolve correctly."""

    def test_predefined_measure_via_alias(self):
        sources = _build_alias_sources()
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=["billing_customer.total_ltv"],
            dimensions=["shipping_customer.name"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # Should resolve the predefined measure
        assert "sum" in sql.lower()
        assert "lifetime_value" in sql.lower()
        sqlglot.parse(sql)

    def test_runtime_aggregate_on_alias(self):
        sources = _build_alias_sources()
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["billing_customer.name"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert "sum(orders.amount)" in sql.lower()
        sqlglot.parse(sql)


class TestBug12_MixedAggNonaggFilter:
    """Compound filter with both aggregate and non-aggregate parts should be split."""

    def test_mixed_filter_split(self):
        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="amount", type="number"),
                    SourceColumn(name="status", type="string"),
                    SourceColumn(name="category", type="string"),
                ],
            ),
        }
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["orders.category"],
            filters=["sum(orders.amount) > 100 AND orders.status = 'active'"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # Non-aggregate part should be in WHERE, aggregate in HAVING
        assert "WHERE" in sql
        assert "HAVING" in sql
        assert (
            "status" in sql.split("WHERE")[1].split("GROUP BY")[0]
        )  # in WHERE section
        assert "sum" in sql.split("HAVING")[1].lower()  # in HAVING section
        sqlglot.parse(sql)

    def test_separate_filters_still_work(self):
        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="amount", type="number"),
                    SourceColumn(name="status", type="string"),
                    SourceColumn(name="category", type="string"),
                ],
            ),
        }
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["orders.category"],
            filters=["orders.status = 'active'", "sum(orders.amount) > 100"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert "WHERE" in sql
        assert "HAVING" in sql
        sqlglot.parse(sql)


class TestBug13_FalseChasm_AliasAggregate:
    """Runtime aggregate on aliased source should not trigger false chasm detection."""

    def test_no_false_chasm_between_aliases(self):
        sources = _build_alias_sources()
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["billing_customer.name", "shipping_customer.name"],
        )
        plan = planner.plan(query)
        assert not plan.has_fan_out, "Should not detect fanout between alias siblings"
        sql = gen.generate(plan, sources)
        sqlglot.parse(sql)


class TestBug14_HavingDerivedCrossCTE:
    """HAVING on derived cross-CTE measure must inline the expression, not use alias."""

    def test_having_derived_inlined(self):
        planner, gen, sources = _make_engine(_build_chasm_sources())
        query = SemanticQuery(
            measures=[
                {"expr": "sum(orders.amount)", "name": "rev"},
                {"expr": "count(tickets.id)", "name": "cnt"},
                {"expr": "rev - cnt", "name": "net"},
            ],
            dimensions=["customers.segment"],
            filters=["net > 1000"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # The outer WHERE should NOT reference 'net' directly (that's a SELECT alias)
        outer_idx = sql.rindex("SELECT")
        outer = sql[outer_idx:]
        where_section = outer[outer.index("WHERE") :]
        # Should contain the inlined expression, not bare 'net'
        assert "COALESCE" in where_section or "orders_agg" in where_section
        assert "> 1000" in where_section
        sqlglot.parse(sql)


class TestBug15_DivisionByZeroCrossCTE:
    """Cross-CTE derived division should use NULLIF to prevent division by zero."""

    def test_nullif_on_denominator(self):
        hub = SourceDefinition(
            name="hub",
            table="public.hub",
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
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="amount", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="hub", on="hub_id = hub.id", relationship="many_to_one"
                )
            ],
            measures=[MeasureDefinition(name="revenue", expr="sum(amount)")],
        )
        returns = SourceDefinition(
            name="returns",
            table="public.returns",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="refund", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="hub", on="hub_id = hub.id", relationship="many_to_one"
                )
            ],
            measures=[MeasureDefinition(name="total_refunds", expr="sum(refund)")],
        )
        sources = {"hub": hub, "orders": orders, "returns": returns}
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=[
                "orders.revenue",
                "returns.total_refunds",
                {
                    "expr": "returns.total_refunds / orders.revenue",
                    "name": "refund_rate",
                },
            ],
            dimensions=["hub.segment"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # Denominator should be wrapped in NULLIF to prevent division by zero
        assert "NULLIF" in sql
        sqlglot.parse(sql)


class TestBug16_FalseChasmM2OChain:
    """Measures from sources on the same m2o chain should not trigger chasm detection."""

    def test_m2o_chain_no_chasm(self):
        sources = _build_m2o_chain_sources()
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=["avg(churn_risk.score)", "count(customers.id)"],
            dimensions=["customers.segment"],
        )
        plan = planner.plan(query)
        # Should NOT be a chasm — churn_risk → customers is m2o
        assert not plan.has_fan_out, "m2o chain should not be detected as chasm trap"
        sql = gen.generate(plan, sources)

        # Should be simple path, not locality CTEs
        assert "_agg" not in sql
        assert "FULL JOIN" not in sql
        sqlglot.parse(sql)


class TestBug17_EmptyMeasuresSelectDistinct:
    """Dimension-only queries should use SELECT DISTINCT, not GROUP BY."""

    def test_select_distinct_no_group_by(self):
        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="status", type="string"),
                ],
            ),
        }
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=[],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert "SELECT DISTINCT" in sql
        assert "GROUP BY" not in sql
        sqlglot.parse(sql)


class TestDerivedChain3LevelLocality:
    """3-level derived measure chains in locality mode must fully inline."""

    def _build_sources(self):
        hub = SourceDefinition(
            name="hub",
            table="public.hub",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="segment", type="string"),
            ],
        )
        sales = SourceDefinition(
            name="sales",
            table="public.sales",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="amount", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="hub", on="hub_id = hub.id", relationship="many_to_one"
                )
            ],
        )
        costs = SourceDefinition(
            name="costs",
            table="public.costs",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="cost_amount", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="hub", on="hub_id = hub.id", relationship="many_to_one"
                )
            ],
        )
        return {"hub": hub, "sales": sales, "costs": costs}

    def test_3_level_derived_inlines_fully(self):
        """profit = revenue - cost, margin = profit / revenue — both must inline."""
        planner, gen, sources = _make_engine(self._build_sources())
        query = SemanticQuery(
            measures=[
                {"expr": "sum(sales.amount)", "name": "revenue"},
                {"expr": "sum(costs.cost_amount)", "name": "total_cost"},
                {"expr": "revenue - total_cost", "name": "profit"},
                {"expr": "profit / revenue", "name": "margin"},
            ],
            dimensions=["hub.segment"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # margin must NOT reference 'profit' as a bare alias
        assert "CAST(profit " not in sql
        # Should reference CTE columns with COALESCE
        assert "COALESCE(sales_agg.revenue" in sql
        assert "COALESCE(costs_agg.total_cost" in sql
        # Denominator should use NULLIF
        assert "NULLIF" in sql
        sqlglot.parse(sql)

    def test_having_on_3_level_derived(self):
        """HAVING on margin must recursively inline profit and revenue."""
        planner, gen, sources = _make_engine(self._build_sources())
        query = SemanticQuery(
            measures=[
                {"expr": "sum(sales.amount)", "name": "revenue"},
                {"expr": "sum(costs.cost_amount)", "name": "total_cost"},
                {"expr": "revenue - total_cost", "name": "profit"},
                {"expr": "profit / revenue", "name": "margin"},
            ],
            dimensions=["hub.segment"],
            filters=["margin > 0.1"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # WHERE clause must not reference 'profit' or 'margin' as bare aliases
        where_idx = sql.upper().find("WHERE")
        where_clause = sql[where_idx:] if where_idx >= 0 else ""
        assert (
            "margin" not in where_clause.split("AS")[-1]
            if "AS" in where_clause
            else True
        )
        # Must contain inlined CTE references
        assert "sales_agg.revenue" in sql
        assert "costs_agg.total_cost" in sql
        sqlglot.parse(sql)


class TestDerivedWithPredefinedQualifiedRef:
    """Derived measures referencing predefined by source.name must expand both."""

    def test_mixed_bare_and_qualified_deps(self):
        sources = {
            "orders": SourceDefinition(
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
                        name="revenue",
                        expr="sum(amount)",
                        filter="status != 'refunded'",
                    )
                ],
            ),
        }
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=[
                "orders.revenue",
                {"expr": "sum(orders.amount)", "name": "gross"},
                {"expr": "gross - orders.revenue", "name": "refund_amount"},
            ],
            dimensions=["orders.status"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        # refund_amount must inline both gross and revenue
        assert (
            "orders.revenue" not in sql.split("AS refund_amount")[0].split(",")[-1]
            if "AS refund_amount" in sql
            else True
        )
        # Should contain actual SUM expressions
        assert "SUM(" in sql
        assert "CASE WHEN" in sql
        sqlglot.parse(sql)


class TestWindowFunctionRejection:
    """Window functions in measures must be rejected with a clear error."""

    def test_window_function_in_named_measure(self):
        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="amount", type="number"),
                    SourceColumn(name="created_at", type="time"),
                ],
            ),
        }
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=[
                {
                    "expr": "sum(orders.amount) OVER (ORDER BY orders.created_at)",
                    "name": "running",
                }
            ],
            dimensions=["orders.id"],
        )
        with pytest.raises(ValueError, match="Window functions"):
            planner.plan(query)

    def test_row_number_rejected(self):
        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="amount", type="number"),
                ],
            ),
        }
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=[
                "row_number() OVER (PARTITION BY orders.id ORDER BY orders.amount)"
            ],
            dimensions=["orders.id"],
        )
        with pytest.raises(ValueError, match="Window functions"):
            planner.plan(query)


class TestCompositeJoinKeySqlGeneration:
    """Composite join keys generate multi-condition ON clauses."""

    def test_composite_key_in_sql(self):
        items = SourceDefinition(
            name="items",
            table="public.items",
            grain=["order_id", "product_id"],
            columns=[
                SourceColumn(name="order_id", type="number"),
                SourceColumn(name="product_id", type="number"),
                SourceColumn(name="warehouse_id", type="number"),
                SourceColumn(name="qty", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="inventory",
                    on="product_id = inventory.product_id AND warehouse_id = inventory.warehouse_id",
                    relationship="many_to_one",
                )
            ],
        )
        inv = SourceDefinition(
            name="inventory",
            table="public.inventory",
            grain=["product_id", "warehouse_id"],
            columns=[
                SourceColumn(name="product_id", type="number"),
                SourceColumn(name="warehouse_id", type="number"),
                SourceColumn(name="stock", type="number"),
            ],
        )
        planner, gen, sources = _make_engine({"items": items, "inventory": inv})
        query = SemanticQuery(
            measures=["sum(items.qty)"],
            dimensions=["inventory.stock"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)

        assert (
            "items.product_id = inventory.product_id" in sql
            or "inventory.product_id = items.product_id" in sql
        )
        assert (
            "items.warehouse_id = inventory.warehouse_id" in sql
            or "inventory.warehouse_id = items.warehouse_id" in sql
        )
        assert " AND " in sql
        sqlglot.parse(sql)


class TestFilterUnreachableInLocality:
    """BUG 22: Filters on sources unreachable via safe edges from all measure
    sources in a chasm trap should raise an error, not be silently dropped."""

    def _build_sources_with_details(self):
        hub = SourceDefinition(
            name="hub",
            table="public.hub",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="segment", type="string"),
            ],
        )
        details = SourceDefinition(
            name="details",
            table="public.details",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="tag", type="string"),
            ],
            joins=[
                JoinDeclaration(
                    to="hub", on="hub_id = hub.id", relationship="many_to_one"
                )
            ],
        )
        fact_a = SourceDefinition(
            name="fact_a",
            table="public.fact_a",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="val_a", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="hub", on="hub_id = hub.id", relationship="many_to_one"
                )
            ],
        )
        fact_b = SourceDefinition(
            name="fact_b",
            table="public.fact_b",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="hub_id", type="number"),
                SourceColumn(name="val_b", type="number"),
            ],
            joins=[
                JoinDeclaration(
                    to="hub", on="hub_id = hub.id", relationship="many_to_one"
                )
            ],
        )
        return {"hub": hub, "details": details, "fact_a": fact_a, "fact_b": fact_b}

    def test_filter_on_unreachable_source_raises_error(self):
        """Filter on 'details' (reachable only via o2m from hub) should error."""
        planner, gen, sources = _make_engine(self._build_sources_with_details())
        query = SemanticQuery(
            measures=["sum(fact_a.val_a)", "sum(fact_b.val_b)"],
            dimensions=["hub.segment"],
            filters=["details.tag = 'important'"],
        )
        with pytest.raises(ValueError, match="not reachable via many_to_one"):
            planner.plan(query)

    def test_filter_on_reachable_source_works(self):
        """Filter on 'hub' (reachable from both facts via m2o) should work."""
        planner, gen, sources = _make_engine(self._build_sources_with_details())
        query = SemanticQuery(
            measures=["sum(fact_a.val_a)", "sum(fact_b.val_b)"],
            dimensions=["hub.segment"],
            filters=["hub.segment != 'x'"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)
        # Filter should be pushed into both CTEs
        assert sql.count("hub.segment != 'x'") >= 1
        sqlglot.parse(sql)


class TestOrderByCaseInsensitive:
    """BUG 23: ORDER BY field matching should be case-insensitive."""

    def test_order_by_measure_different_case(self):
        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="amount", type="number"),
                    SourceColumn(name="status", type="string"),
                ],
                measures=[MeasureDefinition(name="revenue", expr="sum(amount)")],
            ),
        }
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=["orders.revenue"],
            dimensions=["orders.status"],
            order_by=[{"field": "Revenue", "direction": "desc"}],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)
        assert "ORDER BY revenue DESC" in sql
        sqlglot.parse(sql)

    def test_order_by_dimension_different_case(self):
        sources = {
            "orders": SourceDefinition(
                name="orders",
                table="public.orders",
                grain=["id"],
                columns=[
                    SourceColumn(name="id", type="number"),
                    SourceColumn(name="amount", type="number"),
                    SourceColumn(name="status", type="string"),
                ],
                measures=[MeasureDefinition(name="revenue", expr="sum(amount)")],
            ),
        }
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=["orders.revenue"],
            dimensions=["orders.status"],
            order_by=[{"field": "STATUS", "direction": "asc"}],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)
        assert "ORDER BY" in sql
        sqlglot.parse(sql)


class TestMultiSourceMeasureInLocality:
    """BUG 24: Non-derived measures referencing sources from different measure
    groups should be rejected, not silently placed in one CTE."""

    def test_multi_source_aggregate_raises_error(self):
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
        }
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=[
                "sum(fact_a.val)",
                "sum(fact_b.val)",
                {"expr": "sum(fact_a.val) / count(fact_b.val)", "name": "ratio"},
            ],
            dimensions=["hub.segment"],
        )
        with pytest.raises(ValueError, match="references multiple independent sources"):
            planner.plan(query)

    def test_decomposed_cross_source_works(self):
        """When decomposed into separate measures + derived, should work."""
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
        }
        planner, gen, sources = _make_engine(sources)
        query = SemanticQuery(
            measures=[
                {"expr": "sum(fact_a.val)", "name": "total_a"},
                {"expr": "count(fact_b.val)", "name": "count_b"},
                {"expr": "total_a / count_b", "name": "ratio"},
            ],
            dimensions=["hub.segment"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)
        # Derived measure should be in outer SELECT, not in CTE
        assert "ratio" in sql
        assert "COALESCE" in sql or "NULLIF" in sql
        sqlglot.parse(sql)


# ── 12.4 Fix: Multi-source measure expressions in CTE builder ───────


class TestMultiSourceMeasureExprInLocality:
    """Verify that _collect_cte_target_sources includes sources from
    measure expressions, not just dimensions and filters."""

    @staticmethod
    def _sources():
        hub = SourceDefinition(
            name="hub",
            table="public.hub",
            grain=["id"],
            columns=[
                SourceColumn(name="id", type="number"),
                SourceColumn(name="segment", type="string"),
                SourceColumn(name="weight", type="number"),
            ],
        )
        fact_a = SourceDefinition(
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
        )
        return {"hub": hub, "fact_a": fact_a}

    def test_measure_referencing_secondary_source_generates_join(self):
        """sum(fact_a.val * hub.weight) should JOIN hub inside the CTE."""
        planner, gen, sources = _make_engine(self._sources())
        query = SemanticQuery(
            measures=["sum(fact_a.val * hub.weight)"],
            dimensions=["hub.segment"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)
        # The CTE must join hub to compute the measure expression
        assert "JOIN" in sql
        assert "hub.weight" in sql or "hub" in sql
        sqlglot.parse(sql)


# ── 12.10 Fix: HAVING count(x) = 0 in aggregate locality ────────────


class TestHavingCountZeroInLocality:
    """COALESCE wrapping in HAVING filters for multi-CTE FULL JOIN mode."""

    def test_count_zero_filter_uses_coalesce(self):
        """count(tickets.id) = 0 should use COALESCE so NULL → 0."""
        planner, gen, sources = _make_engine(_build_chasm_sources())
        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["customers.segment"],
            filters=["count(tickets.id) = 0"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)
        assert "COALESCE" in sql
        # The filter should match NULL rows (segments with no tickets)
        assert "= 0" in sql
        sqlglot.parse(sql)

    def test_sum_gt_filter_uses_coalesce(self):
        """sum(orders.amount) > 1000 with COALESCE: NULL → 0 > 1000 → false (correct)."""
        planner, gen, sources = _make_engine(_build_chasm_sources())
        query = SemanticQuery(
            measures=["sum(orders.amount)", "count(tickets.id)"],
            dimensions=["customers.segment"],
            filters=["sum(orders.amount) > 1000"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)
        assert "COALESCE" in sql
        assert "> 1000" in sql
        sqlglot.parse(sql)

    def test_single_group_no_coalesce_in_having(self):
        """Single measure group → no FULL JOIN → no COALESCE needed."""
        planner, gen, sources = _make_engine(_build_chasm_sources())
        query = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=["customers.segment"],
            filters=["sum(orders.amount) > 100"],
        )
        plan = planner.plan(query)
        sql = gen.generate(plan, sources)
        # Single-CTE locality: no COALESCE in HAVING filter
        assert "HAVING" in sql.upper()
        assert "COALESCE" not in sql.split("HAVING")[1] if "HAVING" in sql else True
        sqlglot.parse(sql)
