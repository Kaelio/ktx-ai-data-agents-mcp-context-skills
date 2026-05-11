#!/bin/bash
# conductor-setup.sh - Runs once when Conductor creates a KTX workspace.
#
# Prepares the standalone pnpm + uv workspace and builds the local CLI.

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

link_agent_overlays() {
  if [ -z "${KTX_AGENT_OVERLAYS_ROOT:-}" ] || [ ! -d "${KTX_AGENT_OVERLAYS_ROOT}/.agents" ]; then
    return 0
  fi

  if [ -L .agents ]; then
    return 0
  fi

  if [ -e .agents ]; then
    echo "Skipping .agents symlink because .agents already exists and is not a symlink." >&2
    return 0
  fi

  ln -s "${KTX_AGENT_OVERLAYS_ROOT}/.agents" .agents
}

# Expose .agents/skills/* to Claude Code by symlinking each entry under
# .claude/skills/. Codex CLI reads .agents/skills/ directly; Claude Code only
# scans .claude/skills/, so the overlay needs both sides to be visible to both
# tools.
link_agent_skills_for_claude() {
  if [ ! -d .agents/skills ]; then
    return 0
  fi

  mkdir -p .claude/skills

  for skill_path in .agents/skills/*; do
    [ -e "$skill_path" ] || continue

    local skill_name
    skill_name="$(basename "$skill_path")"
    local link_path=".claude/skills/$skill_name"
    local target="../../.agents/skills/$skill_name"

    if [ -L "$link_path" ]; then
      if [ "$(readlink "$link_path")" = "$target" ]; then
        continue
      fi
      echo "Skipping $link_path: existing symlink points elsewhere." >&2
      continue
    fi

    if [ -e "$link_path" ]; then
      echo "Skipping $link_path: already exists and is not a symlink." >&2
      continue
    fi

    ln -s "$target" "$link_path"
  done
}

echo "=== Conductor KTX workspace setup ==="

link_agent_overlays
link_agent_skills_for_claude

if [ -n "${CONDUCTOR_ROOT_PATH:-}" ] && [ -f "$CONDUCTOR_ROOT_PATH/.env" ]; then
  ln -sf "$CONDUCTOR_ROOT_PATH/.env" .env
  echo "Linked .env"
fi

KTX_UV_BIN="$(resolve_uv_for_project "pyproject.toml")"
export PATH="$(dirname "$KTX_UV_BIN"):$PATH"

echo "Installing KTX Python dependencies..."
uv sync --all-packages --all-groups

echo "Installing KTX JS dependencies..."
pnpm install --frozen-lockfile --prefer-offline

echo "Rebuilding native JS dependencies..."
pnpm run native:rebuild

echo "Building KTX packages..."
pnpm run build

echo "Running KTX setup doctor..."
node packages/cli/dist/bin.js dev doctor setup --no-input

echo "=== Setup complete ==="
