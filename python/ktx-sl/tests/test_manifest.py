"""Tests for manifest models, projection, overlay validation, and two-tier loading."""

from __future__ import annotations

from pathlib import Path

import pytest
import yaml

from semantic_layer.loader import SourceLoader
from semantic_layer.manifest import (
    ManifestColumn,
    ManifestEntry,
    ManifestJoin,
    map_column_type,
    project_manifest_entry,
    validate_overlay,
)
from semantic_layer.models import ColumnRole


# ── Type Mapping Tests ──────────────────────────────────────────────


class TestMapColumnType:
    def test_map_column_type_numbers(self):
        number_types = [
            "integer",
            "bigint",
            "smallint",
            "numeric",
            "decimal",
            "float",
            "double",
            "real",
            "int",
            "int2",
            "int4",
            "int8",
            "float4",
            "float8",
            "double precision",
            "number",
            "tinyint",
            "mediumint",
        ]
        for db_type in number_types:
            assert map_column_type(db_type) == "number", (
                f"{db_type} should map to 'number'"
            )

    def test_map_column_type_time(self):
        time_types = [
            "timestamp",
            "timestamptz",
            "timestamp with time zone",
            "timestamp without time zone",
            "TIMESTAMP_NTZ",
            "TIMESTAMP_LTZ",
            "TIMESTAMP_TZ",
            "datetime",
            "date",
            "time",
            "timetz",
        ]
        for db_type in time_types:
            assert map_column_type(db_type) == "time", f"{db_type} should map to 'time'"

    def test_map_column_type_boolean(self):
        for db_type in ["boolean", "bool"]:
            assert map_column_type(db_type) == "boolean", (
                f"{db_type} should map to 'boolean'"
            )

    def test_map_column_type_string_fallback(self):
        string_types = ["varchar", "text", "char", "unknown", "jsonb", "xml"]
        for db_type in string_types:
            assert map_column_type(db_type) == "string", (
                f"{db_type} should map to 'string'"
            )

    def test_map_column_type_strips_precision(self):
        assert map_column_type("numeric(10,2)") == "number"
        assert map_column_type("varchar(255)") == "string"
        assert map_column_type("decimal(18,4)") == "number"
        assert map_column_type("timestamp(6)") == "time"
        assert map_column_type("char(1)") == "string"


# ── Manifest Projection Tests ──────────────────────────────────────


class TestProjectManifestEntry:
    @pytest.fixture()
    def orders_entry(self) -> ManifestEntry:
        return ManifestEntry(
            table="public.orders",
            descriptions={"user": "Customer orders"},
            columns=[
                ManifestColumn(name="id", type="integer", pk=True),
                ManifestColumn(name="customer_id", type="integer"),
                ManifestColumn(name="total", type="numeric"),
                ManifestColumn(name="status", type="varchar"),
                ManifestColumn(name="created_at", type="timestamp"),
            ],
            joins=[
                ManifestJoin(
                    to="customers",
                    on="orders.customer_id = customers.id",
                    relationship="many_to_one",
                    source="formal",
                ),
            ],
        )

    def test_project_manifest_entry_basic(self, orders_entry: ManifestEntry):
        src = project_manifest_entry("orders", orders_entry)
        assert src.name == "orders"
        assert src.table == "public.orders"
        assert src.description == "Customer orders"
        assert len(src.columns) == 5
        assert src.measures == []
        col_names = [c.name for c in src.columns]
        assert col_names == ["id", "customer_id", "total", "status", "created_at"]

    def test_project_manifest_entry_type_mapping(self, orders_entry: ManifestEntry):
        src = project_manifest_entry("orders", orders_entry)
        col_types = {c.name: c.type for c in src.columns}
        assert col_types["id"] == "number"
        assert col_types["customer_id"] == "number"
        assert col_types["total"] == "number"
        assert col_types["status"] == "string"
        assert col_types["created_at"] == "time"

    def test_project_manifest_entry_grain_from_pk(self, orders_entry: ManifestEntry):
        src = project_manifest_entry("orders", orders_entry)
        assert src.grain == ["id"]

    def test_project_manifest_entry_grain_all_columns_no_pk(self):
        entry = ManifestEntry(
            table="public.events",
            columns=[
                ManifestColumn(name="user_id", type="integer"),
                ManifestColumn(name="event_type", type="varchar"),
                ManifestColumn(name="ts", type="timestamp"),
            ],
        )
        src = project_manifest_entry("events", entry)
        assert src.grain == ["user_id", "event_type", "ts"]

    def test_project_manifest_entry_joins_stripped(self, orders_entry: ManifestEntry):
        src = project_manifest_entry("orders", orders_entry)
        assert len(src.joins) == 1
        join = src.joins[0]
        assert join.to == "customers"
        assert join.on == "orders.customer_id = customers.id"
        assert join.relationship == "many_to_one"
        assert not hasattr(join, "source") or getattr(join, "source", None) is None

    def test_project_manifest_entry_time_role(self, orders_entry: ManifestEntry):
        src = project_manifest_entry("orders", orders_entry)
        time_cols = [c for c in src.columns if c.role == ColumnRole.TIME]
        assert len(time_cols) == 1
        assert time_cols[0].name == "created_at"
        non_time = [c for c in src.columns if c.role == ColumnRole.DEFAULT]
        assert len(non_time) == 4

    def test_project_manifest_entry_preserves_dbt_metadata(self):
        entry = ManifestEntry(
            table="public.orders",
            columns=[
                ManifestColumn(
                    name="status",
                    type="varchar",
                    constraints={"dbt": {"not_null": True}},
                    enum_values={"dbt": ["placed", "shipped"]},
                    tests={"dbt": [{"name": "accepted_values", "package": "dbt"}]},
                )
            ],
            tags={"dbt": ["mart"]},
            freshness={"dbt": {"loaded_at_field": "updated_at"}},
        )

        src = project_manifest_entry("orders", entry)

        assert src.columns[0].constraints is not None
        assert src.columns[0].constraints["dbt"].not_null is True
        assert src.columns[0].enum_values == {"dbt": ["placed", "shipped"]}
        assert src.columns[0].tests is not None
        assert src.columns[0].tests.model_dump(mode="python", exclude_none=True) == {
            "dbt": [{"name": "accepted_values", "package": "dbt"}]
        }
        assert src.tags == {"dbt": ["mart"]}
        assert src.freshness is not None
        assert src.freshness["dbt"].loaded_at_field == "updated_at"


