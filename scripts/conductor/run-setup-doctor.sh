#!/bin/sh
set -eu

echo "Running KTX setup doctor..."
node packages/cli/dist/bin.js dev doctor setup --no-input
