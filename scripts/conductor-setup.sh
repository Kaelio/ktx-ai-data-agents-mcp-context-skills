#!/bin/bash
# conductor-setup.sh - Runs once when Conductor creates a KTX workspace.
#
# Orchestrates workspace setup. Step implementation lives in scripts/conductor/.

set -e
set -o pipefail

echo "=== Conductor KTX workspace setup ==="

sh scripts/conductor/link-agent-overlays.sh
sh scripts/conductor/link-root-env-file.sh
source scripts/conductor/activate-workspace-uv.sh
sh scripts/conductor/install-python-dependencies.sh
sh scripts/conductor/install-js-dependencies.sh
sh scripts/conductor/rebuild-native-dependencies.sh
sh scripts/conductor/build-workspace.sh
sh scripts/conductor/run-setup-doctor.sh

echo "=== Setup complete ==="
