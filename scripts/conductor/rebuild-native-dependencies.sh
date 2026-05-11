#!/bin/sh
set -eu

echo "Rebuilding native JS dependencies..."
pnpm run native:rebuild
