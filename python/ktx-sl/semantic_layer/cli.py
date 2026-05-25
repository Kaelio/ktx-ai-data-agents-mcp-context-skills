"""CLI for the semantic layer engine.

Usage:
    # Simple query
    uv run python -m semantic_layer.cli \
        --sources sources/ecommerce \
        -q '{"measures": ["sum(orders.amount)"], "dimensions": ["orders.status"]}'

    # Pre-defined measure with filter
    uv run python -m semantic_layer.cli \
        --sources sources/ecommerce \
        -q '{"measures": ["orders.revenue"], "dimensions": ["orders.status"]}'

    # Cross-source with time granularity
    uv run python -m semantic_layer.cli \
        --sources sources/ecommerce \
        -q '{"measures": ["sum(orders.amount)"], "dimensions": ["regions.name", {"field": "orders.created_at", "granularity": "month"}], "filters": ["regions.name = '"'"'LATAM'"'"'"]}'

    # Multiple dialects
    uv run python -m semantic_layer.cli \
        --sources sources/ecommerce \
        -q '{"measures": ["sum(orders.amount)"], "dimensions": ["orders.status"]}' \
        --dialect bigquery

    # Plan only (no SQL generation)
    uv run python -m semantic_layer.cli \
        --sources sources/ecommerce \
        -q '{"measures": ["sum(orders.amount)"], "dimensions": ["orders.status"]}' \
        --plan-only

    # JSON input from stdin
    echo '{"measures":["sum(orders.amount)"],"dimensions":["orders.status"]}' | \
        uv run python -m semantic_layer.cli --sources sources/ecommerce --json

    # Custom ORDER BY
    uv run python -m semantic_layer.cli \
        --sources sources/ecommerce \
        -q '{"measures": ["sum(orders.amount)"], "dimensions": ["orders.status"], "order_by": [{"field": "sum(orders.amount)", "direction": "desc"}]}'

    # Validate query (suggest fixes on failure)
    uv run python -m semantic_layer.cli \
        --sources sources/ecommerce \
        -q '{"measures": ["sum(orders.amount)"], "dimensions": ["orders.status"]}' \
        --suggest
"""

from __future__ import annotations

import argparse
import json
import sys

import yaml

from semantic_layer.engine import SemanticEngine
from semantic_layer.models import SourceDefinition


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="semantic-layer",
        description="Query the semantic layer engine and generate SQL",
    )
    p.add_argument(
        "--sources",
        "-s",
        help="Path to the sources directory (e.g. sources/ecommerce)",
    )
    p.add_argument(
        "--model",
        help="Path to a single YAML file containing all source definitions as a list",
    )
    p.add_argument(
        "--dialect",
        "-d",
        default="postgres",
        help="SQL dialect (postgres, bigquery, snowflake, etc.)",
    )

    # Query input
    p.add_argument(
        "--query",
        "-q",
        help='Raw JSON query string (e.g. \'{"measures": ["orders.revenue"], "dimensions": ["orders.status"]}\')',
    )

    # Output modes
    p.add_argument(
        "--json",
        action="store_true",
        dest="json_input",
        help="Read query as JSON from stdin",
    )
    p.add_argument(
        "--plan-only",
        action="store_true",
        help="Show the resolved plan instead of SQL",
    )
    p.add_argument(
        "--plan",
        action="store_true",
        help="Show the resolved plan alongside SQL",
    )
    p.add_argument(
        "--compact",
        action="store_true",
        help="Output SQL without formatting",
    )

    # Info commands
    p.add_argument(
        "--list-sources",
        action="store_true",
        help="List all available sources and exit",
    )
    p.add_argument(
        "--suggest",
        action="store_true",
        help="Validate the query and suggest fixes if it fails",
    )

    return p


