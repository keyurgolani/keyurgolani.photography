#!/usr/bin/env bash
# The catalog smoke test for a built image, on two throwaway data roots:
#
# 1. Nothing published. The image's node generates a fixture library from
#    this checkout's test/fixtures/makeLibrary.ts, `photos migrate` gives each
#    photo its ID in an empty data root, and the watcher's --once run, with
#    the library read-only at /data/library as docker-compose.prod.yml mounts
#    it, builds every set and writes nothing in the library. web then answers
#    the catalog's unavailable state, the same after a restart: /api/ready
#    and #6's Home records endpoint answer 503 with not-published. Since
#    #13's slice E there is no legacy mode: /api/photos is a 404, /gallery a
#    308 to /work, and each legacy WebP a v1.6 watcher wrote, planted under
#    web's public/ folder, 404s and is refused at /_next/image.
# 2. A published catalog. ci/publish-fixture.ts publishes a small test
#    catalog into a second data root, twice, the second revision only
#    retitling a series, and web serves it with the planted legacy WebPs
#    still in place. It names revision 2 at /api/ready and at the Home
#    records endpoint, still 404s /api/photos and each legacy
#    WebP, serves a set the revision holds from /media with 200,
#    `immutable`, and an ETag of its bytes, answers 304 to that ETag, and
#    404s a set whose files exist but which no revision holds. After a
#    restart on the same published root, /api/ready answers exactly as before
#    it, naming the same revision, the set still serves, and the legacy WebPs
#    stay closed.
# 3. #117's `photos verify`, in the image, on the published root: exit 0 and
#    a status/verify.json that passes the live revision. Then one byte of the
#    served set flipped in place, its size kept, which only the digest check
#    sees: exit 1, naming the file, and a record that fails the revision. The
#    byte goes back, and a third run passes again.
# 4. #15's history and rollback, in the image, on the published root (A11):
#    `photos history --json --revisions` lists both publishes, revision 2
#    live and revision 1 one a rollback can return to, and `photos rollback
#    --to 1 --yes --expect-active <revision 2>` rolls back. The running web
#    names revision 1 at /api/ready with no restart, the same after a
#    restart, and still serves the set, and `photos history --json` lists
#    the rollback as live.
#
#   ci/smoke-catalog.sh <tag>
#
# ghcr.io/keyurgolani/keyurgolani.photography:<tag> must already exist
# locally, since nothing pulls here. ci/publish-fixture.ts runs on this
# machine, so it needs Node and `npm ci`, and the checks need curl and jq.
# web publishes a random port on 127.0.0.1 only. The temp root goes under
# $RUNNER_TEMP, the job's own temp folder in CI, or $TMPDIR elsewhere.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 <tag>" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

IMAGE=ghcr.io/keyurgolani/keyurgolani.photography:$1
TMP=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/photography-smoke-catalog.XXXXXX")
LIB=$TMP/library
# A v1.6 host's legacy WebPs, which web gets under public/, where Next would serve them.
LEGACY=$TMP/legacy
DATA=$TMP/data
PUBLISHED=$TMP/published
WEB=photography-smoke-catalog-$$
WEB_STARTED=false
BASE_URL=
# The body of /_next/image's 400 for a url images.localPatterns doesn't allow.
NOT_ALLOWED='"url" parameter is not allowed'
# The legacy WebPs a v1.6 watcher wrote for makeLibrary.ts's fixtures, which never serve.
LEGACY_WEBPS=(/assets/photos/optimized/landscape.webp /assets/photos/optimized/portrait.webp /assets/photos/optimized/square.webp)
# A revision ID no catalog holds, for the #6 endpoint's `revision`.
NO_REVISION=rev_$(printf '0%.0s' {1..64})

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
  docker run --rm --pull never --user 0 --entrypoint rm -v "$TMP:/t" "$IMAGE" -rf /t/library /t/legacy /t/data /t/published
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

