from __future__ import annotations

import logging

import sqlglot
from sqlglot import exp

logger = logging.getLogger(__name__)


def extract_table_refs(sql: str, dialect: str = "postgres") -> list[tuple[str, ...]]:
    """Return a deduped list of warehouse-table refs found in `sql` as
    tuples of normalized (lowercase, unquoted) name parts.

    Skips CTE self-references. Returns refs in the order they first appear
    so callers can present consistent error messages. Each tuple is the
    fully-qualified name as written in the SQL: `("staging", "shipments")`,
    `("analytics", "marts", "listings")`, or `("listings",)`.

    On parse failure returns []; coverage check is best-effort and must
    not break source writes when the SQL has unusual syntax.
    """
    try:
        tree = sqlglot.parse_one(sql, dialect=dialect)
    except Exception as e:
        logger.debug("sql_table_extractor: parse failed (%s); skipping coverage", e)
        return []

    cte_names = {cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE)}

    seen: set[tuple[str, ...]] = set()
    out: list[tuple[str, ...]] = []
    for t in tree.find_all(exp.Table):
        name = (t.name or "").lower()
        if not name or name in cte_names:
            continue
        parts: list[str] = []
        catalog = t.args.get("catalog")
        db = t.args.get("db")
        if catalog and getattr(catalog, "name", None):
            parts.append(catalog.name.lower())
        if db and getattr(db, "name", None):
            parts.append(db.name.lower())
        parts.append(name)
        ref = tuple(parts)
        if ref not in seen:
            seen.add(ref)
            out.append(ref)
    return out


def normalize_table(value: str) -> tuple[str, ...]:
    """Split a `table:` field value into normalized, lowercased parts."""
    return tuple(p.strip('"').strip("`").lower() for p in value.split(".") if p)


def ref_matches_source_table(ref: tuple[str, ...], source_table: str) -> bool:
    """True iff `ref` is a suffix of `source_table` (or vice versa for the
    1-part bare-name case).

    Examples:
      ref=(marts, listings)        table=ANALYTICS.MARTS.LISTINGS  → True
      ref=(analytics, marts, x)    table=ANALYTICS.MARTS.X         → True
      ref=(listings,)              table=ANALYTICS.MARTS.LISTINGS  → True (bare matches last)
      ref=(staging, shipments)     table=ANALYTICS.MARTS.SHIPMENTS → False (db differs)
    """
    src = normalize_table(source_table)
    if not src or not ref:
        return False
    if len(ref) > len(src):
        return False
    return src[-len(ref) :] == ref


def extract_projected_columns(sql: str, dialect: str = "postgres") -> set[str] | None:
    """Return the set of output column names projected by `sql`.

    Returns None if the projection cannot be statically determined — when
    SELECT * (or qualified `t.*`) is present, or when parsing fails. Callers
    should treat None as "unknown projection" and skip projection-dependent
    checks rather than reporting a false-positive error.
    """
    try:
        tree = sqlglot.parse_one(sql, read=dialect)
    except Exception as e:
        logger.debug("extract_projected_columns: parse failed (%s); skipping", e)
        return None

    if not isinstance(tree, exp.Select):
        return None

    for projection in tree.expressions:
        # Bare `*` or `t.*` — projection list is opaque.
        if isinstance(projection, exp.Star):
            return None
        if isinstance(projection, exp.Column) and isinstance(projection.this, exp.Star):
            return None

    return {name for name in tree.named_selects if name}
