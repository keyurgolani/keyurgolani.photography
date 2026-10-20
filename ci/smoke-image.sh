#!/usr/bin/env bash
# Runs docker-compose.prod.yml against a locally built image in a throwaway
# project directory, then checks that web serves the site and the watcher
# writes every derivative for each fixture in ci/fixtures/library.
#
#   ci/smoke-image.sh <tag>
#
# ghcr.io/keyurgolani/keyurgolani.photography:<tag> must already exist
# locally, since Compose never pulls here. Binds host port 3000.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 <tag>" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
ROOT=$PWD
export PHOTOGRAPHY_IMAGE_TAG=$1

BASE_URL=http://127.0.0.1:3000
OUTPUT_TIMEOUT=120
TMP=$(mktemp -d)
PHOTOS=$TMP/public/assets/photos

compose() {
  docker compose -f "$ROOT/docker-compose.prod.yml" --project-directory "$TMP" -p photography-smoke "$@"
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
  # The containers create the derivative folders as uid 1001.
  docker run --rm -v "$TMP:/t" alpine rm -rf /t/public /t/.next-images-cache
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

# 1. A throwaway library. Both containers run as uid 1001.
mkdir -p "$PHOTOS" "$TMP/.next-images-cache"
cp ci/fixtures/library/*.jpg "$PHOTOS/"
chmod -R a+rwX "$PHOTOS" "$TMP/.next-images-cache"

# 2. The watcher starts once the web healthcheck passes. Naming the services
#    keeps any later ones out until their own smoke covers them.
compose up -d --pull never --wait --wait-timeout 180 web image-watcher

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

# 5. The watcher writes all seven derivatives, non-empty, for every fixture.
#    Its exit code says nothing about per-file errors, so check the files.
missing_outputs() {
  local fixture base output
  for fixture in ci/fixtures/library/*.jpg; do
    base=$(basename "$fixture" .jpg)
    for output in \
      "thumbnails/$base.webp" "medium/$base.webp" "optimized/$base.webp" \
      "thumbnails-avif/$base.avif" "medium-avif/$base.avif" "optimized-avif/$base.avif" \
      "lqip/$base.txt"; do
      [ -s "$PHOTOS/$output" ] || echo "$output"
    done
  done
}

deadline=$((SECONDS + OUTPUT_TIMEOUT))
while missing=$(missing_outputs) && [ -n "$missing" ]; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "Still missing after ${OUTPUT_TIMEOUT}s:"
    echo "$missing"
    fail "The watcher did not write every derivative."
  fi
  sleep 2
done
echo "The watcher wrote all seven derivatives for each fixture."
