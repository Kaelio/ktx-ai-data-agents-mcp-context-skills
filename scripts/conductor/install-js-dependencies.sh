#!/bin/sh
set -eu

echo "Installing KTX JS dependencies..."
pnpm install --frozen-lockfile --prefer-offline
