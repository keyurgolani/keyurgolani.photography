#!/usr/bin/env bash
# Checks that docker-compose.prod.yml runs every service on the one release
# tag in PHOTOGRAPHY_IMAGE_TAG. Compose runs from an empty project directory
# so a local .env can't leak in.
set -euo pipefail

cd "$(dirname "$0")/.."

FILE=docker-compose.prod.yml
IMAGE=ghcr.io/keyurgolani/keyurgolani.photography
PROJECT_DIR=$(mktemp -d)
trap 'rm -rf "$PROJECT_DIR"' EXIT

compose() {
  docker compose --profile '*' -f "$FILE" --project-directory "$PROJECT_DIR" "$@"
}

fail() {
  echo "::error file=$FILE::$1"
  exit 1
}

# 1. Every service, including ones behind a profile, runs the tag that
#    PHOTOGRAPHY_IMAGE_TAG names.
if ! PHOTOGRAPHY_IMAGE_TAG=v9.9.9 compose config --format json \
  | jq -e --arg image "$IMAGE:v9.9.9" '[.services[].image] | unique == [$image]' >/dev/null; then
  fail "Every service must use image $IMAGE:\${PHOTOGRAPHY_IMAGE_TAG}."
fi
echo "Every service runs $IMAGE:\${PHOTOGRAPHY_IMAGE_TAG}."

# 2. Without PHOTOGRAPHY_IMAGE_TAG, Compose refuses the file instead of
#    falling back to a default tag.
if reason=$(unset PHOTOGRAPHY_IMAGE_TAG; compose config 2>&1 >/dev/null); then
  fail "docker compose config passed with PHOTOGRAPHY_IMAGE_TAG unset. Use \${PHOTOGRAPHY_IMAGE_TAG:?...} with no default."
fi
echo "Unset PHOTOGRAPHY_IMAGE_TAG is refused: $reason"

# 3. Nothing pulls a moving tag.
if grep -n ':latest' "$FILE"; then
  fail "$FILE must not reference :latest."
fi
echo "$FILE has no :latest."
