import pytest
from pathlib import Path
import tempfile

import yaml

from semantic_layer.loader import SourceLoader
from semantic_layer.models import SourceDefinition

SOURCES_DIR = Path(__file__).parent.parent / "sources" / "ecommerce"


class TestSourceLoader:
    def test_load_all_ecommerce(self, ecommerce_sources):
        assert len(ecommerce_sources) == 6
        assert set(ecommerce_sources.keys()) == {
            "customers",
            "orders",
            "regions",
            "products",
            "order_items",
            "churn_risk",
        }

    def test_orders_source(self, ecommerce_sources):
        orders = ecommerce_sources["orders"]
        assert orders.is_table_source
        assert orders.table == "public.orders"
        assert orders.grain == ["id"]
        assert len(orders.columns) == 6
        assert len(orders.measures) == 5
        assert len(orders.joins) == 1
        assert orders.joins[0].to == "customers"
        assert orders.joins[0].relationship == "many_to_one"

    def test_churn_risk_sql_source(self, ecommerce_sources):
        churn = ecommerce_sources["churn_risk"]
        assert churn.is_sql_source
        assert churn.sql is not None
        assert "calculate_churn_score" in churn.sql
        assert churn.grain == ["customer_id"]
        assert len(churn.measures) == 1
        assert churn.measures[0].name == "avg_risk"

    def test_regions_no_joins(self, ecommerce_sources):
        regions = ecommerce_sources["regions"]
        assert regions.joins == []
        assert regions.measures == []

    def test_order_items_bridge(self, ecommerce_sources):
        oi = ecommerce_sources["order_items"]
        assert len(oi.joins) == 2
        targets = {j.to for j in oi.joins}
        assert targets == {"orders", "products"}

    def test_revenue_measure_has_filter(self, ecommerce_sources):
        orders = ecommerce_sources["orders"]
        revenue = next(m for m in orders.measures if m.name == "revenue")
        assert revenue.filter == "status != 'refunded'"
        assert revenue.expr == "sum(amount)"

    def test_load_single_file(self):
        loader = SourceLoader(SOURCES_DIR)
        src = loader.load_file(SOURCES_DIR / "regions.yaml")
        assert src.name == "regions"
        assert isinstance(src, SourceDefinition)

    def test_invalid_join_target(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            data = {
                "name": "bad_source",
                "table": "t",
                "grain": ["id"],
                "columns": [{"name": "id", "type": "number"}],
                "joins": [
                    {
                        "to": "nonexistent",
                        "on": "id = nonexistent.id",
                        "relationship": "many_to_one",
                    }
                ],
            }
            path = Path(tmpdir) / "bad.yaml"
            with open(path, "w") as f:
                yaml.dump(data, f)

            loader = SourceLoader(tmpdir)
            with pytest.raises(ValueError, match="nonexistent"):
                loader.load_all()

    def test_duplicate_source_name(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            data = {
                "name": "dupe",
                "table": "t",
                "grain": ["id"],
                "columns": [{"name": "id", "type": "number"}],
            }
            for fname in ["a.yaml", "b.yaml"]:
                with open(Path(tmpdir) / fname, "w") as f:
                    yaml.dump(data, f)

            loader = SourceLoader(tmpdir)
            with pytest.raises(ValueError, match="Duplicate source name"):
                loader.load_all()

    def test_source_description_loads(self, ecommerce_sources):
        churn = ecommerce_sources["churn_risk"]
        assert churn.description is not None
        assert "churn" in churn.description.lower()

    def test_column_role_loads(self, ecommerce_sources):
        orders = ecommerce_sources["orders"]
        time_col = next(c for c in orders.columns if c.name == "created_at")
        assert time_col.role == "time"

    def test_source_without_description(self, ecommerce_sources):
        regions = ecommerce_sources["regions"]
        assert regions.description is None


# ── From test_edge_cases.py ──────────────────────────────────────────


class TestLoaderEdgeCases:
    def test_empty_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            loader = SourceLoader(tmpdir)
            sources = loader.load_all()
            assert sources == {}

    def test_non_yaml_files_ignored(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            (Path(tmpdir) / "readme.txt").write_text("not a yaml file")
            loader = SourceLoader(tmpdir)
            sources = loader.load_all()
            assert sources == {}

    def test_yaml_with_extra_fields(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            data = {
                "name": "test",
                "table": "t",
                "grain": ["id"],
                "columns": [{"name": "id", "type": "number"}],
                "unknown_field": "should be rejected",
            }
            with open(Path(tmpdir) / "test.yaml", "w") as f:
                yaml.dump(data, f)
            loader = SourceLoader(tmpdir)
            with pytest.raises(Exception, match="unknown_field"):
                loader.load_all()

    def test_source_requires_table_or_sql(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            data = {
                "name": "test",
                "grain": ["id"],
                "columns": [{"name": "id", "type": "number"}],
            }
            with open(Path(tmpdir) / "test.yaml", "w") as f:
                yaml.dump(data, f)
            loader = SourceLoader(tmpdir)
            with pytest.raises(Exception, match="table.*sql"):
                loader.load_file(Path(tmpdir) / "test.yaml")

    def test_subdirectory_sources(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            subdir = Path(tmpdir) / "sub"
            subdir.mkdir()
            data = {
                "name": "nested",
                "table": "t",
                "grain": ["id"],
                "columns": [{"name": "id", "type": "number"}],
            }
            with open(subdir / "nested.yaml", "w") as f:
                yaml.dump(data, f)
            loader = SourceLoader(tmpdir)
            sources = loader.load_all()
            assert "nested" in sources
