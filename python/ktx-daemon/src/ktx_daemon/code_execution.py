"""Portable in-process code execution helpers for ktx daemon.

This module preserves the host application's current Python execution behavior.
It runs code with Python ``exec`` in the current process and does not provide
OS-level sandboxing.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from collections.abc import Callable
from io import BytesIO, StringIO
from typing import Any

import numpy as np
import orjson
import pandas as pd
import requests
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

VALID_VISUALIZATION_TYPES = ["pie", "bar", "line", "area", "table", "boxplot"]


class ExecuteCodeRequest(BaseModel):
    """Request schema for executing Python code."""

    code: str = Field(..., description="Python code to execute")
    source_id: str | None = Field(
        None,
        description="Chat/dashboard ID for scratchpad file access",
    )
    message_id: str | None = Field(
        None,
        description="Message ID for visualization association",
    )


class VisualizationSpec(BaseModel):
    """Specification for a visualization to be saved by the host application."""

    type: str = Field(..., description="Type marker, always 'visualization'")
    vis_type: str = Field(
        ...,
        description="Visualization type: pie, bar, line, area, table",
    )
    config: dict[str, Any] = Field(
        ...,
        description="Visualization configuration",
    )
    data: list[dict[str, Any]] = Field(
        ...,
        description="Visualization data",
    )
    title: str | None = Field(None, description="Optional title")


class ExecuteCodeResponse(BaseModel):
    """Response schema for code execution."""

    formatted_result: str = Field(
        ...,
        description="Formatted execution result for display",
    )
    result: Any | None = Field(
        None,
        description="The value of the 'result' variable if set",
    )
    console_output: str | None = Field(
        None,
        description="Captured stdout from print statements",
    )
    error: str | None = Field(None, description="Error message if execution failed")
    message: str | None = Field(
        None,
        description="Message if no clear result was returned",
    )
    visualizations: list[VisualizationSpec] | None = Field(
        None,
        description="List of visualizations detected in the result",
    )


ScratchpadHelpers = tuple[
    Callable[[pd.DataFrame, str | None], str],
    Callable[[str], pd.DataFrame],
    Callable[[str, dict[str, Any], list[dict[str, Any]]], str],
]


def dumps_numpy_json(content: Any) -> bytes:
    """Serialize JSON response content with numpy scalar and array support."""

    return orjson.dumps(content, option=orjson.OPT_SERIALIZE_NUMPY)


def _strip_ansi_sequences(text: str) -> str:
    ansi_escape = re.compile(
        r"\x1b\[[0-9;]*[a-zA-Z]|\x1b\([0-9;]*[a-zA-Z]|\x1b\[[0-9;]*~"
    )
    return ansi_escape.sub("", text)


def create_scratchpad_helpers(
    nest_api_url: str | None,
    auth_header: str | None,
    source_id: str | None,
    message_id: str | None = None,
    http_client: Any = requests,
) -> ScratchpadHelpers:
    """Create scratchpad and visualization helpers that call host app APIs."""

    def save_df_to_scratchpad(df: pd.DataFrame, filename: str | None = None) -> str:
        if not nest_api_url or not auth_header or not source_id:
            raise ValueError(
                "nest_api_url, Authorization header, and source_id are required "
                "for scratchpad operations"
            )

        data_json = df.to_dict(orient="records")
        url = f"{nest_api_url}/private_api/scratchpad/{source_id}/files"
        response = http_client.post(
            url,
            data=dumps_numpy_json(
                {"filename": filename, "data": data_json, "format": "json"}
            ),
            headers={"Authorization": auth_header, "Content-Type": "application/json"},
            timeout=30,
        )
        response.raise_for_status()

        saved_filename = response.json()["filename"]
        rows, _cols = df.shape
        return f"{rows} rows saved to {saved_filename}"

    def read_scratchpad_file(filename: str) -> pd.DataFrame:
        if not nest_api_url or not auth_header or not source_id:
            raise ValueError(
                "nest_api_url, Authorization header, and source_id are required "
                "for scratchpad operations"
            )

        url = f"{nest_api_url}/private_api/scratchpad/{source_id}/files/{filename}?format=raw"
        response = http_client.get(
            url,
            headers={"Authorization": auth_header, "Accept": "text/csv"},
            timeout=30,
        )
        response.raise_for_status()

        content_type = response.headers.get("content-type", "")
        if "text/csv" in content_type:
            return pd.read_csv(BytesIO(response.content))

        data = response.json()["data"]
        return pd.DataFrame(data)

    def save_visualization(
        vis_type: str,
        config: dict[str, Any],
        data: list[dict[str, Any]],
    ) -> str:
        if not nest_api_url or not auth_header or not source_id:
            raise ValueError(
                "nest_api_url, Authorization header, and source_id are required "
                "for visualization operations"
            )

        if not message_id:
            raise ValueError("message_id is required for visualization operations")

        if vis_type not in VALID_VISUALIZATION_TYPES:
            raise ValueError(
                f"Invalid visualization type: {vis_type}. Must be one of {VALID_VISUALIZATION_TYPES}"
            )

        url = f"{nest_api_url}/private_api/visualizations/{source_id}"
        payload = {
            "visualizationType": vis_type,
            "config": config,
            "data": data,
            "messageId": message_id,
        }

        response = http_client.post(
            url,
            data=dumps_numpy_json(payload),
            headers={"Authorization": auth_header, "Content-Type": "application/json"},
            timeout=30,
        )
        response.raise_for_status()

        filename = response.json()["filename"]
        print(f"Visualization saved: {filename}")
        return f"![viz]({filename})"

    return save_df_to_scratchpad, read_scratchpad_file, save_visualization


def detect_visualizations(result: Any) -> list[dict[str, Any]]:
    """Detect visualization specs in a code execution result value."""

    visualizations = []

    if isinstance(result, dict) and result.get("type") == "visualization":
        visualizations.append(result)
    elif isinstance(result, list):
        for item in result:
            if isinstance(item, dict) and item.get("type") == "visualization":
                visualizations.append(item)

    return visualizations


def execute_code(
    code: str,
    nest_api_url: str | None = None,
    auth_header: str | None = None,
    source_id: str | None = None,
    message_id: str | None = None,
    scratchpad_helpers: ScratchpadHelpers | None = None,
) -> dict[str, Any]:
    """Execute Python code with the current in-process execution boundary."""

    logger.info("Starting code execution")
    save_df, read_file, save_viz = scratchpad_helpers or create_scratchpad_helpers(
        nest_api_url,
        auth_header,
        source_id,
        message_id,
    )

    namespace = {
        "pd": pd,
        "np": np,
        "json": json,
        "requests": requests,
        "save_df_to_scratchpad": save_df,
        "read_scratchpad_file": read_file,
        "save_visualization": save_viz,
    }

    stdout_capture = StringIO()
    original_stdout = sys.stdout
    sys.stdout = stdout_capture
    console_output = ""

    try:
        logger.info("Executing code in current process namespace")
        exec(code, namespace)

        console_output = stdout_capture.getvalue()
        if "result" in namespace:
            logger.info("Code execution complete, 'result' variable found")
            result_value = namespace["result"]
            visualizations = detect_visualizations(result_value)

            result = {"result": result_value}
            if console_output:
                result["console_output"] = console_output
            if visualizations:
                result["visualizations"] = visualizations

            return result

        logger.info("No result variable found")
        result = {
            "message": "Code executed successfully but no result variable was set"
        }
        if console_output:
            result["console_output"] = console_output
        return result

    except Exception as error:
        logger.exception("Error executing code: %s", error)
        result = {"error": str(error)}
        if console_output:
            result["console_output"] = console_output
        return result

    finally:
        sys.stdout = original_stdout


def format_execution_result(result: dict[str, Any]) -> str:
    """Format execution output for display in host chat responses."""

    formatted_result = ""
    if "console_output" in result:
        formatted_result += "=== Console Output ===\n\n"
        formatted_result += _strip_ansi_sequences(result["console_output"])

    if "result" in result:
        formatted_result += "\n\n=== Result ===\n\n"
        formatted_result += str(result["result"])
    elif "message" in result:
        formatted_result += "\n\n=== Message ===\n\n"
        formatted_result += result["message"]
    elif "error" in result:
        formatted_result += "\n\n=== Error ===\n\n"
        formatted_result += result["error"]

    return formatted_result


def execute_code_response(
    request: ExecuteCodeRequest,
    *,
    nest_api_url: str | None,
    auth_header: str | None,
) -> ExecuteCodeResponse:
    """Execute a validated request and return the public response model."""

    result = execute_code(
        code=request.code,
        nest_api_url=nest_api_url,
        auth_header=auth_header,
        source_id=request.source_id,
        message_id=request.message_id,
    )

    return ExecuteCodeResponse(
        formatted_result=format_execution_result(result),
        result=result.get("result"),
        console_output=result.get("console_output"),
        error=result.get("error"),
        message=result.get("message"),
        visualizations=result.get("visualizations"),
    )
