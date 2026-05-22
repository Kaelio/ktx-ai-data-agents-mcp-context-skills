"""FastAPI app factory for the KTX daemon semantic compute server."""

from __future__ import annotations

import logging
import os
import sys
import time
from contextlib import asynccontextmanager
from collections.abc import Callable
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import Response

from ktx_daemon import VERSION
from ktx_daemon.code_execution import (
    ExecuteCodeRequest,
    ExecuteCodeResponse,
    dumps_numpy_json,
    execute_code_response,
)
from ktx_daemon.database_introspection import (
    DatabaseIntrospectionRequest,
    DatabaseIntrospectionResponse,
    introspect_database_response,
)
from ktx_daemon.embeddings import (
    ComputeEmbeddingBulkRequest,
    ComputeEmbeddingBulkResponse,
    ComputeEmbeddingRequest,
    ComputeEmbeddingResponse,
    EmbeddingProvider,
    compute_embedding_bulk_response,
    compute_embedding_response,
)
from ktx_daemon.lookml import (
    ParseLookMLRequest,
    ParseLookMLResponse,
    parse_lookml_project,
)
from ktx_daemon.semantic_layer import (
    SemanticLayerQueryRequest,
    SemanticLayerQueryResponse,
    ValidateSourcesRequest,
    ValidateSourcesResponse,
    query_semantic_layer,
    validate_semantic_layer,
)
from ktx_daemon.source_generation import (
    GenerateSourcesRequest,
    GenerateSourcesResponse,
    generate_sources_response,
)
from ktx_daemon.sql_analysis import (
    AnalyzeSqlBatchRequest,
    AnalyzeSqlBatchResponse,
    ValidateReadOnlySqlRequest,
    ValidateReadOnlySqlResponse,
    analyze_sql_batch_response,
    validate_read_only_sql_response,
)
from ktx_daemon.table_identifier import (
    ParseTableIdentifierBatchRequest,
    ParseTableIdentifierBatchResponse,
    parse_table_identifier_response,
)
from ktx_daemon.telemetry import track_telemetry_event

logger = logging.getLogger(__name__)


class NumpyORJSONResponse(Response):
    media_type = "application/json"

    def render(self, content: Any) -> bytes:
        return dumps_numpy_json(content)


