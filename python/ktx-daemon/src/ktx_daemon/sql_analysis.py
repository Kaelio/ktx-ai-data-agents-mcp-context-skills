from __future__ import annotations

import os
from concurrent.futures import ProcessPoolExecutor
from typing import Literal

import sqlglot
from pydantic import BaseModel, Field
from sqlglot import exp

SqlAnalysisClause = Literal["select", "where", "join", "groupBy", "having", "orderBy"]


class AnalyzeSqlBatchItem(BaseModel):
    id: str
    sql: str


class AnalyzeSqlBatchRequest(BaseModel):
    dialect: str
    items: list[AnalyzeSqlBatchItem]
    max_workers: int | None = Field(default=None, ge=1, le=32)


class AnalyzeSqlBatchResult(BaseModel):
    tables_touched: list[str] = Field(default_factory=list)
    columns_by_clause: dict[SqlAnalysisClause, list[str]] = Field(default_factory=dict)
    error: str | None = None


class AnalyzeSqlBatchResponse(BaseModel):
    results: dict[str, AnalyzeSqlBatchResult]


class ValidateReadOnlySqlRequest(BaseModel):
    dialect: str
    sql: str


class ValidateReadOnlySqlResponse(BaseModel):
    ok: bool
    error: str | None = None


_READ_ONLY_ROOT_TYPES = (exp.Select, exp.Union)
_READ_WRITE_NODE_TYPES = (
    exp.Alter,
    exp.Analyze,
    exp.Cache,
    exp.Command,
    exp.Commit,
    exp.Copy,
    exp.Create,
    exp.Delete,
    exp.Describe,
    exp.Drop,
    exp.Execute,
    exp.Grant,
    exp.Insert,
    exp.Merge,
    exp.Pragma,
    exp.Refresh,
    exp.Revoke,
    exp.Rollback,
    exp.Set,
    exp.Show,
    exp.Transaction,
    exp.TruncateTable,
    exp.Uncache,
    exp.Update,
    exp.Use,
)


def _ordered_unique(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        if value and value not in seen:
            seen.add(value)
            result.append(value)
    return result


def _table_ref(table: exp.Table) -> str:
    parts: list[str] = []
    catalog = table.args.get("catalog")
    db = table.args.get("db")
    if catalog is not None and getattr(catalog, "name", None):
        parts.append(str(catalog.name))
    if db is not None and getattr(db, "name", None):
        parts.append(str(db.name))
    if table.name:
        parts.append(str(table.name))
    return ".".join(parts)


def _column_name(column: exp.Column) -> str:
    return str(column.name)


def _columns_from_nodes(nodes: list[object]) -> list[str]:
    names: list[str] = []
    for node in nodes:
        if not isinstance(node, exp.Expression):
            continue
        names.extend(_column_name(column) for column in node.find_all(exp.Column))
    return _ordered_unique(names)


def _columns_by_clause(tree: exp.Expression) -> dict[SqlAnalysisClause, list[str]]:
    result: dict[SqlAnalysisClause, list[str]] = {}

    select_columns = _columns_from_nodes(list(tree.expressions))
    if select_columns:
        result["select"] = select_columns

    where_columns = _columns_from_nodes([tree.args.get("where")])
    if where_columns:
        result["where"] = where_columns

    join_columns = _columns_from_nodes(
        [join.args.get("on") for join in tree.args.get("joins") or []]
    )
    if join_columns:
        result["join"] = join_columns

    group = tree.args.get("group")
    group_columns = _columns_from_nodes(
        list(group.expressions) if group is not None else []
    )
    if group_columns:
        result["groupBy"] = group_columns

    having_columns = _columns_from_nodes([tree.args.get("having")])
    if having_columns:
        result["having"] = having_columns

    order = tree.args.get("order")
    order_columns = _columns_from_nodes(
        list(order.expressions) if order is not None else []
    )
    if order_columns:
        result["orderBy"] = order_columns

    return result


def _analyze_one(
    item_id: str, sql: str, dialect: str
) -> tuple[str, AnalyzeSqlBatchResult]:
    try:
        tree = sqlglot.parse_one(sql, read=dialect)
    except sqlglot.errors.SqlglotError as exc:
        return item_id, AnalyzeSqlBatchResult(error=str(exc))

    cte_names = {cte.alias_or_name.lower() for cte in tree.find_all(exp.CTE)}
    table_refs = [
        table_ref
        for table_ref in (_table_ref(table) for table in tree.find_all(exp.Table))
        if table_ref and table_ref.split(".")[-1].lower() not in cte_names
    ]

    return item_id, AnalyzeSqlBatchResult(
        tables_touched=_ordered_unique(table_refs),
        columns_by_clause=_columns_by_clause(tree),
        error=None,
    )


def _analyze_payload(
    payload: tuple[str, str, str],
) -> tuple[str, AnalyzeSqlBatchResult]:
    item_id, sql, dialect = payload
    return _analyze_one(item_id, sql, dialect)


def validate_read_only_sql_response(
    request: ValidateReadOnlySqlRequest,
) -> ValidateReadOnlySqlResponse:
    try:
        statements = sqlglot.parse(request.sql, read=request.dialect)
    except sqlglot.errors.SqlglotError as exc:
        return ValidateReadOnlySqlResponse(ok=False, error=f"Invalid expression: {exc}")

    if len(statements) != 1:
        return ValidateReadOnlySqlResponse(
            ok=False,
            error="Only one SQL statement can be executed.",
        )

    tree = statements[0]
    if tree is None:
        return ValidateReadOnlySqlResponse(
            ok=False,
            error="SQL did not parse to a statement.",
        )
    if not isinstance(tree, _READ_ONLY_ROOT_TYPES):
        return ValidateReadOnlySqlResponse(
            ok=False,
            error=f"SQL contains read/write operation: {type(tree).__name__}",
        )

    for node in tree.walk():
        if isinstance(node, _READ_WRITE_NODE_TYPES):
            return ValidateReadOnlySqlResponse(
                ok=False,
                error=f"SQL contains read/write operation: {type(node).__name__}",
            )

    return ValidateReadOnlySqlResponse(ok=True, error=None)


def _worker_count(request: AnalyzeSqlBatchRequest) -> int:
    if len(request.items) <= 1:
        return 1
    if request.max_workers is not None:
        return min(request.max_workers, len(request.items))
    return min(os.cpu_count() or 1, len(request.items), 8)


def analyze_sql_batch_response(
    request: AnalyzeSqlBatchRequest,
) -> AnalyzeSqlBatchResponse:
    payloads = [(item.id, item.sql, request.dialect) for item in request.items]
    if _worker_count(request) == 1:
        analyzed = [_analyze_payload(payload) for payload in payloads]
    else:
        with ProcessPoolExecutor(max_workers=_worker_count(request)) as executor:
            analyzed = list(executor.map(_analyze_payload, payloads))

    return AnalyzeSqlBatchResponse(
        results={item_id: result for item_id, result in analyzed}
    )
