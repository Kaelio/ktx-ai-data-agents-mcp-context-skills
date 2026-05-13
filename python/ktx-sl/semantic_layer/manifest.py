"""Manifest models and projection for the two-tier schema architecture.

The manifest (`_schema/*.yaml`) stores physical table catalog data with DB-native
types, PK flags, and join provenance. This module handles:
  - Manifest-specific data models (ManifestColumn, ManifestJoin, ManifestEntry)
  - DB-native → semantic type mapping
  - Projection from ManifestEntry → SourceDefinition
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from semantic_layer.models import (
    ColumnRole,
    DefaultTimeDimensionDbt,
    FreshnessDbt,
    JoinDeclaration,
    SourceColumn,
    SourceColumnTests,
    SourceDefinition,
)

# ── Type mapping (DB-native → semantic) ─────────────────────────────

_TYPE_MAP: dict[str, str] = {
    # number family
    "integer": "number",
    "bigint": "number",
    "smallint": "number",
    "numeric": "number",
    "decimal": "number",
    "float": "number",
    "double": "number",
    "real": "number",
    "int": "number",
    "int2": "number",
    "int4": "number",
    "int8": "number",
    "float4": "number",
    "float8": "number",
    "double precision": "number",
    "number": "number",
    "tinyint": "number",
    "mediumint": "number",
    # time family
    "timestamp": "time",
    "timestamptz": "time",
    "timestamp with time zone": "time",
    "timestamp without time zone": "time",
    "timestamp_ntz": "time",
    "timestamp_ltz": "time",
    "timestamp_tz": "time",
    "datetime": "time",
    "date": "time",
    "time": "time",
    "timetz": "time",
    # boolean family
    "boolean": "boolean",
    "bool": "boolean",
    # fallback → 'string'
}


def map_column_type(db_type: str) -> str:
    """Map a DB-native column type to a semantic type (string/number/time/boolean)."""
    normalized = db_type.lower().split("(")[0].strip()
    return _TYPE_MAP.get(normalized, "string")


# ── Manifest data models ────────────────────────────────────────────


_DEFAULT_PRIORITY = ["user", "ai", "dbt", "db"]


def _description_sources(descriptions: dict[str, str] | None) -> dict[str, str] | None:
    """Normalize multi-source descriptions to a keyed map."""
    if descriptions:
        result = {source: text for source, text in descriptions.items() if text}
        if result:
            return result
    return None


def _resolve_description(descriptions: dict[str, str] | None) -> str | None:
    """Resolve a single description from a multi-source map."""
    if descriptions:
        for source in _DEFAULT_PRIORITY:
            if text := descriptions.get(source):
                return text
        # Fallback: first available
        for text in descriptions.values():
            if text:
                return text
    return None


class ManifestColumn(BaseModel):
    name: str
    type: str  # DB-native type (e.g., "integer", "varchar", "timestamp")
    pk: bool = False
    nullable: bool = True
    descriptions: dict[str, str] | None = None
    constraints: dict | None = None
    enum_values: dict[str, list[str]] | None = None
    tests: SourceColumnTests | None = None

    @property
    def resolved_description(self) -> str | None:
        return _resolve_description(self.descriptions)


class ManifestJoin(BaseModel):
    to: str
    on: str
    relationship: Literal["many_to_one", "one_to_many", "one_to_one"]
    source: Literal["formal", "inferred", "manual"] = "formal"


class ManifestEntry(BaseModel):
    table: str
    descriptions: dict[str, str] | None = None
    columns: list[ManifestColumn]
    joins: list[ManifestJoin] = []
    default_time_dimension: DefaultTimeDimensionDbt | None = None
    tags: dict[str, list[str]] | None = None
    freshness: dict[str, FreshnessDbt] | None = None

    @property
    def resolved_description(self) -> str | None:
        return _resolve_description(self.descriptions)


class Manifest(BaseModel):
    """A single manifest shard file (`_schema/{schema}.yaml`)."""

    tables: dict[str, ManifestEntry]


# ── Projection ──────────────────────────────────────────────────────


def validate_overlay(data: dict) -> list[str]:
    """Validate that overlay data doesn't contain structural fields.

    Returns a list of error messages (empty if valid).
    """
    errors: list[str] = []
    if "description" in data:
        errors.append("Overlay must use 'descriptions' for source descriptions")
    if "table" in data:
        errors.append("Overlay must not contain 'table' (owned by manifest)")
    if "sql" in data:
        errors.append(
            "Overlay must not contain 'sql' (that makes it a standalone source)"
        )
    for col in data.get("columns", []):
        if "description" in col:
            errors.append(
                f"Overlay column '{col.get('name', '?')}' must use 'descriptions'"
            )
        if "type" in col and "expr" not in col:
            errors.append(
                f"Overlay column '{col.get('name', '?')}' specifies 'type' without 'expr' "
                f"(structural types are inherited from manifest — only computed columns may specify a type)"
            )
    return errors


def project_manifest_entry(name: str, entry: ManifestEntry) -> SourceDefinition:
    """Convert a raw manifest entry into a valid SourceDefinition.

    - Maps DB-native column types to semantic types
    - Auto-derives grain from PK columns (or all columns if no PKs)
    - Strips join provenance (source field)
    """
    columns = [
        SourceColumn(
            name=c.name,
            type=map_column_type(c.type),
            role=ColumnRole.TIME
            if map_column_type(c.type) == "time"
            else ColumnRole.DEFAULT,
            description=c.resolved_description,
            constraints=c.constraints,
            enum_values=c.enum_values,
            tests=c.tests,
        )
        for c in entry.columns
    ]
    pk_columns = [c.name for c in entry.columns if c.pk]
    grain = pk_columns if pk_columns else [c.name for c in entry.columns]

    return SourceDefinition(
        name=name,
        table=entry.table,
        description=entry.resolved_description,
        grain=grain,
        columns=columns,
        joins=[
            JoinDeclaration(to=j.to, on=j.on, relationship=j.relationship)
            for j in entry.joins
        ],
        default_time_dimension=entry.default_time_dimension,
        tags=entry.tags,
        freshness=entry.freshness,
    )