# ── Overlay Validation Tests ───────────────────────────────────────


class TestValidateOverlay:
    def test_validate_overlay_valid(self):
        data = {
            "name": "orders",
            "descriptions": {"user": "Revenue-bearing orders"},
            "grain": ["id"],
            "measures": [{"name": "revenue", "expr": "sum(total)"}],
            "columns": [
                {"name": "is_high_value", "expr": "total > 1000", "type": "boolean"}
            ],
            "exclude_columns": ["status"],
        }
        errors = validate_overlay(data)
        assert errors == []

    def test_validate_overlay_rejects_table(self):
        data = {"name": "orders", "table": "public.orders"}
        errors = validate_overlay(data)
        assert len(errors) == 1
        assert "table" in errors[0].lower()

    def test_validate_overlay_rejects_sql(self):
        data = {"name": "orders", "sql": "SELECT * FROM orders"}
        errors = validate_overlay(data)
        assert len(errors) == 1
        assert "sql" in errors[0].lower()

    def test_validate_overlay_rejects_type_without_expr(self):
        data = {
            "name": "orders",
            "columns": [{"name": "status", "type": "string"}],
        }
        errors = validate_overlay(data)
        assert len(errors) == 1
        assert "type" in errors[0].lower()
        assert "expr" in errors[0].lower()

    def test_validate_overlay_allows_type_with_expr(self):
        data = {
            "name": "orders",
            "columns": [{"name": "is_big", "type": "boolean", "expr": "total > 1000"}],
        }
        errors = validate_overlay(data)
        assert errors == []


# ── Two-Tier Loading Tests ─────────────────────────────────────────


def _write_yaml(path: Path, data: dict | list) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w") as f:
        yaml.dump(data, f, default_flow_style=False)


def _manifest_tables() -> dict:
    """Manifest shard with orders + customers tables."""
    return {
        "tables": {
            "orders": {
                "table": "public.orders",
                "descriptions": {"user": "Customer orders"},
                "columns": [
                    {"name": "id", "type": "integer", "pk": True},
                    {"name": "customer_id", "type": "integer"},
                    {"name": "total", "type": "numeric"},
                    {"name": "status", "type": "varchar"},
                    {"name": "created_at", "type": "timestamp"},
                ],
                "joins": [
                    {
                        "to": "customers",
                        "on": "orders.customer_id = customers.id",
                        "relationship": "many_to_one",
                        "source": "formal",
                    },
                ],
            },
            "customers": {
                "table": "public.customers",
                "descriptions": {"user": "Customer accounts"},
                "columns": [
                    {"name": "id", "type": "integer", "pk": True},
                    {"name": "name", "type": "varchar"},
                ],
                "joins": [
                    {
                        "to": "orders",
                        "on": "customers.id = orders.customer_id",
                        "relationship": "one_to_many",
                        "source": "formal",
                    },
                ],
            },
        },
    }


