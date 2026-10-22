#!/usr/bin/env bash
# Runs docker-compose.prod.yml against a locally built image in a throwaway
# project directory, then checks that web serves the site and the watcher
# writes every derivative, for the photos it starts with in
# ci/fixtures/library and for one added while it runs.
#
#   ci/smoke-image.sh <tag>
#
# ghcr.io/keyurgolani/keyurgolani.photography:<tag> must already exist
# locally, since nothing pulls here. web publishes on 127.0.0.1 port 3000
# only, through an override whose !override tag needs Docker Compose 2.24.4 or
# later; that's the one change to docker-compose.prod.yml here.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 <tag>" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
ROOT=$PWD
export PHOTOGRAPHY_IMAGE_TAG=$1

IMAGE=ghcr.io/keyurgolani/keyurgolani.photography:$PHOTOGRAPHY_IMAGE_TAG
# The services to start. ci/check-compose.sh holds the Compose file to the
# same list.
SERVICES_FILE=ci/smoke-services
BASE_URL=http://127.0.0.1:3000
OUTPUT_TIMEOUT=120
# One Compose project per run, so concurrent runs never share containers.
PROJECT=photography-smoke-$$
TMP=$(mktemp -d)
PHOTOS=$TMP/public/assets/photos
OVERRIDE=$TMP/smoke.override.yml
cat >"$OVERRIDE" <<'YAML'
services:
  web:
    ports: !override
      - "127.0.0.1:3000:3000"
YAML

compose() {
  docker compose -f "$ROOT/docker-compose.prod.yml" -f "$OVERRIDE" --project-directory "$TMP" -p "$PROJECT" "$@"
}

fail() {
  echo "::error::$1"
  exit 1
}

cleanup() {
  status=$?
  set +e
  if [ "$status" -ne 0 ]; then
    echo "Smoke test failed. Container logs:"
    compose logs --no-color
  fi
  compose down --remove-orphans
  # The containers create the derivative folders as uid 1001. Remove them
  # with the image under test, so cleanup never pulls anything.
  docker run --rm --pull never --user 0 --entrypoint rm -v "$TMP:/t" "$IMAGE" -rf /t/public /t/.next-images-cache
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

# Prints the derivatives still missing for each photo name given.
missing_outputs() {
  local base output
  for base in "$@"; do
    for output in \
      "thumbnails/$base.webp" "medium/$base.webp" "optimized/$base.webp" \
      "thumbnails-avif/$base.avif" "medium-avif/$base.avif" "optimized-avif/$base.avif" \
      "lqip/$base.txt"; do
      [ -s "$PHOTOS/$output" ] || echo "$output"
    done
  done
}

# Waits up to OUTPUT_TIMEOUT seconds for all seven derivatives of each name.
# The watcher's exit code says nothing about per-file errors, so check files.
wait_for_outputs() {
  local deadline missing
  deadline=$((SECONDS + OUTPUT_TIMEOUT))
  while missing=$(missing_outputs "$@") && [ -n "$missing" ]; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "Still missing after ${OUTPUT_TIMEOUT}s:"
      echo "$missing"
      fail "The watcher did not write every derivative for: $*."
    fi
    sleep 2
  done
}

# A crash would hide behind restart: always, so require zero restarts.
require_watcher_running() {
  local watcher state
  watcher=$(compose ps -q image-watcher)
  [ -n "$watcher" ] || fail "There is no image-watcher container."
  state=$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$watcher")
  [ "$state" = "running 0" ] || fail "image-watcher is '$state' (status, restarts), expected 'running 0'."
}

# 1. A throwaway library. Both containers run as uid 1001.
mkdir -p "$PHOTOS" "$TMP/.next-images-cache"
cp ci/fixtures/library/*.jpg "$PHOTOS/"
chmod -R a+rwX "$PHOTOS" "$TMP/.next-images-cache"
fixtures=()
for fixture in ci/fixtures/library/*.jpg; do
  fixtures+=("$(basename "$fixture" .jpg)")
done

# 2. Start the services in ci/smoke-services. The watcher starts once the web
#    healthcheck passes.
[ -f "$SERVICES_FILE" ] || fail "$SERVICES_FILE is missing."
services=()
while read -r service; do
  services+=("$service")
done < <(awk '{ sub(/#.*/, ""); for (i = 1; i <= NF; i++) print $i }' "$SERVICES_FILE")
[ "${#services[@]}" -gt 0 ] || fail "$SERVICES_FILE lists no services."
compose up -d --pull never --wait --wait-timeout 180 "${services[@]}"

# 3. The home page is HTML with a <title>. Its content renders client-side,
#    so assert nothing more.
home=$(curl -sS --max-time 30 -o "$TMP/home.html" -w '%{http_code} %{content_type}' "$BASE_URL/") ||
  fail "GET / failed."
code=${home%% *}
content_type=${home#* }
[ "$code" = 200 ] || fail "GET / returned $code, expected 200."
case $content_type in
  text/html*) ;;
  *) fail "GET / returned content-type '$content_type', expected text/html." ;;
esac
grep -q '<title>' "$TMP/home.html" || fail "GET / has no <title>."
echo "GET / returned HTML with a <title>."

# 4. /api/photos returns a JSON array. It is prerendered with revalidate = 60,
#    so the first responses can be the empty build-time list.
code=$(curl -sS --max-time 30 -o "$TMP/photos.json" -w '%{http_code}' "$BASE_URL/api/photos") ||
  fail "GET /api/photos failed."
[ "$code" = 200 ] || fail "GET /api/photos returned $code, expected 200."
jq -e 'type == "array"' "$TMP/photos.json" >/dev/null || fail "GET /api/photos did not return a JSON array."
echo "GET /api/photos returned a JSON array."

# 5. The startup scan writes all seven derivatives for every fixture, and the
#    watcher stays up.
wait_for_outputs "${fixtures[@]}"
require_watcher_running
echo "The watcher wrote all seven derivatives for: ${fixtures[*]}."

# 6. Watch mode picks up a photo added while it runs.
cp "ci/fixtures/library/${fixtures[0]}.jpg" "$PHOTOS/ci-added.jpg"
wait_for_outputs ci-added
require_watcher_running
echo "The watcher picked up ci-added.jpg and wrote all seven derivatives without restarting."
