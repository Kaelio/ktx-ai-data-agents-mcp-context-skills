#!/bin/bash
set -e
set -o pipefail

KTX_UV_BIN="$(bash scripts/conductor/resolve-uv.sh pyproject.toml)"
export PATH="$(dirname "$KTX_UV_BIN"):$PATH"
