#!/usr/bin/env bash
# The catalog smoke test for a built image, on two throwaway data roots:
#
# 1. Legacy mode. The image's node generates a fixture library from this
#    checkout's test/fixtures/makeLibrary.ts, `photos migrate` gives each
#    photo its ID in an empty data root, and the watcher's --once run builds
#    every derivative. web then reports legacy mode at /api/ready, lists each
#    photo once at /api/photos in the legacy item shape, serves the WebP each
#    item names, directly and through /_next/image, and answers the same
#    after a restart.
# 2. A published catalog. ci/publish-fixture.ts publishes a small test
#    catalog into a second data root, and web serves it with the first
#    root's library still in place. It 404s each legacy WebP and refuses it
#    at /_next/image, since a live revision closes /assets/photos. It names
#    its revision at /api/ready and /api/photos, serves a set the revision
#    holds from /media with 200, `immutable`, and an ETag of its bytes,
#    answers 304 to that ETag, and 404s a set whose files exist but which no
#    revision holds. After a
#    restart on the same published root, /api/ready answers exactly as before
#    it, naming the same revision, the set still serves, and the legacy WebPs
#    stay closed.
#
#   ci/smoke-catalog.sh <tag>
#
# ghcr.io/keyurgolani/keyurgolani.photography:<tag> must already exist
# locally, since nothing pulls here. ci/publish-fixture.ts runs on this
# machine, so it needs Node and `npm ci`, and the checks need curl and jq.
# web publishes a random port on 127.0.0.1 only.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 <tag>" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

IMAGE=ghcr.io/keyurgolani/keyurgolani.photography:$1
TMP=$(mktemp -d)
LIB=$TMP/library
DATA=$TMP/data
PUBLISHED=$TMP/published
WEB=photography-smoke-catalog-$$
WEB_STARTED=false
BASE_URL=
# The body of /_next/image's 400 for a url images.localPatterns doesn't allow.
NOT_ALLOWED='"url" parameter is not allowed'
# The keys of a legacy /api/photos item, as jq's keys sorts them.
LEGACY_KEYS='["caption","date","height","id","lqip","medium","mediumAvif","optimized","optimizedAvif","optimizedHeight","optimizedWidth","src","thumbnail","thumbnailAvif","width"]'

fail() {
  echo "::error::$1"
  exit 1
}

cleanup() {
  status=$?
  set +e
  if [ "$WEB_STARTED" = true ]; then
    if [ "$status" -ne 0 ]; then
      echo "Smoke test failed. web's logs:"
      docker logs "$WEB"
    fi
    docker rm -f "$WEB" >/dev/null
  fi
  # The containers wrote the library and the first data root as the image's
  # user. Remove everything with the image under test, so cleanup never pulls.
  docker run --rm --pull never --user 0 --entrypoint rm -v "$TMP:/t" "$IMAGE" -rf /t/library /t/data /t/published
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

# Runs a command in the image as its user, with the library and the first
# data root where docker-compose.prod.yml mounts them for image-watcher.
in_image() {
  docker run --rm --pull never -e PHOTOGRAPHY_DATA_DIR=/data/portfolio \
    -v "$LIB:/app/public/assets/photos" -v "$DATA:/data/portfolio" "$IMAGE" "$@"
}

# Points BASE_URL at web's published port and waits for /api/health.
wait_for_web() {
  local address deadline
  address=$(docker port "$WEB" 3000/tcp)
  address=${address%%$'\n'*}
  BASE_URL=http://127.0.0.1:${address##*:}
  deadline=$((SECONDS + 60))
  until [ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$BASE_URL/api/health")" = 200 ]; do
    [ "$SECONDS" -lt "$deadline" ] || fail "web did not answer /api/health within 60s."
    sleep 1
  done
}

# Starts web on library <library> and data root <root>, which it mounts
# read-only, as docker-compose.prod.yml does.
start_web() {
  docker run -d --pull never --name "$WEB" -p 127.0.0.1::3000 -e PHOTOGRAPHY_DATA_DIR=/data/portfolio \
    -v "$1:/app/public/assets/photos" -v "$2:/data/portfolio:ro" "$IMAGE" >/dev/null
  WEB_STARTED=true
  wait_for_web
}

stop_web() {
  docker rm -f "$WEB" >/dev/null
  WEB_STARTED=false
}

# The value of header <name> in $TMP/headers.txt, or nothing.
header() {
  tr -d '\r' <"$TMP/headers.txt" | { grep -i "^$1:" || true; } | head -1 | sed 's/^[^:]*: *//'
}

# Fails unless GET <endpoint> answers <code> with Cache-Control <cache> and a
# JSON body jq <filter> accepts. Any further arguments go to jq first. Leaves
# the body in $TMP/body.json and the headers in $TMP/headers.txt.
expect_json() {
  local endpoint=$1 expected=$2 cache=$3 filter=$4 code
  shift 4
  code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o "$TMP/body.json" -w '%{http_code}' "$BASE_URL$endpoint") ||
    fail "GET $endpoint failed."
  [ "$code" = "$expected" ] || fail "GET $endpoint returned $code, expected $expected: $(cat "$TMP/body.json")"
  [ "$(header cache-control)" = "$cache" ] || fail "GET $endpoint sent Cache-Control: $(header cache-control), expected $cache."
  jq -e "$@" "$filter" "$TMP/body.json" >/dev/null || fail "GET $endpoint returned $(cat "$TMP/body.json"), which fails $filter."
}