def create_app(
    *,
    embedding_provider: EmbeddingProvider | None = None,
    database_introspector: Callable[
        [DatabaseIntrospectionRequest], DatabaseIntrospectionResponse
    ]
    | None = None,
    enable_code_execution: bool = False,
    telemetry_started_at: float | None = None,
    clock: Callable[[], float] = time.perf_counter,
) -> FastAPI:
    started_at = telemetry_started_at or clock()

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        track_telemetry_event(
            "daemon_started",
            {
                "daemonVersion": os.environ.get("KTX_DAEMON_VERSION", VERSION),
                "pythonVersion": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                "runtimeVersion": VERSION,
                "startupDurationMs": max(0, (clock() - started_at) * 1000),
            },
        )
        try:
            yield
        finally:
            track_telemetry_event(
                "daemon_stopped",
                {
                    "reason": "request",
                    "uptimeMs": max(0, (clock() - started_at) * 1000),
                },
            )

    app = FastAPI(
        title="KTX Daemon",
        description="Stateless portable compute server for KTX.",
        version=VERSION,
        lifespan=lifespan,
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        response = {"status": "healthy"}
        version = os.environ.get("KTX_DAEMON_VERSION")
        if version:
            response["version"] = version
        return response

    @app.post("/database/introspect", response_model=DatabaseIntrospectionResponse)
    async def database_introspect(
        request: DatabaseIntrospectionRequest,
    ) -> DatabaseIntrospectionResponse:
        try:
            introspector = database_introspector or introspect_database_response
            return introspector(request)
        except ValueError as error:
            logger.warning("Database introspection rejected: %s", error)
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            logger.exception("Database introspection failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail=f"Database introspection failed: {error}",
            ) from error

    @app.post("/embeddings/compute", response_model=ComputeEmbeddingResponse)
    async def embedding_compute(
        request: ComputeEmbeddingRequest,
    ) -> ComputeEmbeddingResponse:
        try:
            return compute_embedding_response(
                request,
                provider=embedding_provider,
            )
        except ValueError as error:
            logger.warning("Embedding compute rejected: %s", error)
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            logger.exception("Embedding compute failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail=f"Embedding compute failed: {error}",
            ) from error

    @app.post(
        "/embeddings/compute-bulk",
        response_model=ComputeEmbeddingBulkResponse,
    )
    async def embedding_compute_bulk(
        request: ComputeEmbeddingBulkRequest,
    ) -> ComputeEmbeddingBulkResponse:
        try:
            return compute_embedding_bulk_response(
                request,
                provider=embedding_provider,
            )
        except ValueError as error:
            logger.warning("Bulk embedding compute rejected: %s", error)
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            logger.exception("Bulk embedding compute failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail=f"Bulk embedding compute failed: {error}",
            ) from error

    if enable_code_execution:

        @app.post(
            "/code/execute",
            response_model=ExecuteCodeResponse,
            response_class=NumpyORJSONResponse,
        )
        async def code_execute(request: ExecuteCodeRequest) -> ExecuteCodeResponse:
            try:
                return execute_code_response(
                    request,
                    nest_api_url=None,
                    auth_header=None,
                )
            except Exception as error:
                logger.exception("Code execution failed: %s", error)
                raise HTTPException(
                    status_code=500,
                    detail=f"Code execution failed: {error}",
                ) from error

    @app.post("/lookml/parse", response_model=ParseLookMLResponse)
    async def lookml_parse(request: ParseLookMLRequest) -> ParseLookMLResponse:
        try:
            return parse_lookml_project(request)
        except Exception as error:
            logger.exception("LookML parsing failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail=f"LookML parsing failed: {error}",
            ) from error

    @app.post(
        "/sql/parse-table-identifier",
        response_model=ParseTableIdentifierBatchResponse,
    )
    async def sql_parse_table_identifier(
        request: ParseTableIdentifierBatchRequest,
    ) -> ParseTableIdentifierBatchResponse:
        try:
            return parse_table_identifier_response(request)
        except Exception as error:
            logger.exception("Table identifier parsing failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail=f"Table identifier parsing failed: {error}",
            ) from error

    @app.post("/sql/validate-read-only", response_model=ValidateReadOnlySqlResponse)
    async def sql_validate_read_only(
        request: ValidateReadOnlySqlRequest,
    ) -> ValidateReadOnlySqlResponse:
        try:
            return validate_read_only_sql_response(request)
        except Exception as error:
            logger.exception("SQL read-only validation failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail=f"SQL read-only validation failed: {error}",
            ) from error

    @app.post("/sql/analyze-batch", response_model=AnalyzeSqlBatchResponse)
    async def sql_analyze_batch(
        request: AnalyzeSqlBatchRequest,
    ) -> AnalyzeSqlBatchResponse:
        try:
            return analyze_sql_batch_response(request)
        except Exception as error:
            logger.exception("SQL batch analysis failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail=f"SQL batch analysis failed: {error}",
            ) from error

    @app.post(
        "/semantic-layer/generate-sources", response_model=GenerateSourcesResponse
    )
    async def semantic_generate_sources(
        request: GenerateSourcesRequest,
    ) -> GenerateSourcesResponse:
        try:
            return generate_sources_response(request)
        except Exception as error:
            logger.exception("Semantic source generation failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail=f"Semantic source generation failed: {error}",
            ) from error

    @app.post("/semantic-layer/query", response_model=SemanticLayerQueryResponse)
    async def semantic_query(
        request: SemanticLayerQueryRequest,
    ) -> SemanticLayerQueryResponse:
        try:
            return query_semantic_layer(request)
        except ValueError as error:
            logger.warning("Semantic query rejected: %s", error)
            raise HTTPException(status_code=400, detail=str(error)) from error
        except Exception as error:
            logger.exception("Semantic query failed: %s", error)
            raise HTTPException(
                status_code=500,
                detail=f"Semantic layer query failed: {error}",
            ) from error

    @app.post("/semantic-layer/validate", response_model=ValidateSourcesResponse)
    async def semantic_validate(
        request: ValidateSourcesRequest,
    ) -> ValidateSourcesResponse:
        return validate_semantic_layer(request)

    return app
