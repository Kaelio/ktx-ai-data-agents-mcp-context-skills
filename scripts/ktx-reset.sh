#!/bin/bash
# ktx-reset.sh - Reset a ktx project directory back to its seed state.
#
# Removes everything in <dir> except ktx.yaml and .ktx/, and prunes .ktx/
# down to just .ktx/secrets/. Useful when re-running ingest/setup against
# a known-clean project tree.

set -e
set -o pipefail

if [ -z "$1" ]; then
  echo "usage: ktx-reset <dir>" >&2
  exit 1
fi

dir="${1%/}"
if [ ! -d "$dir" ]; then
  echo "ktx-reset: $dir is not a directory" >&2
  exit 1
fi

find "$dir" -mindepth 1 -maxdepth 1 ! -name ktx.yaml ! -name .ktx -exec rm -rf {} +
if [ -d "$dir/.ktx" ]; then
  find "$dir/.ktx" -mindepth 1 -maxdepth 1 ! -name secrets -exec rm -rf {} +
fi
tree -a "$dir"