# Runs a command in the image as its user, with the library and the first
# data root where docker-compose.prod.yml mounts them for image-watcher: the
# library read-only at /data/library.
in_image() {
  docker run --rm --pull never -e PHOTOGRAPHY_LIBRARY_DIR=/data/library -e PHOTOGRAPHY_DATA_DIR=/data/portfolio \
    -v "$LIB:/data/library:ro" -v "$DATA:/data/portfolio" "$IMAGE" "$@"
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

# Starts web on data root <root>, which it mounts read-only, as
# docker-compose.prod.yml does, with <legacy> under its public/assets/photos,
# which production's web doesn't mount since v1.7.0: here a legacy file Next
# would serve is on disk, so its 404 proves the refusal.
start_web() {
  docker run -d --pull never --name "$WEB" -p 127.0.0.1::3000 -e PHOTOGRAPHY_DATA_DIR=/data/portfolio \
    -v "$1:/app/public/assets/photos:ro" -v "$2:/data/portfolio:ro" "$IMAGE" >/dev/null
  WEB_STARTED=true
  wait_for_web
}

stop_web() {
  docker rm -f "$WEB" >/dev/null
  WEB_STARTED=false
}

# Runs photos.mjs in the image on the published root with <args>, as this
# machine's user, who owns that root here, so verify can write its record and
# rollback its activation. Production runs them in image-watcher, as uid 1001.
photos_published() {
  docker run --rm --pull never --user "$(id -u):$(id -g)" -e PHOTOGRAPHY_DATA_DIR=/data/portfolio \
    -v "$PUBLISHED:/data/portfolio" "$IMAGE" node dist/scripts/photos.mjs "$@"
}

# Runs photos verify in the image on the published root, with any further arguments.
verify_published() {
  photos_published verify "$@"
}

# The SHA-256 of file <file>.
sha256_of() {
  node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$1"
}

# Flips the first byte of file <file> in place, keeping its size. A second call puts it back.
flip_byte() {
  node -e 'const fs = require("fs"); const fd = fs.openSync(process.argv[1], "r+"); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, 0); b[0] ^= 0xff; fs.writeSync(fd, b, 0, 1, 0); fs.closeSync(fd);' "$1"
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

# Fails unless GET <endpoint> answers <code>. Leaves the headers in $TMP/headers.txt.
expect_code() {
  local endpoint=$1 expected=$2 code
  code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$BASE_URL$endpoint") || fail "GET $endpoint failed."
  [ "$code" = "$expected" ] || fail "GET $endpoint returned $code, expected $expected."
}

# Fails unless #6's Home records endpoint, for the featured photo, serves
# revision <served>, naming it in X-Catalog-Revision, and answers 409
# revision-changed for revision <gone>, so Home follows the live revision.
expect_records_on() {
  local served=$1 gone=$2
  # shellcheck disable=SC2016 # $served and $featured are jq's
  expect_json "/api/catalog/home/series/$featured_series/photos/$featured?revision=$served" 200 no-cache '.revisionId == $served and any(.photos[]; .id == $featured)' --arg served "$served" --arg featured "$featured"
  [ "$(header x-catalog-revision)" = "$served" ] || fail "The #6 Home records endpoint sent X-Catalog-Revision '$(header x-catalog-revision)' for $served, expected $served."
  expect_json "/api/catalog/home/series/$featured_series/photos/$featured?revision=$gone" 409 no-store '. == {reason: "revision-changed"}'
}

# What every server answers, published or not: no /api/photos, /gallery on to
# /work, and each legacy WebP, which is on disk, closed: 404 with nothing
# cached, and /_next/image's 400.
check_closed() {
  local src code
  expect_code /api/photos 404
  # v1.4.0's Home records route, which v1.6.0 removed.
  expect_code "/api/catalog/home/photos/ph_00000000-0000-4000-8000-000000000001?revision=$NO_REVISION" 404
  expect_code /gallery 308
  [ "$(header location)" = /work ] || fail "GET /gallery sent Location: $(header location), expected /work."
  [ "$(header cache-control)" = no-store ] || fail "GET /gallery sent Cache-Control: $(header cache-control), expected no-store."
  for src in "${LEGACY_WEBPS[@]}"; do
    [ -s "$LEGACY${src#/assets/photos}" ] || fail "There is no $src on disk, so its 404 would prove nothing."
    code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$BASE_URL$src") || fail "GET $src failed."
    [ "$code" = 404 ] || fail "GET $src returned $code, expected 404."
    [ "$(header cache-control)" = no-store ] || fail "The 404 for $src sent Cache-Control: $(header cache-control)."
    code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o "$TMP/image-error.txt" -w '%{http_code}' "$BASE_URL/_next/image?url=$(jq -rn --arg src "$src" '$src | @uri')&w=400&q=75") ||
      fail "GET /_next/image for $src failed."
    [ "$code" = 400 ] || fail "GET /_next/image for $src returned $code, expected 400."
    [ "$(cat "$TMP/image-error.txt")" = "$NOT_ALLOWED" ] ||
      fail "GET /_next/image for $src answered 400 with '$(cat "$TMP/image-error.txt")', expected '$NOT_ALLOWED'."
    [ "$(header cache-control)" = no-store ] || fail "The 400 for /_next/image of $src sent Cache-Control: $(header cache-control)."
  done
}

# The unavailable state of a data root with nothing published, at /api/ready
# and at #6's Home records endpoint, for photo <photoId>. Copies /api/ready's body to <file>.
check_unpublished() {
  expect_json /api/ready 503 no-store '. == {mode: "catalog", state: "unavailable", revisionId: null, revisionNumber: null, activatedAt: null, reason: "not-published"}'
  cp "$TMP/body.json" "$2"
  expect_json "/api/catalog/home/series/ser_smoke/photos/$1?revision=$NO_REVISION" 503 no-store '. == {reason: "not-published"}'
  check_closed
}

# 1. The fixture library, generated by the image under test with this
#    checkout's fixtures mounted read-only, and an empty data root, both
#    writable by the image's user. The watcher mounts the library read-only.
mkdir "$LIB" "$DATA"
chmod 777 "$LIB" "$DATA"
docker run --rm --pull never -v "$PWD/test/fixtures:/app/test/fixtures:ro" -v "$LIB:/library" \
  "$IMAGE" node test/fixtures/makeLibrary.ts /library || fail "Generating the fixture library in $IMAGE failed."

# 2. The migration, as docs/data-root.md runs it: a dry run, then its plan.
dry_run=$(in_image node dist/scripts/photos.mjs migrate --dry-run) || fail "The migration dry run failed: $dry_run"
plan=$(sed -n 's/^Plan: //p' <<<"$dry_run")
[ -n "$plan" ] || fail "The dry run printed no plan: $dry_run"
in_image node dist/scripts/photos.mjs migrate --apply --plan "$plan" >/dev/null || fail "Applying $plan failed."

# 3. One watcher pass builds every set, and writes nothing in the library.
find "$LIB" -mindepth 1 -printf '%P %y %s %T@ %m %U:%G %C@\n' | LC_ALL=C sort >"$TMP/library-before.txt"
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
find "$LIB" -mindepth 1 -printf '%P %y %s %T@ %m %U:%G %C@\n' | LC_ALL=C sort >"$TMP/library-after.txt"
diff -u "$TMP/library-before.txt" "$TMP/library-after.txt" || fail "The watcher's --once run changed the library, which it must never write."
in_image cat /data/portfolio/status/watcher.json | jq -e '.legacyDerivatives == false' >/dev/null ||
  fail "The watcher's heartbeat does not say legacyDerivatives: false."
# The legacy WebPs a v1.6 host's library holds, from any bytes, for web's public/ folder.
mkdir -p "$LEGACY/optimized"
for src in "${LEGACY_WEBPS[@]}"; do
  cp "$LIB/square.webp" "$LEGACY${src#/assets/photos}"
done
chmod -R a+rX "$LEGACY"
echo "The migration gave the 3 fixtures their IDs, and --once built their sets and wrote nothing in the library."

# 4. With nothing published, web answers the unavailable state and serves no
#    legacy WebP, and a restart changes nothing.
photo=$(in_image node dist/scripts/photos.mjs list --json | jq -r '.[0].photoId') ||
  fail "photos list --json failed."
[[ $photo == ph_* ]] || fail "photos list --json named no photo ID."
start_web "$LEGACY" "$DATA"
check_unpublished "$photo" "$TMP/unpublished-before.json"
docker restart "$WEB" >/dev/null
wait_for_web
check_unpublished "$photo" "$TMP/unpublished-after.json"
diff -u "$TMP/unpublished-before.json" "$TMP/unpublished-after.json" || fail "/api/ready changed when web restarted."
stop_web
echo "Nothing published: /api/ready and the #6 Home records endpoint answered 503 not-published before and after a restart, /api/photos 404, /gallery 308 to /work, and every legacy WebP 404, and 400 through /_next/image."

# 5. A published test catalog in a second data root. web reads it as the
#    image's user, so make it readable.
npx tsx ci/publish-fixture.ts "$PUBLISHED" >"$TMP/fixture.json" || fail "ci/publish-fixture.ts failed."
chmod -R a+rX "$PUBLISHED"
revision=$(jq -r .revisionId "$TMP/fixture.json")
first=$(jq -r .firstRevisionId "$TMP/fixture.json")
active=$(jq -r .active "$TMP/fixture.json")
inactive=$(jq -r .inactive "$TMP/fixture.json")
featured_series=$(jq -r .featuredSeries "$TMP/fixture.json")
featured=$(jq -r .featured "$TMP/fixture.json")
[[ $revision == rev_* && $first == rev_* && $first != "$revision" && $active == /media/* && $inactive == /media/* && $featured_series == ser_* && $featured == ph_* ]] || fail "ci/publish-fixture.ts printed $(cat "$TMP/fixture.json")."
start_web "$LEGACY" "$PUBLISHED"
# shellcheck disable=SC2016 # $revision and $featured are jq's
expect_json /api/ready 200 no-store '.mode == "catalog" and .state == "ok" and .revisionId == $revision and .revisionNumber == 2' --arg revision "$revision"
cp "$TMP/body.json" "$TMP/ready-before.json"
# shellcheck disable=SC2016
expect_json "/api/catalog/home/series/$featured_series/photos/$featured?revision=$revision" 200 no-cache '.revisionId == $revision and any(.photos[]; .id == $featured)' --arg revision "$revision" --arg featured "$featured"
[ "$(header x-catalog-revision)" = "$revision" ] || fail "The #6 Home records endpoint sent X-Catalog-Revision '$(header x-catalog-revision)', expected $revision."
expect_json "/api/catalog/home/series/$featured_series/photos/$featured?revision=$NO_REVISION" 409 no-store '. == {reason: "revision-changed"}'
expect_json "/api/catalog/home/series/$featured_series/photos/$featured?revision=$first" 409 no-store '. == {reason: "revision-changed"}'
echo "/api/ready and the #6 Home records endpoint name $revision, revision 2."
check_closed
echo "With $revision live, /api/photos returned 404, /gallery 308, and every legacy WebP 404, and 400 through /_next/image."

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
check_closed
echo "After a restart on the published root, /api/ready named $revision as before, its set still served, and the legacy WebPs stayed closed."

# 9. photos verify on the published root: it passes and records, fails a set
#    whose byte flipped with its size kept, and passes again once it's back.
media_file=$PUBLISHED/assets/${active#/media/}
[ -s "$media_file" ] || fail "There is no ${active#/media/} under the published root, so flipping a byte in it would prove nothing."
before=$(sha256_of "$media_file")
verify_code=0
verify_published --json >"$TMP/verify.json" || verify_code=$?
[ "$verify_code" = 0 ] || fail "photos verify --json exited $verify_code on the published root, expected 0: $(cat "$TMP/verify.json")"
jq -e '.outcome == "VERIFIED" and .exitCode == 0 and .recorded == true' "$TMP/verify.json" >/dev/null ||
  fail "photos verify --json printed $(cat "$TMP/verify.json")."
[ -s "$PUBLISHED/status/verify.json" ] || fail "photos verify wrote no status/verify.json."
for printed in "$TMP/verify.json" "$PUBLISHED/status/verify.json"; do
  for absolute in /data/portfolio "$PUBLISHED" "$TMP"; do
    if grep -qF -- "$absolute" "$printed"; then
      fail "photos verify named the absolute path $absolute in ${printed##*/}: $(cat "$printed")"
    fi
  done
done
# shellcheck disable=SC2016 # $revision is jq's
jq -e '.schemaVersion == 1 and .chain.ok and any(.revisions[]; .revisionId == $revision and .live and .ok)' --arg revision "$revision" "$PUBLISHED/status/verify.json" >/dev/null ||
  fail "status/verify.json doesn't pass $revision: $(cat "$PUBLISHED/status/verify.json")"

flip_byte "$media_file"
[ "$(sha256_of "$media_file")" != "$before" ] || fail "Flipping a byte left ${active#/media/} as it was, so verify's failure would prove nothing."
[ "$(wc -c <"$media_file")" -eq "$(wc -c <"$TMP/media")" ] || fail "Flipping a byte changed the size of ${active#/media/}."
verify_code=0
verify_published >"$TMP/verify-flipped.txt" 2>&1 || verify_code=$?
flip_byte "$media_file"
[ "$(sha256_of "$media_file")" = "$before" ] || fail "Flipping the byte back didn't restore ${active#/media/}."
[ "$verify_code" = 1 ] || fail "photos verify exited $verify_code with a byte flipped in ${active#/media/}, expected 1: $(cat "$TMP/verify-flipped.txt")"
flipped_msg="${active##*/} does not match its sha256"
grep -qF -- "$flipped_msg" "$TMP/verify-flipped.txt" || fail "photos verify didn't say '$flipped_msg': $(cat "$TMP/verify-flipped.txt")"
grep -qF -- "[photos] VERIFY_FAILED: " "$TMP/verify-flipped.txt" || fail "photos verify didn't end VERIFY_FAILED: $(cat "$TMP/verify-flipped.txt")"
if grep -qF -- /data/portfolio "$TMP/verify-flipped.txt"; then
  fail "photos verify named an absolute path: $(cat "$TMP/verify-flipped.txt")"
fi
# shellcheck disable=SC2016 # $revision is jq's
jq -e 'any(.revisions[]; .revisionId == $revision and (.ok | not))' --arg revision "$revision" "$PUBLISHED/status/verify.json" >/dev/null ||
  fail "status/verify.json doesn't record the failure of $revision: $(cat "$PUBLISHED/status/verify.json")"
verify_code=0
verify_published >"$TMP/verify-again.txt" 2>&1 || verify_code=$?
[ "$verify_code" = 0 ] || fail "photos verify exited $verify_code once the byte was back, expected 0: $(cat "$TMP/verify-again.txt")"
# shellcheck disable=SC2016 # $revision is jq's
jq -e 'any(.revisions[]; .revisionId == $revision and .live and .ok)' --arg revision "$revision" "$PUBLISHED/status/verify.json" >/dev/null ||
  fail "status/verify.json doesn't pass $revision again once the byte was back: $(cat "$PUBLISHED/status/verify.json")"
echo "photos verify passed $revision and recorded it, failed it with exit 1 for a byte flipped in ${active#/media/} with its size kept, and passed it again once the byte was back."

# 10. #15's history and rollback in the image: revision 1 is one a rollback
#     can return to, `photos rollback --to 1` takes the site back to it, and
#     web follows without a restart and keeps it across one. This depends on
#     step 9's last, full photos verify passing both revisions: the record
#     it leaves is what makes revision 1 eligible, after the flipped byte
#     failed them both.
history_code=0
photos_published history --json --revisions >"$TMP/history-before.json" || history_code=$?
[ "$history_code" = 0 ] || fail "photos history --json --revisions exited $history_code, expected 0: $(cat "$TMP/history-before.json")"
# shellcheck disable=SC2016 # $revision and $first are jq's
jq -e '
  .total == 2 and .pointer.revisionId == $revision
  and ([.rows[] | [.kind, .revisionNumber, .revisionId, .live, .state]] == [["publish", 1, $first, false, "committed"], ["publish", 2, $revision, true, "committed"]])
  and ([.revisions[] | [.revisionNumber, .revisionId, .live, .eligible]] == [[2, $revision, true, false], [1, $first, false, true]])' \
  --arg revision "$revision" --arg first "$first" "$TMP/history-before.json" >/dev/null ||
  fail "photos history --json --revisions should list revision 2 live and revision 1 eligible: $(cat "$TMP/history-before.json")"
rollback_code=0
photos_published rollback --to 1 --reason "Catalog smoke: back to revision 1." --actor ci --yes --expect-active "$revision" >"$TMP/rollback.txt" 2>&1 || rollback_code=$?
[ "$rollback_code" = 0 ] || fail "photos rollback --to 1 exited $rollback_code, expected 0: $(cat "$TMP/rollback.txt")"
grep -qF -- "[photos] ROLLED_BACK: Rolled back to revision 1 ($first) from revision 2 ($revision)." "$TMP/rollback.txt" ||
  fail "photos rollback --to 1 didn't say it rolled back to $first: $(cat "$TMP/rollback.txt")"
chmod -R a+rX "$PUBLISHED"
# shellcheck disable=SC2016 # $first is jq's
expect_json /api/ready 200 no-store '.mode == "catalog" and .state == "ok" and .revisionId == $first and .revisionNumber == 1' --arg first "$first"
cp "$TMP/body.json" "$TMP/ready-rolled-back.json"
expect_records_on "$first" "$revision"
docker restart "$WEB" >/dev/null
wait_for_web
# shellcheck disable=SC2016 # $first is jq's
expect_json /api/ready 200 no-store '.revisionId == $first and .revisionNumber == 1' --arg first "$first"
diff -u "$TMP/ready-rolled-back.json" "$TMP/body.json" || fail "/api/ready changed when web restarted after the rollback."
expect_records_on "$first" "$revision"
expect_code "$active" 200
[ "$(header cache-control)" = 'public, max-age=31536000, immutable' ] || fail "GET $active sent Cache-Control: $(header cache-control) after the rollback."
history_code=0
photos_published history --json >"$TMP/history-after.json" || history_code=$?
[ "$history_code" = 0 ] || fail "photos history --json exited $history_code after the rollback, expected 0: $(cat "$TMP/history-after.json")"
# shellcheck disable=SC2016 # $first is jq's
jq -e '.total == 3 and .pointer.revisionId == $first and (.rows[-1] | .kind == "rollback" and .revisionId == $first and .revisionNumber == 1 and .live and .state == "committed")' \
  --arg first "$first" "$TMP/history-after.json" >/dev/null ||
  fail "photos history --json doesn't list the rollback to $first as live: $(cat "$TMP/history-after.json")"
echo "photos history listed revision 1 as one a rollback can return to, photos rollback --to 1 rolled back to $first, and /api/ready and the #6 Home records endpoint named revision 1 before and after a restart."
echo "smoke-catalog passed."
