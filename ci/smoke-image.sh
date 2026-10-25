#!/usr/bin/env bash
# Runs docker-compose.prod.yml against a locally built image in a throwaway
# project directory, with the photos in ci/fixtures/library and an empty data
# root, and checks:
#
# 1. web serves the site and /api/health, and the watcher writes every
#    legacy derivative, for the photos it starts with and for one added while
#    it runs, and stays healthy.
# 2. The migration runbook in docs/data-root.md works as uid 1001: with the
#    watcher stopped, a dry run and an apply in image-watcher initialize the
#    data root, and once the watcher is back it builds every /media set and
#    keeps its heartbeat fresh.
# 3. /media serves those sets, an original source 404s, and the photo IDs and
#    ETags stay the same once the containers are recreated.
# 4. With PHOTOGRAPHY_DATA_DIR unset, the watcher says the identity step is
#    off, writes the legacy derivatives, and writes no registry.
#
#   ci/smoke-image.sh <tag>
#
# ghcr.io/keyurgolani/keyurgolani.photography:<tag> must already exist
# locally, since nothing pulls here. web serves every /media set here, through
# PHOTOGRAPHY_MEDIA_ACCESS=all, on 127.0.0.1 port SMOKE_IMAGE_PORT, 3000 by
# default. Those are the only changes to docker-compose.prod.yml, made with an
# override that needs Docker Compose 2.24.4 or later for its !override tag.
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
PORT=${SMOKE_IMAGE_PORT:-3000}
BASE_URL=http://127.0.0.1:$PORT
OUTPUT_TIMEOUT=120
# One Compose project per run, so concurrent runs never share containers.
PROJECT=photography-smoke-$$
TMP=$(mktemp -d)
PHOTOS=$TMP/public/assets/photos
DATA=$TMP/portfolio-data
UNSET=$TMP/unset-library
OVERRIDE=$TMP/smoke.override.yml

compose() {
  docker compose -f "$ROOT/docker-compose.prod.yml" -f "$OVERRIDE" --project-directory "$TMP" -p "$PROJECT" "$@"
}

