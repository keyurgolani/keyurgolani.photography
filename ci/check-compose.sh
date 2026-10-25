#!/usr/bin/env bash
# Checks that docker-compose.prod.yml runs every service on the one release
# tag in PHOTOGRAPHY_IMAGE_TAG, that ci/smoke-image.sh starts every service
# Compose starts by default, that every published port is on the host's
# loopback, and that the data root and the library mounts keep their
# guarantees. Compose runs from an empty project directory so a local .env
# can't leak in.
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

# The resolved file the last checks read, with every profile.
if ! resolved=$(PHOTOGRAPHY_IMAGE_TAG=v9.9.9 compose config --format json); then
  fail "docker compose config failed."
fi

# 6. Every published port is on the host's 127.0.0.1, whatever
#    PHOTOGRAPHY_PORT says. A reverse proxy or tunnel on the host serves it.
for port in '' 3456; do
  if ! ports=$(PHOTOGRAPHY_IMAGE_TAG=v9.9.9 PHOTOGRAPHY_PORT=$port compose config --format json); then
    fail "docker compose config failed with PHOTOGRAPHY_PORT='$port'."
  fi
  if ! jq -e '[.services[] | (.ports // [])[]] | all(type == "object" and .host_ip == "127.0.0.1")' <<<"$ports" >/dev/null; then
    fail "Every ports: entry must publish on 127.0.0.1, as \"127.0.0.1:\${PHOTOGRAPHY_PORT:-3000}:3000\"."
  fi
done
if ! jq -e '.services.web.ports | length > 0' <<<"$resolved" >/dev/null; then
  fail "web must publish its port on 127.0.0.1."
fi
# A service on the host's network has no ports: to check, and web listens on
# every interface inside its container.
if ! jq -e 'all(.services[]; (.network_mode // "") != "host")' <<<"$resolved" >/dev/null; then
  fail "No service may use network_mode: host, since it would bypass the 127.0.0.1 publish."
fi
echo "Every published port is on 127.0.0.1, and no service shares the host's network."

# 7. web mounts the data root read-only, and no bind of the data root or the
#    library is ever created when its source is missing. How Compose writes
#    create_host_path: false in its output differs between versions, so
#    compare against a probe file holding one long-syntax bind with it and
#    one short-syntax bind, which Compose creates when missing.
PROBE="$PROJECT_DIR/probe.yml"
cat >"$PROBE" <<'YAML'
services:
  probe:
    image: probe
    volumes:
      - type: bind
        source: ./kept
        target: /kept
        bind:
          create_host_path: false
      - ./created:/created
YAML
if ! probe=$(docker compose -f "$PROBE" --project-directory "$PROJECT_DIR" config --format json); then
  fail "docker compose config failed on the create_host_path probe."
fi
never_created=$(jq -c '.services.probe.volumes[] | select(.target == "/kept") | .bind.create_host_path' <<<"$probe")
short_syntax=$(jq -c '.services.probe.volumes[] | select(.target == "/created") | .bind.create_host_path' <<<"$probe")
if [ "$never_created" = "$short_syntax" ]; then
  fail "This Compose writes create_host_path the same way for a long-syntax bind with false and a short-syntax bind ($never_created), so the check can't tell them apart."
fi
# A data root mount is one at /data/portfolio, however its target is spelled,
# or one of ./portfolio-data wherever it lands, so a second read-write bind of
# the same folder can't slip past.
DATA_ROOT_MOUNT='((.target // "") | rtrimstr("/")) == "/data/portfolio" or ((.source // "") | rtrimstr("/") | endswith("/portfolio-data"))'
if ! jq -e "[.services.web.volumes[]? | select($DATA_ROOT_MOUNT)]
    | length == 1 and all(.type == \"bind\" and .target == \"/data/portfolio\" and .read_only == true)" <<<"$resolved" >/dev/null; then
  fail "web must mount the data root once, at /data/portfolio, as a bind with read_only: true."
fi
if ! jq -e '.services.web.environment.PHOTOGRAPHY_DATA_DIR == "/data/portfolio"' <<<"$resolved" >/dev/null; then
  fail "web must set PHOTOGRAPHY_DATA_DIR=/data/portfolio, the read-only mount."
fi
if ! jq -e --argjson never "$never_created" "
    [.services[] | (.volumes // [])[] | select(($DATA_ROOT_MOUNT) or ((.target // \"\") | rtrimstr(\"/\")) == \"/app/public/assets/photos\")]
    | length > 0 and all(.type == \"bind\" and .bind.create_host_path == \$never)" <<<"$resolved" >/dev/null; then
  fail "Every mount of the data root or /app/public/assets/photos must be a long-syntax bind with bind.create_host_path: false."
fi
echo "web mounts the data root read-only, and no data root or library bind is created when missing."
