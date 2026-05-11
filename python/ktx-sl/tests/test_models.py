import pytest
from pydantic import ValidationError

from semantic_layer.models import (
    ColumnRole,
    ColumnVisibility,
    ColumnDbtConstraints,
    DefaultTimeDimensionDbt,
    FreshnessDbt,
    MeasureGroup,
    Provenance,
    QueryResult,
    ResolvedColumn,
    ResolvedMeasure,
    ResolvedPlan,
    SemanticQuery,
    SourceColumn,
    SourceDefinition,
)


class TestSourceColumn:
    def test_defaults(self):
        col = SourceColumn(name="id", type="number")
        assert col.visibility == ColumnVisibility.PUBLIC
        assert col.role == ColumnRole.DEFAULT
        assert col.description is None

    def test_all_fields(self):
        col = SourceColumn(
            name="id", type="number", visibility="hidden", role="time", description="PK"
        )
        assert col.visibility == ColumnVisibility.HIDDEN
        assert col.role == ColumnRole.TIME

    def test_descriptions_map_resolves_visible_description(self):
        col = SourceColumn(
            name="account_id",
            type="string",
            descriptions={"ktx": "Identifier for the related account."},
        )
        assert col.description == "Identifier for the related account."

    def test_invalid_type(self):
        with pytest.raises(ValidationError):
            SourceColumn(name="id", type="integer")


