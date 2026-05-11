#!/bin/sh
set -eu

echo "Installing KTX Python dependencies..."
uv sync --all-packages --all-groups