# A one-off command in image-watcher, the way docs/data-root.md runs one.
in_watcher() {
  compose run --rm --no-deps image-watcher "$@"
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
  # The containers write the derivative folders and the data root as uid
  # 1001. Remove them with the image under test, so cleanup never pulls anything.
  docker run --rm --pull never --user 0 --entrypoint rm -v "$TMP:/t" "$IMAGE" \
    -rf /t/public /t/.next-images-cache /t/portfolio-data /t/unset-library
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

# Prints the derivatives still missing under <library> for each photo name given.
missing_outputs() {
  local library=$1 base output
  shift
  for base in "$@"; do
    for output in \
      "thumbnails/$base.webp" "medium/$base.webp" "optimized/$base.webp" \
      "thumbnails-avif/$base.avif" "medium-avif/$base.avif" "optimized-avif/$base.avif" \
      "lqip/$base.txt"; do
      [ -s "$library/$output" ] || echo "$output"
    done
  done
}

# Waits up to OUTPUT_TIMEOUT seconds for all seven derivatives of each name.
# The watcher's exit code says nothing about per-file errors, so check files.
wait_for_outputs() {
  local deadline missing
  deadline=$((SECONDS + OUTPUT_TIMEOUT))
  while missing=$(missing_outputs "$PHOTOS" "$@") && [ -n "$missing" ]; do
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

# Sets HEALTH to the data root state /api/health reports. Fails unless it
# answers 200 with ok and that state, and nothing else.
check_health() {
  local code
  code=$(curl -sS --max-time 30 -o "$TMP/health.json" -w '%{http_code}' "$BASE_URL/api/health") ||
    fail "GET /api/health failed."
  [ "$code" = 200 ] || fail "GET /api/health returned $code, expected 200."
  jq -e '(keys == ["dataRoot", "ok"]) and .ok == true' "$TMP/health.json" >/dev/null ||
    fail "GET /api/health returned $(cat "$TMP/health.json"), expected only ok and dataRoot."
  HEALTH=$(jq -r .dataRoot "$TMP/health.json")
}

# `photos identity status --json`, run the way docs/data-root.md polls it.
identity_status() {
  # It exits 1 until the data root is ready, so read the JSON either way.
  in_watcher node dist/scripts/photos.mjs identity status --json || true
}

# Prints the registry's newest version file, identity/registry/v<N>.json. The
# running watcher can add a version and prune an old one meanwhile, so a
# version that's gone by the time it's read means reading the list again.
read_registry() {
  in_watcher node -e '
    const fs = require("fs");
    const dir = "/data/portfolio/identity/registry";
    for (let attempt = 1; ; attempt++) {
      const versions = fs.readdirSync(dir).map((name) => /^v([1-9][0-9]*)\.json$/.exec(name)).filter(Boolean).map((match) => Number(match[1]));
      if (versions.length === 0) throw new Error(`${dir} has no version file`);
      try {
        process.stdout.write(fs.readFileSync(`${dir}/v${Math.max(...versions)}.json`, "utf8"));
        break;
      } catch (error) {
        if (error.code !== "ENOENT" || attempt === 5) throw error;
      }
    }'
}

# Writes one line per photo to <file>, sorted: its library path, photo ID, and
# the /media URL of the w800 WebP in its ready set, from the registry.
media_sets() {
  read_registry >"$TMP/registry.json" || fail "Could not read the registry."
  jq -r '
    .photos[]
    | .revisions[.source.observedRevision] as $revision
    | [$revision.profiles | to_entries[] | select(.value.state == "ready") | .key] as $ready
    | if ($ready | length) == 1 then
        "\(.source.path) \(.photoId) /media/\(.photoId)/\($revision.assetRevision)/\($ready[0])/w800.webp"
      else
        error("\(.source.path) has \($ready | length) ready sets, expected 1")
      end' "$TMP/registry.json" | LC_ALL=C sort >"$1" || fail "Could not list a ready set for every photo."
}

# Fetches each set listed in <sets> and writes its line with the ETag to
# <file>. Fails unless each is 200, immutable, image/webp, and tagged with a
# SHA-256.
media_etags() {
  local path photo url code etag
  : >"$2"
  while read -r path photo url; do
    code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$BASE_URL$url") ||
      fail "GET $url failed."
    [ "$code" = 200 ] || fail "GET $url, the set of $path, returned $code, expected 200."
    tr -d '\r' <"$TMP/headers.txt" | grep -qix 'cache-control: public, max-age=31536000, immutable' ||
      fail "GET $url did not send Cache-Control: public, max-age=31536000, immutable."
    tr -d '\r' <"$TMP/headers.txt" | grep -qix 'content-type: image/webp' || fail "GET $url did not send Content-Type: image/webp."
    etag=$(tr -d '\r' <"$TMP/headers.txt" | sed -n 's/^[Ee][Tt][Aa][Gg]: *//p' | head -1)
    [[ $etag =~ ^\"[0-9a-f]{64}\"$ ]] || fail "GET $url sent ETag '$etag', expected a quoted SHA-256."
    echo "$path $photo $url $etag" >>"$2"
  done <"$1"
}

# 1. A throwaway library and an empty data root. Both containers run as uid
#    1001, and the override is the smoke test's only change to the Compose file.
mkdir -p "$PHOTOS" "$TMP/.next-images-cache" "$DATA" "$UNSET"
cp ci/fixtures/library/*.jpg "$PHOTOS/"
cp ci/fixtures/library/*.jpg "$UNSET/"
chmod -R a+rwX "$PHOTOS" "$TMP/.next-images-cache" "$DATA" "$UNSET"
fixtures=()
for fixture in ci/fixtures/library/*.jpg; do
  fixtures+=("$(basename "$fixture" .jpg)")
done
cat >"$OVERRIDE" <<YAML
services:
  web:
    ports: !override
      - "127.0.0.1:$PORT:3000"
    environment:
      - PHOTOGRAPHY_MEDIA_ACCESS=all
YAML
if curl -s --max-time 2 -o /dev/null "$BASE_URL/"; then
  fail "Something already answers on $BASE_URL. Set SMOKE_IMAGE_PORT to a free port."
fi

# 2. Start the services in ci/smoke-services. --wait returns once web and the
#    watcher pass their healthchecks: /api/health, and a heartbeat the watcher
#    writes even before the data root is initialized.
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

# 5. /api/health answers 200 and reports the empty data root as uninitialized.
check_health
[ "$HEALTH" = uninitialized ] || fail "GET /api/health reported dataRoot '$HEALTH' before the migration, expected uninitialized."
echo "GET /api/health returned 200 with dataRoot uninitialized."

# 6. The startup scan writes all seven derivatives for every fixture, and the
#    watcher stays up.
wait_for_outputs "${fixtures[@]}"
require_watcher_running
echo "The watcher wrote all seven derivatives for: ${fixtures[*]}."

# 7. Watch mode picks up a photo added while it runs.
cp "ci/fixtures/library/${fixtures[0]}.jpg" "$PHOTOS/ci-added.jpg"
wait_for_outputs ci-added
require_watcher_running
echo "The watcher picked up ci-added.jpg and wrote all seven derivatives without restarting."

# 8. The migration runbook: stop the watcher, dry-run, apply the printed plan,
#    all as image-watcher's uid 1001.
compose stop image-watcher
dry_run=$(in_watcher node dist/scripts/photos.mjs migrate --dry-run) || fail "The migration dry run failed: $dry_run"
plan=$(sed -n 's/^Plan: //p' <<<"$dry_run")
[ -n "$plan" ] || fail "The dry run printed no plan: $dry_run"
in_watcher node dist/scripts/photos.mjs migrate --apply --plan "$plan" || fail "Applying $plan failed."
owner=$(in_watcher sh -c 'stat -c %u /data/portfolio/identity/registry /data/portfolio/identity/registry/v*.json | sort -u') ||
  fail "Could not stat the registry."
[ "$owner" = 1001 ] || fail "The migration wrote the registry as uid $owner, expected 1001."
check_health
[ "$HEALTH" = ready ] || fail "GET /api/health reported dataRoot '$HEALTH' after the migration, expected ready."
echo "The migration ran as uid 1001, and /api/health reports the data root ready."

# 9. Back up, the watcher builds every set, and its heartbeat stays fresh.
compose up -d --pull never --wait --wait-timeout 180 image-watcher
deadline=$((SECONDS + OUTPUT_TIMEOUT))
until identity_status >"$TMP/status.json" && jq -e --argjson photos "$((${#fixtures[@]} + 1))" '
    .dataRoot.state == "ready" and .photos.total == $photos and .pendingJobs == 0' "$TMP/status.json" >/dev/null; do
  if [ "$SECONDS" -ge "$deadline" ]; then
    cat "$TMP/status.json"
    fail "The watcher did not build every /media set within ${OUTPUT_TIMEOUT}s."
  fi
  sleep 2
done
jq -e '.failedProfiles == [] and .holds == []' "$TMP/status.json" >/dev/null ||
  fail "The migrated photos have failed sets or holds: $(jq -c '{failedProfiles, holds}' "$TMP/status.json")."
age=$(jq -r '.watcher.ageSeconds // empty' "$TMP/status.json")
[ -n "$age" ] && [ "$age" -lt 120 ] || fail "The watcher's heartbeat is ${age:-missing} s old, expected under 120 s."
require_watcher_running
echo "The watcher built every /media set, and its heartbeat is ${age} s old."

# 10. /media serves each set under PHOTOGRAPHY_MEDIA_ACCESS=all, and an original 404s.
media_sets "$TMP/sets.txt"
[ "$(wc -l <"$TMP/sets.txt")" -eq "$((${#fixtures[@]} + 1))" ] || fail "Expected a set per photo, got: $(cat "$TMP/sets.txt")"
media_etags "$TMP/sets.txt" "$TMP/before.txt"
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$BASE_URL/assets/photos/${fixtures[0]}.jpg") ||
  fail "GET /assets/photos/${fixtures[0]}.jpg failed."
[ "$code" = 404 ] || fail "GET /assets/photos/${fixtures[0]}.jpg, an original, returned $code, expected 404."
echo "/media served every set with immutable and an ETag, and the original returned 404."

# 11. Recreated containers keep every photo ID, /media URL, and ETag.
compose down
compose up -d --pull never --wait --wait-timeout 180 "${services[@]}"
check_health
[ "$HEALTH" = ready ] || fail "GET /api/health reported dataRoot '$HEALTH' after the restart, expected ready."
media_sets "$TMP/sets-after.txt"
media_etags "$TMP/sets-after.txt" "$TMP/after.txt"
if ! diff -u "$TMP/before.txt" "$TMP/after.txt"; then
  fail "The photo IDs, /media URLs, or ETags changed when the containers were recreated."
fi
require_watcher_running
echo "After the containers were recreated, every photo kept its ID, /media URL, and ETag."

# 12. With PHOTOGRAPHY_DATA_DIR unset, the image's watcher runs only the legacy
#     step. The image sets no default, so nothing names a data root.
docker run --rm --pull never --user 1001:1001 -e PHOTOGRAPHY_LIBRARY_DIR=/library -v "$UNSET:/library" "$IMAGE" sh -c '
  node dist/scripts/imageWatcher.mjs --once || exit 1
  if [ -e /app/portfolio-data ] || [ -n "$(ls -A /data/portfolio)" ]; then
    echo "The watcher wrote a data root."
    exit 1
  fi' >"$TMP/unset.log" 2>&1 || { cat "$TMP/unset.log"; fail "The watcher with PHOTOGRAPHY_DATA_DIR unset failed."; }
grep -q 'Identity step off: the data root is unset' "$TMP/unset.log" || {
  cat "$TMP/unset.log"
  fail "The watcher with PHOTOGRAPHY_DATA_DIR unset did not log that the identity step is off."
}
missing=$(missing_outputs "$UNSET" "${fixtures[@]}")
[ -z "$missing" ] || fail "With PHOTOGRAPHY_DATA_DIR unset, the watcher did not write: $missing"
registries=$(find "$UNSET" \( -name registry.json -o -path '*/identity/registry' \))
[ -z "$registries" ] || fail "With PHOTOGRAPHY_DATA_DIR unset, the watcher wrote $registries."
echo "With PHOTOGRAPHY_DATA_DIR unset, the watcher logged that the identity step is off, wrote the legacy derivatives, and no registry."