def list_sources(engine: SemanticEngine) -> None:
    for name, src in sorted(engine.sources.items()):
        print(f"\n{'─' * 40}")
        print(f"  {name}")
        src_type = "sql" if src.is_sql_source else "table"
        print(f"  type: {src_type}", end="")
        if src.table:
            print(f"  table: {src.table}", end="")
        print(f"  grain: {src.grain}")
        if src.description:
            print(f"  {src.description.strip()}")

        if src.columns:
            print("  columns:")
            for col in src.columns:
                role_tag = f" [{col.role.value}]" if col.role.value != "default" else ""
                print(f"    {col.name}: {col.type}{role_tag}")

        if src.measures:
            print("  measures:")
            for m in src.measures:
                filt = f" (filter: {m.filter})" if m.filter else ""
                print(f"    {m.name}: {m.expr}{filt}")

        if src.joins:
            print("  joins:")
            for j in src.joins:
                print(f"    → {j.to} ({j.relationship}) on {j.on}")


def print_plan(plan) -> None:
    print("\n── Resolved Plan ──")
    print(f"  Sources: {', '.join(plan.sources_used)}")
    print(f"  Anchor:  {plan.anchor_source}")
    if plan.join_paths:
        print("  Joins:")
        for jp in plan.join_paths:
            print(f"    {jp}")
    print(f"  Fanout: {plan.fan_out_description}")
    if plan.aggregate_locality:
        print("  Locality:")
        for al in plan.aggregate_locality:
            print(f"    {al}")
    if plan.where_filters:
        print(f"  WHERE:  {' AND '.join(plan.where_filters)}")
    if plan.having_filters:
        print(f"  HAVING: {' AND '.join(plan.having_filters)}")
    print("  Columns:")
    for col in plan.columns:
        prov = col.provenance.value
        gran = f" ({col.granularity})" if col.granularity else ""
        print(f"    {col.name} [{prov}]{gran}")


def _load_model_file(path: str) -> dict[str, SourceDefinition]:
    """Load a YAML file containing a list of source definitions."""
    with open(path) as f:
        data = yaml.safe_load(f)
    if not isinstance(data, list):
        raise ValueError("Model file must contain a YAML list of source definitions")
    sources: dict[str, SourceDefinition] = {}
    for item in data:
        src = SourceDefinition(**item)
        if src.name in sources:
            raise ValueError(f"Duplicate source name: '{src.name}'")
        sources[src.name] = src
    return sources


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.model:
        sources = _load_model_file(args.model)
        engine = SemanticEngine.from_sources(sources, dialect=args.dialect)
    elif args.sources:
        engine = SemanticEngine(args.sources, dialect=args.dialect)
    else:
        parser.error("Provide --sources or --model")

    # List sources mode
    if args.list_sources:
        list_sources(engine)
        return

    # Build query
    if args.query:
        query_dict = json.loads(args.query)
    elif args.json_input:
        raw = sys.stdin.read()
        query_dict = json.loads(raw)
    else:
        parser.error("Provide --query or --json")
        return

    # Suggest mode
    if args.suggest:
        result = engine.suggest(query_dict)
        if result["success"]:
            print("Query is valid.")
            print_plan(result["plan"])
        else:
            print(f"Query failed: {result['error']}")
            if result.get("graph_errors"):
                for err in result["graph_errors"]:
                    print(f"  Graph error: {err}")
            for s in result.get("suggestions", []):
                if isinstance(s, dict):
                    print(f"  Suggestion: {s.get('description', '')}")
                    for src in s.get("required_sources", []):
                        print(f"    - Define source: {src}")
                    for j in s.get("required_joins", []):
                        print(
                            f"    - Add join: {j['source']}.{j['on']} ({j['relationship']})"
                        )
                    for note in s.get("notes", []):
                        print(f"    Note: {note}")
                else:
                    print(f"  Suggestion: {s}")
        return

    # Plan-only mode
    if args.plan_only:
        plan = engine.plan_only(query_dict)
        print_plan(plan)
        return

    # Full query
    result = engine.query(query_dict)

    if args.plan:
        print_plan(result.resolved_plan)
        print()

    if args.compact:
        print(result.sql)
    else:
        print(f"-- dialect: {result.dialect}")
        print(result.sql)


if __name__ == "__main__":
    main()
