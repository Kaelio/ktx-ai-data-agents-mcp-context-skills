#!/bin/sh
set -eu

if [ -z "${KAELIO_SKILLS_ROOT:-}" ]; then
  exit 0
fi

agents_source="${KAELIO_SKILLS_ROOT}/.agents"

if [ ! -d "${agents_source}" ]; then
  exit 0
fi

if [ -L .agents ]; then
  exit 0
fi

if [ -e .agents ]; then
  echo "Skipping .agents symlink because .agents already exists and is not a symlink." >&2
  exit 0
fi

ln -s "${agents_source}" .agents
