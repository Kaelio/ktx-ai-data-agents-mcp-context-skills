from __future__ import annotations

import logging
import re
from copy import deepcopy
from pathlib import Path

import yaml

from semantic_layer.manifest import (
    Manifest,
    _description_sources,
    _resolve_description,
    project_manifest_entry,
    validate_overlay,
)
from semantic_layer.models import (
    JoinDeclaration,
    MeasureDefinition,
    Segment,
    SourceColumn,
    SourceDefinition,
)

logger = logging.getLogger(__name__)

_SCHEMA_DIR = "_schema"


def _normalize_ws(s: str) -> str:
    """Collapse whitespace for join deduplication."""
    return re.sub(r"\s+", " ", s.strip())


class SourceLoader:
    def __init__(self, sources_dir: str | Path):
        self.sources_dir = Path(sources_dir)

    def load_all(self) -> dict[str, SourceDefinition]:
        """Load all sources using two-tier architecture.

        1. Load _schema/*.yaml manifest shards → project to SourceDefinitions
        2. Load *.yaml files outside _schema/
           - Has `sql` or `table` → standalone source (load directly)
           - Otherwise → overlay (compose with matching manifest entry)
        3. Validate cross-references
        """
        sources: dict[str, SourceDefinition] = {}
        description_sources: dict[str, dict[str, str] | None] = {}

        # 1. Load manifest shards
        schema_dir = self.sources_dir / _SCHEMA_DIR
        if schema_dir.is_dir():
            for path in sorted(schema_dir.glob("*.yaml")):
                manifest = self._load_manifest_shard(path)
                for name, entry in manifest.tables.items():
                    if name in sources:
                        raise ValueError(
                            f"Duplicate source name '{name}' in manifest shard {path}"
                        )
                    sources[name] = project_manifest_entry(name, entry)
                    description_sources[name] = _description_sources(entry.descriptions)

        # 2. Load files outside _schema/
        for path in sorted(self.sources_dir.rglob("*.yaml")):
            # Skip manifest shards
            if _is_in_schema_dir(path, self.sources_dir):
                continue

            with open(path) as f:
                data = yaml.safe_load(f)

            if not isinstance(data, dict):
                continue

            name = data.get("name")
            if not name:
                continue

            if data.get("sql") or data.get("table"):
                # Standalone source — load directly
                if name in sources:
                    raise ValueError(
                        f"Duplicate source name '{name}': standalone file {path} "
                        f"conflicts with manifest entry"
                    )
                sources[name] = SourceDefinition(**data)
            else:
                # Overlay — validate and compose with matching manifest entry
                errors = validate_overlay(data)
                if errors:
                    raise ValueError(
                        f"Invalid overlay '{name}' in {path}: {'; '.join(errors)}"
                    )
                base = sources.get(name)
                if base:
                    (
                        sources[name],
                        description_sources[name],
                    ) = self._compose(base, data, description_sources.get(name))
                else:
                    logger.warning(
                        "Orphan overlay '%s' in %s: no matching manifest entry, skipping",
                        name,
                        path,
                    )

        self._validate_cross_references(sources)
        return sources

    def load_file(self, path: str | Path) -> SourceDefinition:
        """Load and validate a single standalone YAML source definition."""
        path = Path(path)
        with open(path) as f:
            data = yaml.safe_load(f)
        source = SourceDefinition(**data)
        if not source.table and not source.sql:
            raise ValueError(
                f"Standalone source '{source.name}' in {path} must have 'table' or 'sql'"
            )
        return source

    def _load_manifest_shard(self, path: Path) -> Manifest:
        """Load a single manifest shard file."""
        with open(path) as f:
            data = yaml.safe_load(f)
        return Manifest(**data)

    def _compose(
        self,
        base: SourceDefinition,
        overlay: dict,
        base_description_sources: dict[str, str] | None = None,
    ) -> tuple[SourceDefinition, dict[str, str] | None]:
        """Compose a manifest-projected SourceDefinition with an overlay."""
        source = deepcopy(base)
        description_sources = dict(base_description_sources or {})

        if overlay.get("descriptions"):
            description_sources.update(
                {
                    source_name: text
                    for source_name, text in overlay["descriptions"].items()
                    if text
                }
            )
        if overlay.get("descriptions"):
            source.description = _resolve_description(
                description_sources or None,
            )

        # Filter columns
        excluded = set(overlay.get("exclude_columns", []))
        source.columns = [c for c in source.columns if c.name not in excluded]

        # Append computed columns (overlay columns with expr)
        for col in overlay.get("columns", []):
            source.columns.append(SourceColumn(**col))

        # Set measures
        source.measures = [MeasureDefinition(**m) for m in overlay.get("measures", [])]

        # Set segments
        source.segments = [Segment(**s) for s in overlay.get("segments", [])]

        # Override grain
        if overlay.get("grain"):
            source.grain = overlay["grain"]

        # Union + dedupe joins, apply suppressions
        disabled = {_normalize_ws(j) for j in overlay.get("disable_joins", [])}
        manifest_joins = [
            j for j in source.joins if _normalize_ws(j.on) not in disabled
        ]
        overlay_joins = [JoinDeclaration(**j) for j in overlay.get("joins", [])]
        existing_keys = {f"{j.to}::{_normalize_ws(j.on)}" for j in manifest_joins}
        new_joins = [
            j
            for j in overlay_joins
            if f"{j.to}::{_normalize_ws(j.on)}" not in existing_keys
        ]
        source.joins = manifest_joins + new_joins

        return source, (description_sources or None)

    def _validate_cross_references(self, sources: dict[str, SourceDefinition]) -> None:
        """Validate that all join targets reference existing sources."""
        for source in sources.values():
            for join in source.joins:
                if join.to not in sources:
                    raise ValueError(
                        f"Source '{source.name}' joins to '{join.to}', "
                        f"but '{join.to}' is not defined"
                    )


def _is_in_schema_dir(path: Path, sources_dir: Path) -> bool:
    """Check if a path is inside the _schema/ directory."""
    try:
        path.relative_to(sources_dir / _SCHEMA_DIR)
        return True
    except ValueError:
        return False
