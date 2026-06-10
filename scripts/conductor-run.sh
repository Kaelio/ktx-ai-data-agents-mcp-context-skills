#!/bin/bash
# conductor-run.sh - Starts the long-lived local ktx daemon for Conductor.
#
# Uses a fixed port because Conductor runs this workspace in nonconcurrent mode.

set -e
set -o pipefail

read_required_uv_version() {
  local project_file="$1"

  if [ ! -f "$project_file" ]; then
    return 1
  fi

  sed -nE 's/^[[:space:]]*required-version[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/p' "$project_file" | head -n 1
}

uv_version() {
  local uv_bin="$1"

  "$uv_bin" --version 2>/dev/null | awk '{print $2}'
}

install_workspace_uv() {
  local required_version="$1"
  local install_dir="$PWD/.context/bin/uv-$required_version"

  mkdir -p "$install_dir"

  if [ ! -x "$install_dir/uv" ] || [ "$(uv_version "$install_dir/uv")" != "$required_version" ]; then
    echo "Installing workspace-local uv $required_version..." >&2
    curl -LsSf "https://astral.sh/uv/$required_version/install.sh" |
      env UV_INSTALL_DIR="$install_dir" UV_NO_MODIFY_PATH=1 sh >&2
  fi

  printf '%s\n' "$install_dir/uv"
}

resolve_uv_for_project() {
  local project_file="$1"
  local required_version
  local system_uv
  local system_version
  local workspace_uv

  required_version="$(read_required_uv_version "$project_file" || true)"
  required_version="${required_version#==}"

  if [ -z "$required_version" ]; then
    command -v uv
    return
  fi

  if ! [[ "$required_version" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]]; then
    echo "WARNING: Unsupported uv required-version '$required_version'; using uv from PATH." >&2
    command -v uv
    return
  fi

  if command -v uv >/dev/null 2>&1; then
    system_uv="$(command -v uv)"
    system_version="$(uv_version "$system_uv")"

    if [ "$system_version" = "$required_version" ]; then
      printf '%s\n' "$system_uv"
      return
    fi

    echo "Found uv $system_version at $system_uv; $project_file requires uv $required_version." >&2
  else
    echo "uv is not installed on PATH; $project_file requires uv $required_version." >&2
  fi

  workspace_uv="$(install_workspace_uv "$required_version")"

  if [ "$(uv_version "$workspace_uv")" != "$required_version" ]; then
    echo "ERROR: Expected uv $required_version at $workspace_uv, got $("$workspace_uv" --version 2>&1 || true)." >&2
    return 1
  fi

  printf '%s\n' "$workspace_uv"
}

echo "=== Starting ktx for Conductor ==="

echo "Building ktx packages..."
pnpm run build

KTX_UV_BIN="$(resolve_uv_for_project "pyproject.toml")"
export PATH="$(dirname "$KTX_UV_BIN"):$PATH"

if [ -f ".venv/bin/activate" ]; then
  source .venv/bin/activate
fi

echo "ktx daemon: http://127.0.0.1:8765"
exec uv run ktx-daemon serve-http --host 127.0.0.1 --port 8765