class TestTwoTierLoading:
    def test_load_manifest_shard(self, tmp_path: Path):
        schema_dir = tmp_path / "_schema"
        _write_yaml(schema_dir / "public.yaml", _manifest_tables())

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()

        assert "orders" in sources
        assert "customers" in sources
        assert sources["orders"].table == "public.orders"
        assert sources["orders"].grain == ["id"]
        assert sources["customers"].table == "public.customers"

    def test_load_standalone_source(self, tmp_path: Path):
        standalone = {
            "name": "regions",
            "table": "public.regions",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "name", "type": "string"},
            ],
        }
        _write_yaml(tmp_path / "regions.yaml", standalone)

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()

        assert "regions" in sources
        assert sources["regions"].table == "public.regions"
        assert sources["regions"].is_table_source

    def test_overlay_descriptions_do_not_promote_base_map_to_user_source(
        self, tmp_path: Path
    ):
        standalone = {
            "name": "regions",
            "descriptions": {"ai": "Standalone description"},
            "table": "public.regions",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
            ],
        }
        _write_yaml(tmp_path / "a_regions.yaml", standalone)

        overlay = {"name": "regions", "descriptions": {"dbt": "dbt description"}}
        _write_yaml(tmp_path / "z_regions_overlay.yaml", overlay)

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()

        assert sources["regions"].description == "dbt description"

    def test_load_sql_source(self, tmp_path: Path):
        sql_source = {
            "name": "active_users",
            "sql": "SELECT id, email FROM users WHERE active = true",
            "grain": ["id"],
            "columns": [
                {"name": "id", "type": "number"},
                {"name": "email", "type": "string"},
            ],
        }
        _write_yaml(tmp_path / "active_users.yaml", sql_source)

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()

        assert "active_users" in sources
        assert sources["active_users"].is_sql_source
        assert "SELECT" in sources["active_users"].sql

    def test_load_overlay_composition(self, tmp_path: Path):
        schema_dir = tmp_path / "_schema"
        _write_yaml(schema_dir / "public.yaml", _manifest_tables())

        overlay = {
            "name": "orders",
            "descriptions": {"user": "Revenue-bearing orders"},
            "grain": ["id"],
            "measures": [{"name": "revenue", "expr": "sum(total)"}],
        }
        _write_yaml(tmp_path / "orders.yaml", overlay)

        # Customers overlay (empty, just name match) to avoid cross-ref error
        _write_yaml(tmp_path / "customers.yaml", {"name": "customers"})

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()

        orders = sources["orders"]
        assert orders.table == "public.orders"
        assert orders.description == "Revenue-bearing orders"
        assert len(orders.measures) == 1
        assert orders.measures[0].name == "revenue"

    def test_overlay_description_map_override(self, tmp_path: Path):
        schema_dir = tmp_path / "_schema"
        _write_yaml(schema_dir / "public.yaml", _manifest_tables())

        overlay = {"name": "orders", "descriptions": {"user": "Overridden description"}}
        _write_yaml(tmp_path / "orders.yaml", overlay)
        _write_yaml(tmp_path / "customers.yaml", {"name": "customers"})

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()
        assert sources["orders"].description == "Overridden description"

    def test_overlay_descriptions_map_preserves_higher_priority_manifest_description(
        self, tmp_path: Path
    ):
        schema_dir = tmp_path / "_schema"
        _write_yaml(schema_dir / "public.yaml", _manifest_tables())

        overlay = {
            "name": "orders",
            "descriptions": {
                "db": "DB description",
                "dbt": "dbt description",
            },
        }
        _write_yaml(tmp_path / "orders.yaml", overlay)
        _write_yaml(tmp_path / "customers.yaml", {"name": "customers"})

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()
        assert sources["orders"].description == "Customer orders"

    def test_overlay_descriptions_map_overrides_lower_priority_db_source(
        self, tmp_path: Path
    ):
        schema_dir = tmp_path / "_schema"
        _write_yaml(
            schema_dir / "public.yaml",
            {
                "tables": {
                    "orders": {
                        "table": "public.orders",
                        "descriptions": {"db": "DB description"},
                        "columns": [{"name": "id", "type": "integer", "pk": True}],
                    },
                    "customers": {
                        "table": "public.customers",
                        "columns": [{"name": "id", "type": "integer", "pk": True}],
                    },
                }
            },
        )

        overlay = {
            "name": "orders",
            "descriptions": {
                "dbt": "dbt description",
            },
        }
        _write_yaml(tmp_path / "orders.yaml", overlay)
        _write_yaml(tmp_path / "customers.yaml", {"name": "customers"})

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()
        assert sources["orders"].description == "dbt description"

    def test_overlay_exclude_columns(self, tmp_path: Path):
        schema_dir = tmp_path / "_schema"
        _write_yaml(schema_dir / "public.yaml", _manifest_tables())

        overlay = {"name": "orders", "exclude_columns": ["status"]}
        _write_yaml(tmp_path / "orders.yaml", overlay)
        _write_yaml(tmp_path / "customers.yaml", {"name": "customers"})

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()

        col_names = [c.name for c in sources["orders"].columns]
        assert "status" not in col_names
        assert "id" in col_names
        assert "total" in col_names

    def test_overlay_computed_columns_appended(self, tmp_path: Path):
        schema_dir = tmp_path / "_schema"
        _write_yaml(schema_dir / "public.yaml", _manifest_tables())

        overlay = {
            "name": "orders",
            "columns": [
                {"name": "is_high_value", "expr": "total > 1000", "type": "boolean"},
            ],
        }
        _write_yaml(tmp_path / "orders.yaml", overlay)
        _write_yaml(tmp_path / "customers.yaml", {"name": "customers"})

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()

        col_names = [c.name for c in sources["orders"].columns]
        assert "is_high_value" in col_names
        # Original columns still present
        assert "id" in col_names
        assert "total" in col_names
        # Computed column is at end
        hv = next(c for c in sources["orders"].columns if c.name == "is_high_value")
        assert hv.expr == "total > 1000"
        assert hv.type == "boolean"

    def test_overlay_measures_set(self, tmp_path: Path):
        schema_dir = tmp_path / "_schema"
        _write_yaml(schema_dir / "public.yaml", _manifest_tables())

        overlay = {
            "name": "orders",
            "measures": [
                {"name": "revenue", "expr": "sum(total)"},
                {"name": "order_count", "expr": "count(id)"},
            ],
        }
        _write_yaml(tmp_path / "orders.yaml", overlay)
        _write_yaml(tmp_path / "customers.yaml", {"name": "customers"})

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()

        assert len(sources["orders"].measures) == 2
        measure_names = {m.name for m in sources["orders"].measures}
        assert measure_names == {"revenue", "order_count"}

    def test_overlay_grain_override(self, tmp_path: Path):
        schema_dir = tmp_path / "_schema"
        _write_yaml(schema_dir / "public.yaml", _manifest_tables())

        overlay = {"name": "orders", "grain": ["id", "customer_id"]}
        _write_yaml(tmp_path / "orders.yaml", overlay)
        _write_yaml(tmp_path / "customers.yaml", {"name": "customers"})

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()
        assert sources["orders"].grain == ["id", "customer_id"]

    def test_overlay_join_union_and_dedupe(self, tmp_path: Path):
        schema_dir = tmp_path / "_schema"
        _write_yaml(schema_dir / "public.yaml", _manifest_tables())

        # Add a "regions" standalone so the join target exists
        _write_yaml(
            tmp_path / "regions.yaml",
            {
                "name": "regions",
                "table": "public.regions",
                "grain": ["id"],
                "columns": [
                    {"name": "id", "type": "number"},
                    {"name": "name", "type": "string"},
                ],
            },
        )

        overlay = {
            "name": "orders",
            "joins": [
                # Duplicate of manifest join (should be deduped)
                {
                    "to": "customers",
                    "on": "orders.customer_id = customers.id",
                    "relationship": "many_to_one",
                },
                # New join
                {
                    "to": "regions",
                    "on": "orders.region_id = regions.id",
                    "relationship": "many_to_one",
                },
            ],
        }
        _write_yaml(tmp_path / "orders.yaml", overlay)
        _write_yaml(tmp_path / "customers.yaml", {"name": "customers"})

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()

        joins = sources["orders"].joins
        # Manifest had 1 join to customers, overlay adds 1 new (regions), duplicate deduped
        assert len(joins) == 2
        join_targets = [j.to for j in joins]
        assert "customers" in join_targets
        assert "regions" in join_targets

    def test_overlay_disable_joins(self, tmp_path: Path):
        schema_dir = tmp_path / "_schema"
        _write_yaml(schema_dir / "public.yaml", _manifest_tables())

        overlay = {
            "name": "orders",
            "disable_joins": ["orders.customer_id = customers.id"],
        }
        _write_yaml(tmp_path / "orders.yaml", overlay)

        # Customers still needs to exist since the customers manifest entry has
        # a join back to orders that is NOT disabled
        _write_yaml(tmp_path / "customers.yaml", {"name": "customers"})

        loader = SourceLoader(tmp_path)
        sources = loader.load_all()

        assert len(sources["orders"].joins) == 0

    def test_overlay_rejects_invalid(self, tmp_path: Path):
        schema_dir = tmp_path / "_schema"
        _write_yaml(schema_dir / "public.yaml", _manifest_tables())

        # An overlay with a column that has type but no expr is invalid
        overlay = {
            "name": "orders",
            "columns": [{"name": "status", "type": "string"}],
        }
        _write_yaml(tmp_path / "orders.yaml", overlay)
        _write_yaml(tmp_path / "customers.yaml", {"name": "customers"})

        loader = SourceLoader(tmp_path)
        with pytest.raises(ValueError, match="Invalid overlay"):
            loader.load_all()
