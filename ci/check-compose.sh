#!/usr/bin/env bash
# Checks that docker-compose.prod.yml runs every service on the one release
# tag in PHOTOGRAPHY_IMAGE_TAG, and that ci/smoke-image.sh starts every
# service Compose starts by default. Compose runs from an empty project
# directory so a local .env can't leak in.
set -euo pipefail

cd "$(dirname "$0")/.."
unset COMPOSE_PROFILES

FILE=docker-compose.prod.yml
IMAGE=ghcr.io/keyurgolani/keyurgolani.photography
# The services ci/smoke-image.sh starts.
SERVICES_FILE=ci/smoke-services
PROJECT_DIR=$(mktemp -d)
trap 'rm -rf "$PROJECT_DIR"' EXIT

# Without --profile, Compose only sees the services that start by default.
compose_default() {
  docker compose -f "$FILE" --project-directory "$PROJECT_DIR" "$@"
}

compose() {
  compose_default --profile '*' "$@"
}

fail() {
  echo "::error file=$FILE::$1"
  exit 1
}

# 1. Before interpolation, every image line is exactly
#    $IMAGE:${PHOTOGRAPHY_IMAGE_TAG:?<message>}, so a nested default such as
#    ${OTHER:-${PHOTOGRAPHY_IMAGE_TAG:?...}} can't slip through.
if ! raw=$(compose config --no-interpolate --format json); then
  fail "docker compose config --no-interpolate failed."
fi
if ! jq -e --arg prefix "$IMAGE:\${PHOTOGRAPHY_IMAGE_TAG:?" '
    [.services[].image] | length > 0 and all(
      type == "string" and startswith($prefix) and endswith("}")
      and (.[($prefix | length):-1] | test("[$}]") | not))' <<<"$raw" >/dev/null; then
  fail "Every service must use image $IMAGE:\${PHOTOGRAPHY_IMAGE_TAG:?<message>}, with nothing nested in or around the variable."
fi
echo "Every image line is $IMAGE:\${PHOTOGRAPHY_IMAGE_TAG:?...}."

# 2. Every service, including ones behind a profile, runs the tag that
#    PHOTOGRAPHY_IMAGE_TAG names.
if ! PHOTOGRAPHY_IMAGE_TAG=v9.9.9 compose config --format json \
  | jq -e --arg image "$IMAGE:v9.9.9" '[.services[].image] | unique == [$image]' >/dev/null; then
  fail "Every service must use image $IMAGE:\${PHOTOGRAPHY_IMAGE_TAG}."
fi
echo "Every service runs $IMAGE:\${PHOTOGRAPHY_IMAGE_TAG}."

# 3. Without PHOTOGRAPHY_IMAGE_TAG, Compose refuses the file because of it,
#    instead of falling back to a default tag.
if reason=$(unset PHOTOGRAPHY_IMAGE_TAG; compose config 2>&1 >/dev/null); then
  fail "docker compose config passed with PHOTOGRAPHY_IMAGE_TAG unset. Use \${PHOTOGRAPHY_IMAGE_TAG:?...} with no default."
fi
case $reason in
  *PHOTOGRAPHY_IMAGE_TAG*) ;;
  *)
    echo "$reason"
    fail "docker compose config failed with PHOTOGRAPHY_IMAGE_TAG unset, but its error doesn't name PHOTOGRAPHY_IMAGE_TAG."
    ;;
esac
echo "Unset PHOTOGRAPHY_IMAGE_TAG is refused: $reason"

# 4. Nothing pulls a moving tag.
if grep -n ':latest' "$FILE"; then
  fail "$FILE must not reference :latest."
fi
echo "$FILE has no :latest."

# 5. ci/smoke-image.sh starts exactly the services Compose starts by default,
#    since both read the list from ci/smoke-services.
if ! services=$(PHOTOGRAPHY_IMAGE_TAG=v9.9.9 compose_default config --services); then
  fail "docker compose config --services failed."
fi
services=$(LC_ALL=C sort <<<"$services" | tr '\n' ' ')
services=${services% }
if ! smoke=$(awk '{ sub(/#.*/, ""); for (i = 1; i <= NF; i++) print $i }' "$SERVICES_FILE"); then
  fail "Could not read $SERVICES_FILE."
fi
smoke=$(LC_ALL=C sort <<<"$smoke" | tr '\n' ' ')
smoke=${smoke% }
if [ "$services" != "$smoke" ]; then
  fail "$FILE starts '$services' by default, but $SERVICES_FILE lists '$smoke'. A PR that adds a service lists it in $SERVICES_FILE and extends ci/smoke-image.sh to check it."
fi
echo "ci/smoke-image.sh starts every default service: $services."