# Checks legacy mode, and copies the /api/photos list to <file>.
check_legacy() {
  local src code
  expect_json /api/ready 200 no-store '. == {mode: "legacy", state: "ok", revisionId: null, revisionNumber: null, activatedAt: null}'
  # shellcheck disable=SC2016 # $keys is jq's
  expect_json /api/photos 200 no-cache '
    type == "array"
    and ([.[].src] | sort) == ["/assets/photos/optimized/landscape.webp", "/assets/photos/optimized/portrait.webp", "/assets/photos/optimized/square.webp"]
    and all(.[]; keys == $keys and .width > 0 and .height > 0 and (.lqip | startswith("data:image/")))
    and [.[].id] == [range(length)]' --argjson keys "$LEGACY_KEYS"
  [ "$(header x-catalog-mode)" = legacy ] && [ "$(header x-catalog-revision)" = legacy ] ||
    fail "GET /api/photos sent X-Catalog-Mode '$(header x-catalog-mode)' and X-Catalog-Revision '$(header x-catalog-revision)', expected legacy and legacy."
  cp "$TMP/body.json" "$1"
  # Before the launch the legacy pages load these: each listed WebP serves, never as immutable, and /_next/image optimizes it.
  for src in $(jq -r '.[].src' "$1"); do
    code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$BASE_URL$src") || fail "GET $src failed."
    [ "$code" = 200 ] || fail "GET $src, which /api/photos lists, returned $code, expected 200."
    [ "$(header content-type)" = image/webp ] || fail "GET $src sent Content-Type: $(header content-type)."
    case $(header cache-control) in *immutable*) fail "GET $src sent Cache-Control: $(header cache-control)." ;; esac
    code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$BASE_URL/_next/image?url=$(jq -rn --arg src "$src" '$src | @uri')&w=400&q=75") ||
      fail "GET /_next/image for $src failed."
    [ "$code" = 200 ] || fail "GET /_next/image for $src returned $code, expected 200."
    case $(header content-type) in image/*) ;; *) fail "GET /_next/image for $src sent Content-Type: $(header content-type)." ;; esac
  done
}

# Checks that the WebPs <file> lists, which serve in legacy mode, are closed
# once a revision is live: 404 with nothing cached, and /_next/image's 400.
check_contained() {
  local src code
  for src in $(jq -r '.[].src' "$1"); do
    code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$BASE_URL$src") || fail "GET $src failed."
    [ "$code" = 404 ] || fail "GET $src with a revision live returned $code, expected 404."
    [ "$(header cache-control)" = no-store ] || fail "The 404 for $src sent Cache-Control: $(header cache-control)."
    code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o "$TMP/image-error.txt" -w '%{http_code}' "$BASE_URL/_next/image?url=$(jq -rn --arg src "$src" '$src | @uri')&w=400&q=75") ||
      fail "GET /_next/image for $src failed."
    [ "$code" = 400 ] || fail "GET /_next/image for $src with a revision live returned $code, expected 400."
    [ "$(cat "$TMP/image-error.txt")" = "$NOT_ALLOWED" ] ||
      fail "GET /_next/image for $src answered 400 with '$(cat "$TMP/image-error.txt")', expected '$NOT_ALLOWED'."
    [ "$(header cache-control)" = no-store ] || fail "The 400 for /_next/image of $src sent Cache-Control: $(header cache-control)."
  done
}

# 1. The fixture library, generated by the image under test with this
#    checkout's fixtures mounted read-only, and an empty data root, both
#    writable by the image's user.
mkdir "$LIB" "$DATA"
chmod 777 "$LIB" "$DATA"
docker run --rm --pull never -v "$PWD/test/fixtures:/app/test/fixtures:ro" -v "$LIB:/library" \
  "$IMAGE" node test/fixtures/makeLibrary.ts /library || fail "Generating the fixture library in $IMAGE failed."

# 2. The migration, as docs/data-root.md runs it: a dry run, then its plan.
dry_run=$(in_image node dist/scripts/photos.mjs migrate --dry-run) || fail "The migration dry run failed: $dry_run"
plan=$(sed -n 's/^Plan: //p' <<<"$dry_run")
[ -n "$plan" ] || fail "The dry run printed no plan: $dry_run"
in_image node dist/scripts/photos.mjs migrate --apply --plan "$plan" >/dev/null || fail "Applying $plan failed."

# 3. One watcher pass writes every derivative and builds every set.
in_image node dist/scripts/imageWatcher.mjs --once >"$TMP/once.log" 2>&1 || {
  cat "$TMP/once.log"
  fail "The watcher's --once run failed."
}
in_image node dist/scripts/photos.mjs identity status --json >"$TMP/status.json" || {
  cat "$TMP/status.json"
  fail "photos identity status says the data root isn't ready after the --once run."
}
jq -e '.dataRoot.state == "ready" and .photos.total == 3 and .pendingJobs == 0 and .failedProfiles == []' "$TMP/status.json" >/dev/null ||
  fail "After the --once run, photos identity status reported $(cat "$TMP/status.json")."
echo "The migration gave the 3 fixtures their IDs, and --once built their derivatives and sets."

# 4. Legacy mode lists every photo, and a restart changes nothing.
start_web "$LIB" "$DATA"
check_legacy "$TMP/legacy-before.json"
docker restart "$WEB" >/dev/null
wait_for_web
check_legacy "$TMP/legacy-after.json"
diff -u "$TMP/legacy-before.json" "$TMP/legacy-after.json" || fail "/api/photos changed when web restarted."
stop_web
echo "Legacy mode: /api/ready and /api/photos answered the same before and after a restart, and every listed WebP served, directly and through /_next/image."

# 5. A published test catalog in a second data root. web reads it as the
#    image's user, so make it readable.
npx tsx ci/publish-fixture.ts "$PUBLISHED" >"$TMP/fixture.json" || fail "ci/publish-fixture.ts failed."
chmod -R a+rX "$PUBLISHED"
revision=$(jq -r .revisionId "$TMP/fixture.json")
active=$(jq -r .active "$TMP/fixture.json")
inactive=$(jq -r .inactive "$TMP/fixture.json")
[[ $revision == rev_* && $active == /media/* && $inactive == /media/* ]] || fail "ci/publish-fixture.ts printed $(cat "$TMP/fixture.json")."
start_web "$LIB" "$PUBLISHED"
# shellcheck disable=SC2016 # $revision and $active are jq's
expect_json /api/ready 200 no-store '.mode == "catalog" and .state == "ok" and .revisionId == $revision and .revisionNumber == 1' --arg revision "$revision"
cp "$TMP/body.json" "$TMP/ready-before.json"
# shellcheck disable=SC2016
expect_json /api/photos 200 no-cache 'type == "array" and length == 2 and any(.[]; .medium == $active)' --arg active "$active"
[ "$(header x-catalog-mode)" = catalog ] && [ "$(header x-catalog-revision)" = "$revision" ] ||
  fail "GET /api/photos sent X-Catalog-Mode '$(header x-catalog-mode)' and X-Catalog-Revision '$(header x-catalog-revision)', expected catalog and $revision."
echo "/api/ready and /api/photos name $revision."
check_contained "$TMP/legacy-before.json"
echo "With $revision live, every legacy WebP returned 404, and 400 through /_next/image."

# 6. The set the revision holds: 200, immutable, an ETag of its bytes, and 304 to that ETag.
code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o "$TMP/media" -w '%{http_code}' "$BASE_URL$active") || fail "GET $active failed."
[ "$code" = 200 ] || fail "GET $active returned $code, expected 200."
[ "$(header cache-control)" = 'public, max-age=31536000, immutable' ] || fail "GET $active sent Cache-Control: $(header cache-control)."
[ "$(header content-type)" = image/webp ] || fail "GET $active sent Content-Type: $(header content-type)."
etag=$(header etag)
digest=$(node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$TMP/media")
[ "$etag" = "\"$digest\"" ] || fail "GET $active sent ETag $etag, but its bytes hash to $digest."
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$BASE_URL$active") || fail "The conditional GET of $active failed."
[ "$code" = 304 ] || fail "GET $active with If-None-Match returned $code, expected 304."

# 7. A set whose files exist but which no revision holds gets a 404 nothing caches.
code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$BASE_URL$inactive") || fail "GET $inactive failed."
[ "$code" = 404 ] || fail "GET $inactive returned $code, expected 404."
[ "$(header cache-control)" = no-store ] || fail "The 404 for $inactive sent Cache-Control: $(header cache-control)."
echo "/media served the set $revision holds, with immutable, its ETag, and 304, and 404d a set no revision holds."

# 8. A container restart on the published root. web reads the pointer again
#    and must name the same revision, with the same number and time.
docker restart "$WEB" >/dev/null
wait_for_web
# shellcheck disable=SC2016 # $revision is jq's
expect_json /api/ready 200 no-store '.mode == "catalog" and .state == "ok" and .revisionId == $revision' --arg revision "$revision"
diff -u "$TMP/ready-before.json" "$TMP/body.json" || fail "/api/ready changed when web restarted on the published root."
code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$BASE_URL$active") || fail "GET $active after the restart failed."
[ "$code" = 200 ] || fail "GET $active returned $code after the restart, expected 200."
[ "$(header cache-control)" = 'public, max-age=31536000, immutable' ] || fail "GET $active sent Cache-Control: $(header cache-control) after the restart."
check_contained "$TMP/legacy-before.json"
echo "After a restart on the published root, /api/ready named $revision as before, its set still served, and the legacy WebPs stayed closed."
echo "smoke-catalog passed."