class TestSourceDefinition:
    def test_table_source(self):
        src = SourceDefinition(
            name="orders",
            table="public.orders",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        assert src.table == "public.orders"
        assert src.sql is None
        assert src.is_table_source
        assert not src.is_sql_source

    def test_sql_source(self):
        src = SourceDefinition(
            name="churn",
            sql="SELECT * FROM x",
            grain=["customer_id"],
            columns=[SourceColumn(name="customer_id", type="number")],
        )
        assert src.sql == "SELECT * FROM x"
        assert src.table is None
        assert src.is_sql_source
        assert not src.is_table_source

    def test_descriptions_map_resolves_visible_description(self):
        src = SourceDefinition(
            name="orders",
            descriptions={"ktx": "Semantic-layer source for orders."},
            table="public.orders",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        assert src.description == "Semantic-layer source for orders."

    def test_table_and_sql_mutually_exclusive(self):
        with pytest.raises(ValidationError, match="mutually exclusive"):
            SourceDefinition(
                name="bad",
                table="t",
                sql="SELECT 1",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
            )

    def test_empty_grain_rejected(self):
        with pytest.raises(ValidationError, match="grain must be non-empty"):
            SourceDefinition(
                name="bad",
                table="t",
                grain=[],
                columns=[SourceColumn(name="id", type="number")],
            )

    def test_measures_and_joins(self):
        src = SourceDefinition(
            name="orders",
            table="public.orders",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
            joins=[
                {
                    "to": "customers",
                    "on": "cid = customers.id",
                    "relationship": "many_to_one",
                }
            ],
            measures=[{"name": "revenue", "expr": "sum(amount)"}],
        )
        assert len(src.joins) == 1
        assert src.joins[0].to == "customers"
        assert len(src.measures) == 1
        assert src.measures[0].name == "revenue"

    def test_default_time_dimension_optional_and_dump(self):
        minimal = SourceDefinition(
            name="orders",
            table="t",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
        )
        assert minimal.default_time_dimension is None

        src = SourceDefinition(
            name="orders",
            table="t",
            grain=["id"],
            columns=[SourceColumn(name="id", type="number")],
            default_time_dimension=DefaultTimeDimensionDbt(dbt="order_date"),
        )
        dumped = src.model_dump(mode="python", exclude_none=True)
        assert dumped["default_time_dimension"] == {"dbt": "order_date"}

        round_tripped = SourceDefinition.model_validate(dumped)
        assert round_tripped.default_time_dimension == DefaultTimeDimensionDbt(
            dbt="order_date"
        )

    def test_dbt_structural_metadata_round_trips(self):
        src = SourceDefinition(
            name="orders",
            table="public.orders",
            grain=["id"],
            columns=[
                SourceColumn(
                    name="status",
                    type="string",
                    constraints={"dbt": {"not_null": True, "unique": True}},
                    enum_values={"dbt": ["placed", "shipped"]},
                    tests={
                        "dbt": [{"name": "accepted_values", "package": "dbt"}],
                        "dbt_by_package": {"dbt": ["accepted_values"]},
                    },
                )
            ],
            tags={"dbt": ["mart", "finance"]},
            freshness={
                "dbt": {
                    "loaded_at_field": "updated_at",
                    "raw": {"warn_after": {"count": 12, "period": "hour"}},
                }
            },
            default_time_dimension=DefaultTimeDimensionDbt(dbt="updated_at"),
        )

        assert src.columns[0].constraints == {
            "dbt": ColumnDbtConstraints(not_null=True, unique=True)
        }
        assert src.columns[0].enum_values == {"dbt": ["placed", "shipped"]}
        assert src.columns[0].tests is not None
        assert src.columns[0].tests.model_dump(mode="python", exclude_none=True) == {
            "dbt": [{"name": "accepted_values", "package": "dbt"}],
            "dbt_by_package": {"dbt": ["accepted_values"]},
        }
        assert src.tags == {"dbt": ["mart", "finance"]}
        assert src.freshness == {
            "dbt": FreshnessDbt(
                loaded_at_field="updated_at",
                raw={"warn_after": {"count": 12, "period": "hour"}},
            )
        }

        dumped = src.model_dump(mode="python", exclude_none=True)
        round_tripped = SourceDefinition.model_validate(dumped)
        assert round_tripped.columns[0].constraints == src.columns[0].constraints
        assert round_tripped.columns[0].enum_values == src.columns[0].enum_values
        assert round_tripped.columns[0].tests == src.columns[0].tests
        assert round_tripped.tags == src.tags
        assert round_tripped.freshness == src.freshness


class TestSemanticQuery:
    def test_minimal(self):
        q = SemanticQuery(measures=["sum(orders.amount)"])
        assert q.dimensions == []
        assert q.filters == []
        assert q.limit == 1000

    def test_mixed_measures(self):
        q = SemanticQuery(
            measures=[
                "orders.revenue",
                {"expr": "sum(orders.amount)", "name": "total"},
            ]
        )
        assert isinstance(q.measures[0], str)
        assert isinstance(q.measures[1], dict)

    def test_with_dimensions(self):
        q = SemanticQuery(
            measures=["sum(orders.amount)"],
            dimensions=[
                "orders.status",
                {"field": "orders.created_at", "granularity": "month"},
            ],
        )
        assert len(q.dimensions) == 2


class TestResolvedModels:
    def test_resolved_column(self):
        col = ResolvedColumn(
            name="revenue", provenance=Provenance.VERIFIED, expr="sum(amount)"
        )
        assert col.provenance == Provenance.VERIFIED

    def test_resolved_measure(self):
        m = ResolvedMeasure(name="revenue", expr="sum(amount)", source_name="orders")
        assert m.provenance == Provenance.COMPOSED
        assert not m.is_derived

    def test_measure_group(self):
        m = ResolvedMeasure(name="rev", expr="sum(amount)", source_name="orders")
        g = MeasureGroup(source_name="orders", measures=[m])
        assert g.source_name == "orders"

    def test_resolved_plan(self):
        plan = ResolvedPlan(
            sources_used=["orders"],
            join_paths=[],
            anchor_grain=["id"],
            fan_out_description="none",
            aggregate_locality=[],
            where_filters=[],
            having_filters=[],
            columns=[ResolvedColumn(name="revenue", provenance=Provenance.COMPOSED)],
        )
        assert plan.has_fan_out is False
        assert plan.measure_groups == []

    def test_query_result(self):
        plan = ResolvedPlan(
            sources_used=["orders"],
            join_paths=[],
            anchor_grain=["id"],
            fan_out_description="none",
            aggregate_locality=[],
            where_filters=[],
            having_filters=[],
            columns=[],
        )
        result = QueryResult(
            resolved_plan=plan, sql="SELECT 1", dialect="postgres", columns=[]
        )
        assert result.dialect == "postgres"


class TestJoinDeclaration:
    def test_with_alias(self):
        from semantic_layer.models import JoinDeclaration

        j = JoinDeclaration(
            to="customers",
            on="billing_customer_id = customers.id",
            relationship="many_to_one",
            alias="billing_customer",
        )
        assert j.alias == "billing_customer"
        assert j.to == "customers"

    def test_without_alias(self):
        from semantic_layer.models import JoinDeclaration

        j = JoinDeclaration(
            to="customers",
            on="customer_id = customers.id",
            relationship="many_to_one",
        )
        assert j.alias is None


class TestMeasureDefinition:
    def test_with_filter_and_description(self):
        from semantic_layer.models import MeasureDefinition

        m = MeasureDefinition(
            name="revenue",
            expr="sum(amount)",
            filter="status != 'refunded'",
            description="Net revenue excluding refunds",
        )
        assert m.filter == "status != 'refunded'"
        assert m.description == "Net revenue excluding refunds"

    def test_minimal(self):
        from semantic_layer.models import MeasureDefinition

        m = MeasureDefinition(name="total", expr="count(id)")
        assert m.filter is None
        assert m.description is None


class TestSemanticQueryExtended:
    def test_include_empty_default(self):
        q = SemanticQuery(measures=["sum(orders.amount)"])
        assert q.include_empty is True

    def test_include_empty_false(self):
        q = SemanticQuery(measures=["sum(orders.amount)"], include_empty=False)
        assert q.include_empty is False

    def test_with_order_by(self):
        q = SemanticQuery(
            measures=["sum(orders.amount)"],
            order_by=[{"field": "orders.amount", "direction": "desc"}],
        )
        assert len(q.order_by) == 1
        assert q.order_by[0]["direction"] == "desc"

    def test_custom_limit(self):
        q = SemanticQuery(measures=["sum(orders.amount)"], limit=50)
        assert q.limit == 50


# ── From test_edge_cases.py ──────────────────────────────────────────


class TestModelEdgeCases:
    def test_semantic_query_empty_measures(self):
        q = SemanticQuery(measures=[])
        assert q.measures == []

    def test_semantic_query_defaults(self):
        q = SemanticQuery(measures=["sum(x.y)"])
        assert q.dimensions == []
        assert q.filters == []
        assert q.order_by == []
        assert q.limit == 1000
        assert q.include_empty is True

    def test_semantic_query_with_order_by(self):
        q = SemanticQuery(
            measures=["sum(orders.amount)"],
            order_by=[{"field": "orders.status", "direction": "desc"}],
        )
        assert len(q.order_by) == 1

    def test_table_and_sql_mutually_exclusive(self):
        with pytest.raises(ValidationError, match="mutually exclusive"):
            SourceDefinition(
                name="bad",
                table="t",
                sql="SELECT 1",
                grain=["id"],
                columns=[SourceColumn(name="id", type="number")],
            )

    def test_empty_grain_rejected(self):
        with pytest.raises(ValidationError, match="grain must be non-empty"):
            SourceDefinition(
                name="bad",
                table="t",
                grain=[],
                columns=[SourceColumn(name="id", type="number")],
            )

    def test_measure_definition_with_filter(self):
        from semantic_layer.models import MeasureDefinition

        m = MeasureDefinition(
            name="rev", expr="sum(amount)", filter="status != 'refunded'"
        )
        assert m.filter == "status != 'refunded'"
