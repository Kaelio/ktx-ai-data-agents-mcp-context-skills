from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field
from semantic_layer.table_identifier_parser import (
    ParseTableIdentifierItem as SharedParseTableIdentifierItem,
    parse_table_identifier_batch,
)

ParseTableIdentifierReason = Literal[
    "looker_template_unresolved",
    "derived_table_not_supported",
    "no_physical_table",
    "multiple_table_references",
    "unsupported_dialect",
    "parse_error",
]


class ParseTableIdentifierItem(BaseModel):
    key: str
    sql_table_name: str
    dialect: str


class ParseTableIdentifierBatchRequest(BaseModel):
    items: list[ParseTableIdentifierItem]


class ParsedIdentifier(BaseModel):
    ok: bool
    catalog: str | None = None
    schema_: str | None = Field(default=None, alias="schema")
    name: str | None = None
    canonical_table: str | None = None
    reason: ParseTableIdentifierReason | None = None
    detail: str | None = None


class ParseTableIdentifierBatchResponse(BaseModel):
    results: dict[str, ParsedIdentifier]


def parse_table_identifier_response(
    request: ParseTableIdentifierBatchRequest,
) -> ParseTableIdentifierBatchResponse:
    shared_results = parse_table_identifier_batch(
        [
            SharedParseTableIdentifierItem(
                key=item.key,
                sql_table_name=item.sql_table_name,
                dialect=item.dialect,
            )
            for item in request.items
        ]
    )
    return ParseTableIdentifierBatchResponse(
        results={
            key: ParsedIdentifier(
                ok=value.ok,
                catalog=value.catalog,
                schema=value.schema_,
                name=value.name,
                canonical_table=value.canonical_table,
                reason=value.reason,
                detail=value.detail,
            )
            for key, value in shared_results.items()
        }
    )
