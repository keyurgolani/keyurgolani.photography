#!/usr/bin/env bash
# Runs docker-compose.prod.yml against a locally built image in a throwaway
# project directory, with the photos in ci/fixtures/library and an empty data
# root, and checks:
#
# 1. web serves the site and /api/health, and with nothing published it
#    answers the catalog's unavailable state: / is #21's error page, and
#    /api/ready answers 503 with not-published, before the migration and
#    after it. /api/photos is a 404 and /gallery a 308 to /work (#13's slice
#    E). The library is mounted read-only at /data/library in image-watcher
#    and not at all in web or curator (v1.7.0). The library starts with a v1.6 host's
#    legacy derivatives in it, none of which serves, directly or through
#    /_next/image, and the watcher stays healthy and writes nothing there:
#    every file and folder in the library is the same at the end of the run
#    as at its start, but for the one photo the run adds.
# 2. The migration runbook in docs/data-root.md works as uid 1001: with the
#    watcher stopped, a dry run and an apply in image-watcher initialize the
#    data root. Once the watcher is back it builds every /media set, each with
#    its manifest.json, for the photos it starts with and for one added while
#    it runs, and keeps its heartbeat fresh, with legacyDerivatives: false.
# 3. /media serves none of those sets before the first activation, #6's Home
#    records endpoint answers 503 with not-published for each photo, an
#    original source 404s, and the photo IDs, /media URLs, and set digests
#    stay the same once the containers are recreated.
# 4. With PHOTOGRAPHY_DATA_DIR unset, the watcher exits 1 and writes nothing,
#    and with PHOTOGRAPHY_LIBRARY_DIR unset, as on v1.6's compose file, it
#    exits 1 instead of reading the library at its old path.
# 5. About shows the portrait in ./site-config, read-only, at a content-hashed
#    URL that changes when the file is swapped, with no restart, and its name
#    panel once the file is gone. The image itself holds no site config.
# 6. web 404s the curator paths, and the curator service, started by name
#    with secret files the image's commands made, serves its login on
#    127.0.0.1:3001 with its headers, refuses another Host and an
#    Origin-less POST, signs in only with the passphrase, ends the session
#    at logout, and answers 503 without its session secret.
#
#   ci/smoke-image.sh <tag>
#
# ghcr.io/keyurgolani/keyurgolani.photography:<tag> must already exist
# locally, since nothing pulls here. web listens on 127.0.0.1 port
# SMOKE_IMAGE_PORT, 3000 by default. That is the only change to
# docker-compose.prod.yml, made with an override that needs Docker Compose
# 2.24.4 or later for its !override tag. ci/smoke-catalog.sh checks /media on
# a published catalog.
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
SITE_CONFIG=$TMP/site-config
OVERRIDE=$TMP/smoke.override.yml

compose() {
  docker compose -f "$ROOT/docker-compose.prod.yml" -f "$OVERRIDE" --project-directory "$TMP" -p "$PROJECT" "$@"
}

# Hands data root <dir>, inside this run's temp root, to uid 1001, the
# image's user, as docs/data-root.md's setup does (chown -R 1001:1001, chmod
# 700), so the owner gate lets the image's commands write it on any runner.
hand_to_image() {
  docker run --rm --pull never --network none --user 0 --entrypoint sh -v "$1:/d" "$IMAGE" -c 'chown -R 1001:1001 /d && chmod 700 /d' ||
    fail "Could not hand $1 to uid 1001."
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
  compose --profile curator down --remove-orphans
  # The containers write the derivative folders and the data root as uid
  # 1001. Remove them with the image under test, so cleanup never pulls anything.
  docker run --rm --pull never --user 0 --entrypoint rm -v "$TMP:/t" "$IMAGE" \
    -rf /t/public /t/portfolio-data /t/unset-library /t/old-path-data /t/secrets
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

# The seven legacy basename derivatives of <base>, as a v1.6 watcher wrote them.
LEGACY_OUTPUTS=(
  thumbnails/%s.webp medium/%s.webp optimized/%s.webp
  thumbnails-avif/%s.avif medium-avif/%s.avif optimized-avif/%s.avif
  lqip/%s.txt
)

# Writes all seven legacy derivatives of each name into <library>, and a
# cache/ file, the way a host's library still holds them after v1.6. Any
# non-empty bytes do: nothing reads them, and the checks are that nothing
# serves them and nothing in the stack changes them.
plant_legacy() {
  local library=$1 base pattern output
  shift
  for base in "$@"; do
    for pattern in "${LEGACY_OUTPUTS[@]}"; do
      # shellcheck disable=SC2059 # the pattern is ours, with one %s
      output=$(printf "$pattern" "$base")
      mkdir -p "$library/$(dirname "$output")"
      printf 'legacy %s from v1.6\n' "$output" >"$library/$output"
    done
  done
  mkdir -p "$library/cache/set-sources"
  printf '{}\n' >"$library/cache/upright-rebuild.json"
}

# Prints every file and folder under <library>, sorted: its path, type, size,
# mtime, mode, owner and group, and ctime, and for a file its SHA-256. Two
# equal listings mean nothing was added, removed, rewritten, touched,
# chmodded, or chowned.
library_listing() {
  (
    cd "$1" || exit 1
    find . -mindepth 1 -printf '%P %y %s %T@ %m %U:%G %C@\n' | LC_ALL=C sort
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
  )
}

# Fails unless <library> lists exactly as <listing file> does.
require_library_unchanged() {
  local library=$1 before=$2 context=$3
  library_listing "$library" >"$TMP/listing-now.txt" || fail "Could not list $library."
  diff -u "$before" "$TMP/listing-now.txt" || fail "$context: the library changed, and nothing in the stack may write it."
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
  # shellcheck disable=SC2016 # the ${...} are JavaScript template strings
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

# Writes each line of <sets> to <file> with the SHA-256 its set's manifest
# records for the w800 WebP, the ETag /media sends once a revision holds it.
set_digests() {
  local path photo url set digest
  : >"$2"
  while read -r path photo url; do
    set=${url#/media/}
    set=${set%/w800.webp}
    # compose run reads stdin, which here is <sets>.
    digest=$(in_watcher cat "/data/portfolio/assets/$set/manifest.json" </dev/null | jq -r '.variants.w800.webp.sha256') ||
      fail "Could not read the manifest of $url, the set of $path."
    [[ $digest =~ ^[0-9a-f]{64}$ ]] || fail "The manifest of $url records '$digest' for w800.webp, expected a SHA-256."
    echo "$path $photo $url $digest" >>"$2"
  done <"$1"
}

# Fails unless GET <endpoint> answers <code> with Cache-Control <cache> and a
# JSON body jq <filter> accepts. Any further arguments go to jq first.
expect_json() {
  local endpoint=$1 expected=$2 cache=$3 filter=$4 code
  shift 4
  code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o "$TMP/body.json" -w '%{http_code}' "$BASE_URL$endpoint") ||
    fail "GET $endpoint failed."
  [ "$code" = "$expected" ] || fail "GET $endpoint returned $code, expected $expected: $(cat "$TMP/body.json")"
  tr -d '\r' <"$TMP/headers.txt" | grep -qix "cache-control: $cache" || fail "GET $endpoint did not send Cache-Control: $cache."
  jq -e "$@" "$filter" "$TMP/body.json" >/dev/null || fail "GET $endpoint returned $(cat "$TMP/body.json"), which fails $filter."
}

# Fails unless GET <endpoint> answers <code>. Leaves the headers in
# $TMP/headers.txt and the body in $TMP/body.txt.
expect_code() {
  local endpoint=$1 expected=$2 code
  code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o "$TMP/body.txt" -w '%{http_code}' "$BASE_URL$endpoint") || fail "GET $endpoint failed."
  [ "$code" = "$expected" ] || fail "GET $endpoint returned $code, expected $expected."
}

# /api/ready's answer while nothing is published.
NOT_PUBLISHED='. == {mode: "catalog", state: "unavailable", revisionId: null, revisionNumber: null, activatedAt: null, reason: "not-published"}'

# 1. A throwaway library and an empty data root. Both containers run as uid
#    1001, and the override is the smoke test's only change to the Compose file.
#    The library holds a v1.6 host's legacy derivatives too, and anyone on the
#    host may write it, so only the read-only mounts can stop the stack
#    writing it.
mkdir -p "$PHOTOS" "$DATA" "$UNSET" "$SITE_CONFIG/about"
cp ci/fixtures/library/*.jpg "$PHOTOS/"
cp ci/fixtures/library/*.jpg "$UNSET/"
# About's portrait: a generated stand-in carrying EXIF with GPS and a camera
# serial, and XMP, made with the image's own Sharp, so step 3b's check that
# none of it is served can fail. The folder is writable by anyone on the host,
# so only the read-only mount can stop web writing it in step 3b.
PORTRAIT_MARKERS=(SMOKE-SERIAL-7Q4 SMOKE-COPYRIGHT-7Q4 SMOKE-XMP-7Q4)
mkdir -p "$TMP/portraits"
docker run --rm --pull never --user "$(id -u):$(id -g)" -v "$TMP/portraits:/out" -w /app --entrypoint node "$IMAGE" -e '
const sharp = require("sharp");
sharp({ create: { width: 1600, height: 2000, channels: 3, background: { r: 150, g: 110, b: 80 } } })
  .withExif({
    IFD0: { Make: "Smoke", Copyright: "SMOKE-COPYRIGHT-7Q4" },
    IFD2: { BodySerialNumber: "SMOKE-SERIAL-7Q4" },
    IFD3: { GPSLatitudeRef: "N", GPSLatitude: "47/1 36/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "122/1 19/1 0/1" },
  })
  .withXmp("<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"><rdf:Description xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:creator>SMOKE-XMP-7Q4</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta>")
  .jpeg()
  .toFile("/out/portrait.jpg")
  .then(() => sharp("/out/portrait.jpg").metadata())
  .then(({ exif, xmp }) => {
    // 0x8825 is the tag that points at the GPS block, in either byte order.
    const gps = exif && (exif.includes(Buffer.from([0x88, 0x25])) || exif.includes(Buffer.from([0x25, 0x88])));
    if (!gps || !xmp) throw new Error("the stand-in portrait has no GPS EXIF or no XMP");
  })
  .catch((error) => { console.error(error.message); process.exit(1); });
' || fail "Could not make the stand-in portrait with the image's Sharp."
PORTRAIT=$TMP/portraits/portrait.jpg
for marker in Exif "${PORTRAIT_MARKERS[@]}"; do
  grep -qa "$marker" "$PORTRAIT" || fail "The stand-in portrait does not carry $marker, so step 3b could not catch it."
done
cp "$PORTRAIT" "$SITE_CONFIG/about/portrait.jpg"
chmod -R a+rwX "$SITE_CONFIG"
fixtures=()
for fixture in ci/fixtures/library/*.jpg; do
  fixtures+=("$(basename "$fixture" .jpg)")
done
plant_legacy "$PHOTOS" "${fixtures[@]}"
chmod -R a+rwX "$PHOTOS" "$UNSET"
hand_to_image "$DATA"
library_listing "$PHOTOS" >"$TMP/listing-start.txt" || fail "Could not list the library."
grep -q "^optimized/${fixtures[0]}.webp f " "$TMP/listing-start.txt" ||
  fail "The library listing names no planted legacy derivative, so the checks on it would prove nothing."
cat >"$OVERRIDE" <<YAML
services:
  web:
    ports: !override
      - "127.0.0.1:$PORT:3000"
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

# 3. With nothing published, the home page is #21's error page, a 500 of HTML
#    with a <title>. It renders client-side, so assert nothing more. There is
#    no legacy Home to fall back to.
home=$(curl -sS --max-time 30 -o "$TMP/home.html" -w '%{http_code} %{content_type}' "$BASE_URL/") ||
  fail "GET / failed."
code=${home%% *}
content_type=${home#* }
[ "$code" = 500 ] || fail "GET / returned $code with nothing published, expected #21's 500."
case $content_type in
  text/html*) ;;
  *) fail "GET / returned content-type '$content_type', expected text/html." ;;
esac
grep -q '<title>' "$TMP/home.html" || fail "GET / has no <title>."
echo "GET / returned #21's error page, HTML with a <title>, with nothing published."

# 3b. About's portrait comes from ./site-config, which web mounts read-only,
#     at a content-hashed /about/portrait URL sent as immutable. Swapping the
#     file changes the URL with no restart, and removing it leaves About's
#     name panel, never a 500.
about_portrait_url() {
  local code
  code=$(curl -sS --max-time 30 -o "$TMP/about.html" -w '%{http_code}' "$BASE_URL/about") || fail "GET /about failed."
  [ "$code" = 200 ] || fail "GET /about returned $code, expected 200."
  grep -o '/about/portrait/[0-9a-f]\{32\}/w1200\.webp' "$TMP/about.html" | head -n 1 || true
}
first=$(about_portrait_url)
[ -n "$first" ] || fail "GET /about names no /about/portrait/<token>/w1200.webp for ./site-config/about/portrait.jpg."
code=$(curl -sS --max-time 60 -D "$TMP/headers.txt" -o "$TMP/portrait.webp" -w '%{http_code} %{content_type}' "$BASE_URL$first") || fail "GET $first failed."
[ "$code" = "200 image/webp" ] || fail "GET $first returned '$code', expected '200 image/webp'."
tr -d '\r' <"$TMP/headers.txt" | grep -qix 'cache-control: public, max-age=31536000, immutable' || fail "GET $first did not send Cache-Control: public, max-age=31536000, immutable."
curl -sS --max-time 60 -o "$TMP/portrait.avif" "$BASE_URL${first%.webp}.avif" || fail "GET ${first%.webp}.avif failed."
for variant in "$TMP/portrait.webp" "$TMP/portrait.avif"; do
  if grep -qaE 'EXIF|Exif|XMP |xmpmeta' "$variant"; then fail "The portrait's $(basename "$variant") carries EXIF or XMP."; fi
  for marker in "${PORTRAIT_MARKERS[@]}"; do
    if grep -qa "$marker" "$variant"; then fail "The portrait's $(basename "$variant") carries the stand-in's $marker."; fi
  done
done
if compose exec -T web sh -c 'touch /config/site/about/written' 2>/dev/null; then
  fail "web could write its site config folder, which it must mount read-only."
fi
cp ci/fixtures/library/ci-landscape.jpg "$SITE_CONFIG/about/portrait.jpg"
second=$(about_portrait_url)
[ -n "$second" ] && [ "$second" != "$first" ] || fail "After the swap, GET /about named '$second', expected a new /about/portrait URL, with no restart."
code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$BASE_URL$first") || fail "GET $first failed."
[ "$code" = 404 ] || fail "After the swap, the old $first returned $code, expected 404."
tr -d '\r' <"$TMP/headers.txt" | grep -qix 'cache-control: no-store' || fail "After the swap, the old $first did not send Cache-Control: no-store."
rm "$SITE_CONFIG/about/portrait.jpg"
gone=$(about_portrait_url)
[ -z "$gone" ] || fail "With no portrait, GET /about still named $gone."
grep -q 'data-testid="about-portrait"' "$TMP/about.html" || fail "With no portrait, GET /about has no name panel."
compose logs --no-color web | grep -q '\[about\] No portrait: there is no about/portrait.jpg' || fail "web logged no warning once the portrait was gone."
if compose logs --no-color web | grep '\[about\]' | grep -q '/config/site'; then fail "web logged the site config folder's path."; fi
cp "$PORTRAIT" "$SITE_CONFIG/about/portrait.jpg"
chmod a+r "$SITE_CONFIG/about/portrait.jpg"
[ "$(about_portrait_url)" = "$first" ] || fail "With the first portrait back, GET /about did not name its URL again."
docker run --rm --pull never --entrypoint sh "$IMAGE" -c '[ ! -e /app/site-config ] && [ ! -e /config ]' ||
  fail "The image holds a site config folder, which belongs on the host."
echo "About served ./site-config's portrait read-only at an immutable hashed URL with none of its EXIF, GPS, or XMP, followed a swap and a removal with no restart, 404ed the swapped-out URL, and the image holds no site config."

# 4. Nothing is published, so /api/ready answers 503 with not-published.
#    /api/photos is gone, and /gallery is Work's (#13's slice E).
expect_json /api/ready 503 no-store "$NOT_PUBLISHED"
expect_code /api/photos 404
expect_code /gallery 308
tr -d '\r' <"$TMP/headers.txt" | grep -qix 'location: /work' || fail "GET /gallery did not send Location: /work."
echo "GET /api/ready returned 503 with not-published before the migration, /api/photos 404, and /gallery 308 to /work."

# 5. /api/health answers 200 and reports the empty data root as uninitialized.
check_health
[ "$HEALTH" = uninitialized ] || fail "GET /api/health reported dataRoot '$HEALTH' before the migration, expected uninitialized."
echo "GET /api/health returned 200 with dataRoot uninitialized."

# 5b. The curator (#14): web 404s every curator path. Then the curator's
#     secret files are made the way docs/curator.md makes them, with the
#     image's own commands and a passphrase made for this run, and curator,
#     started by name, listens inside its container under
#     CURATION_BIND_SCOPE. It sends /curation to the login page without a
#     session, serves the login page on 127.0.0.1:3001 with its headers,
#     refuses another Host with 421 and a POST without an Origin with 403,
#     signs in with the passphrase and not without it, serves /curation to
#     the session, and ends it at logout. With a secret file gone, every path
#     answers 503. No passphrase, hash, secret or cookie is printed.
CURATOR_URL=http://127.0.0.1:3001
for path in /curation /api/curation/x; do
  code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$BASE_URL$path") || fail "GET $path from web failed."
  [ "$code" = 404 ] || fail "GET $path from web returned $code, expected 404."
done
if curl -s --max-time 2 -o /dev/null "$CURATOR_URL/"; then
  fail "Something already answers on $CURATOR_URL, curator's fixed port."
fi
SECRETS=$TMP/secrets
mkdir "$SECRETS"
docker run --rm --pull never --user 0 --entrypoint sh -v "$SECRETS:/s" "$IMAGE" -c 'chown 1001:1001 /s && chmod 0700 /s'
# A test passphrase for this run only, never printed.
SMOKE_PASSPHRASE=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')
in_secrets() {
  docker run --rm -i --pull never --network none --user 1001:1001 -v "$SECRETS:/secrets" "$IMAGE" node dist/scripts/photos.mjs curation "$@"
}
printf '%s\n' "$SMOKE_PASSPHRASE" | in_secrets hash-passphrase --out /secrets/curator-passphrase.hash >/dev/null \
  || fail "curation hash-passphrase failed in the image."
in_secrets session-secret --out /secrets/curator-session.key </dev/null >/dev/null || fail "curation session-secret failed in the image."
compose up -d --pull never --wait --wait-timeout 180 curator
# The curator reads no file in the library, so it mounts none (v1.7.0).
# shellcheck disable=SC2016 # the curator's shell expands it
compose exec -T curator sh -c '[ ! -e /data/library ] && [ "$PHOTOGRAPHY_LIBRARY_DIR" = /data/library ]' ||
  fail "curator has a /data/library, or doesn't set PHOTOGRAPHY_LIBRARY_DIR=/data/library for its messages."
code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$CURATOR_URL/curation") || fail "GET /curation from curator failed."
[ "$code" = 307 ] || fail "GET /curation from curator without a session returned $code, expected 307 to the login page."
grep -qiE '^location: (http://127\.0\.0\.1:3001)?/curation/login$' <<<"$(tr -d '\r' <"$TMP/headers.txt")" || fail "GET /curation without a session did not lead to /curation/login."
code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$CURATOR_URL/curation/login") || fail "GET /curation/login from curator failed."
[ "$code" = 200 ] || fail "GET /curation/login from curator returned $code, expected 200."
headers=$(tr -d '\r' <"$TMP/headers.txt")
grep -qi '^cache-control:.*no-store' <<<"$headers" || fail "curator's /curation/login did not send Cache-Control with no-store."
grep -qix 'x-robots-tag: noindex, nofollow' <<<"$headers" || fail "curator's /curation/login did not send X-Robots-Tag: noindex, nofollow."
grep -qix 'referrer-policy: no-referrer' <<<"$headers" || fail "curator's /curation/login did not send Referrer-Policy: no-referrer."
grep -qix "content-security-policy: frame-ancestors 'none'" <<<"$headers" || fail "curator's /curation/login did not send frame-ancestors 'none'."
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -H 'Host: rebound.example:3001' "$CURATOR_URL/curation/login") || fail "GET /curation/login with another Host failed."
[ "$code" = 421 ] || fail "GET /curation/login from curator with another Host returned $code, expected 421."
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -H 'Host: rebound.example:3001' "$CURATOR_URL/api/health") || fail "GET /api/health with another Host failed."
[ "$code" = 421 ] || fail "GET /api/health from curator with another Host returned $code, expected 421."
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X POST "$CURATOR_URL/curation") || fail "POST /curation failed."
[ "$code" = 403 ] || fail "POST /curation from curator without an Origin returned $code, expected 403."
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$CURATOR_URL/api/curation/x") || fail "GET /api/curation/x failed."
[ "$code" = 401 ] || fail "GET /api/curation/x from curator without a session returned $code, expected 401."
# Posts the login form with the passphrase on stdin, so it's never an argument.
login() {
  printf '%s' "$1" | curl -sS --max-time 60 -D "$TMP/login.txt" -o /dev/null -w '%{http_code}' \
    -H "Origin: $CURATOR_URL" --data-urlencode 'passphrase@-' "$CURATOR_URL/api/curation/login"
}
code=$(login "not-$SMOKE_PASSPHRASE") || fail "POST /api/curation/login failed."
[ "$code" = 303 ] || fail "A wrong passphrase got $code, expected 303."
grep -qi '^set-cookie:' <(tr -d '\r' <"$TMP/login.txt") && fail "A wrong passphrase got a cookie."
code=$(login "$SMOKE_PASSPHRASE") || fail "POST /api/curation/login failed."
[ "$code" = 303 ] || fail "The passphrase got $code, expected 303."
set_cookie=$(tr -d '\r' <"$TMP/login.txt" | grep -i '^set-cookie: curator_session=' | head -n 1)
[ -n "$set_cookie" ] || fail "The passphrase got no curator_session cookie."
for attribute in HttpOnly Secure SameSite=Strict Path=/ Max-Age=43200; do
  grep -qi "; $attribute\(;\|$\)" <<<"$set_cookie" || fail "The curator_session cookie lacks $attribute."
done
session=$(sed -e 's/^[Ss]et-[Cc]ookie: //' -e 's/;.*//' <<<"$set_cookie")
rm -f "$TMP/login.txt"
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -H "Cookie: $session" "$CURATOR_URL/curation") || fail "GET /curation with the session failed."
[ "$code" = 200 ] || fail "GET /curation with the session returned $code, expected 200."
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -X POST -H "Cookie: $session" -H "Origin: $CURATOR_URL" "$CURATOR_URL/api/curation/logout") || fail "POST /api/curation/logout failed."
[ "$code" = 303 ] || fail "POST /api/curation/logout returned $code, expected 303."
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -H "Cookie: $session" "$CURATOR_URL/api/curation/x") || fail "GET /api/curation/x after logout failed."
[ "$code" = 401 ] || fail "The session's cookie, replayed after logout, got $code, expected 401."
unset session set_cookie
# Without the session secret, every path is a 503, and nothing signs in.
docker run --rm --pull never --user 0 --entrypoint rm -v "$SECRETS:/s" "$IMAGE" -f /s/curator-session.key
for path in /curation/login /api/health; do
  code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$CURATOR_URL$path") || fail "GET $path without the session secret failed."
  [ "$code" = 503 ] || fail "GET $path from curator without the session secret returned $code, expected 503."
done
code=$(login "$SMOKE_PASSPHRASE") || fail "POST /api/curation/login without the session secret failed."
[ "$code" = 503 ] || fail "The passphrase without the session secret got $code, expected 503."
unset SMOKE_PASSPHRASE
compose rm --stop --force curator
echo "web 404s the curator paths, and curator sent /curation to its login, served the login with its headers, refused another Host, an Origin-less POST and a sessionless handler, signed in only with the passphrase, ended the session at logout, and answered 503 without its session secret."

# 6. The library is the owner's originals, and since v1.7.0 nothing writes it.
#    image-watcher mounts it read-only at /data/library, with
#    PHOTOGRAPHY_LIBRARY_DIR there, and can't write it even though the host
#    folder lets anyone. web mounts no library at all, and its own
#    public/assets/photos holds only what the image ships. The watcher, up
#    since step 2, has written nothing in it: no derivative, no folder.
require_watcher_running
[ "$(compose exec -T image-watcher printenv PHOTOGRAPHY_LIBRARY_DIR)" = /data/library ] ||
  fail "image-watcher does not set PHOTOGRAPHY_LIBRARY_DIR=/data/library."
compose exec -T image-watcher test -f "/data/library/${fixtures[0]}.jpg" || fail "image-watcher has no /data/library/${fixtures[0]}.jpg: the library isn't mounted there."
if compose exec -T image-watcher sh -c 'touch /data/library/written' 2>/dev/null; then
  fail "image-watcher could write /data/library, which it must mount read-only."
fi
if compose exec -T image-watcher sh -c 'touch /data/library/optimized/written' 2>/dev/null; then
  fail "image-watcher could write a legacy derivative folder in /data/library, which it must mount read-only."
fi
# shellcheck disable=SC2016 # web's shell expands it
compose exec -T web sh -c '[ ! -e /data/library ] && [ -z "${PHOTOGRAPHY_LIBRARY_DIR:-}" ]' ||
  fail "web has /data/library or sets PHOTOGRAPHY_LIBRARY_DIR, but it reads nothing in the library."
web_photos=$(compose exec -T web sh -c 'ls -A /app/public/assets/photos | LC_ALL=C sort | tr "\n" " "') || fail "Could not list web's /app/public/assets/photos."
[ "$web_photos" = ".gitkeep README.md " ] || fail "web's /app/public/assets/photos holds '$web_photos', expected only the image's .gitkeep and README.md."
require_library_unchanged "$PHOTOS" "$TMP/listing-start.txt" "Before the migration"
echo "image-watcher reads the library read-only at /data/library, web mounts none, and the watcher wrote nothing in it."
# None of the legacy derivatives serves (#13's slice E): each 404s with
# nothing cached, and /_next/image refuses it with its own 400.
for base in "${fixtures[@]}"; do
  url=/assets/photos/optimized/$base.webp
  expect_code "$url" 404
  tr -d '\r' <"$TMP/headers.txt" | grep -qix 'cache-control: no-store' || fail "The 404 for $url did not send Cache-Control: no-store."
  expect_code "/_next/image?url=$(jq -rn --arg url "$url" '$url | @uri')&w=400&q=75" 400
  [ "$(cat "$TMP/body.txt")" = '"url" parameter is not allowed' ] || fail "GET /_next/image for $url answered 400 with '$(cat "$TMP/body.txt")'."
done
echo "Every legacy derivative returned 404, and 400 through /_next/image."

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

# With the registry written, there is still nothing published, so no photo
# list appears, and /api/ready answers as before.
expect_json /api/ready 503 no-store "$NOT_PUBLISHED"
expect_code /api/photos 404
echo "After the migration GET /api/ready still returned 503 with not-published, and /api/photos 404."

# Waits up to OUTPUT_TIMEOUT seconds until photos identity status counts
# <photos> photos, all built, then fails on a failed set or a hold.
wait_for_sets() {
  local deadline
  deadline=$((SECONDS + OUTPUT_TIMEOUT))
  until identity_status >"$TMP/status.json" && jq -e --argjson photos "$1" '
      .dataRoot.state == "ready" and .photos.total == $photos and .pendingJobs == 0' "$TMP/status.json" >/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      cat "$TMP/status.json"
      fail "The watcher did not build a /media set for each of $1 photos within ${OUTPUT_TIMEOUT}s."
    fi
    sleep 2
  done
  jq -e '.failedProfiles == [] and .holds == []' "$TMP/status.json" >/dev/null ||
    fail "The photos have failed sets or holds: $(jq -c '{failedProfiles, holds}' "$TMP/status.json")."
}

# Fails unless each set in <sets>, media_sets' lines, has its #10
# manifest.json in the data root, naming the w800 WebP the line's URL serves.
require_manifests() {
  local path photo url set
  while read -r path photo url; do
    set=${url#/media/}
    set=${set%/w800.webp}
    in_watcher cat "/data/portfolio/assets/$set/manifest.json" </dev/null >"$TMP/manifest.json" ||
      fail "The set of $path, $set, has no manifest.json."
    jq -e '.variants.w800.webp.sha256 | test("^[0-9a-f]{64}$")' "$TMP/manifest.json" >/dev/null ||
      fail "The manifest.json of $path's set records no w800 WebP: $(cat "$TMP/manifest.json")"
  done <"$1"
}

# 9. Back up, the watcher builds every set, each with its manifest.json, and
#    its heartbeat stays fresh and says it writes no legacy derivatives.
compose up -d --pull never --wait --wait-timeout 180 image-watcher
wait_for_sets "${#fixtures[@]}"
media_sets "$TMP/sets.txt"
require_manifests "$TMP/sets.txt"
age=$(jq -r '.watcher.ageSeconds // empty' "$TMP/status.json")
[ -n "$age" ] && [ "$age" -lt 120 ] || fail "The watcher's heartbeat is ${age:-missing} s old, expected under 120 s."
in_watcher cat /data/portfolio/status/watcher.json | jq -e '.legacyDerivatives == false' >/dev/null ||
  fail "The watcher's heartbeat does not say legacyDerivatives: false."
require_watcher_running
require_library_unchanged "$PHOTOS" "$TMP/listing-start.txt" "After the watcher built every set"
echo "The watcher built every /media set with its manifest.json, its heartbeat is ${age} s old with legacyDerivatives: false, and the library is unchanged."

# 9b. Watch mode picks up a photo added while it runs: it gets a set and its
#     manifest.json, and still nothing else in the library changes.
cp "ci/fixtures/library/${fixtures[0]}.jpg" "$PHOTOS/ci-added.jpg"
chmod a+r "$PHOTOS/ci-added.jpg"
library_listing "$PHOTOS" >"$TMP/listing-added.txt" || fail "Could not list the library."
wait_for_sets "$((${#fixtures[@]} + 1))"
media_sets "$TMP/sets.txt"
grep -q '^ci-added\.jpg ' "$TMP/sets.txt" || fail "The watcher built no set for ci-added.jpg: $(cat "$TMP/sets.txt")"
require_manifests "$TMP/sets.txt"
require_watcher_running
require_library_unchanged "$PHOTOS" "$TMP/listing-added.txt" "After the watcher picked up ci-added.jpg"
echo "The watcher picked up ci-added.jpg and built its set and manifest.json without restarting or writing the library."

# 10. Nothing is active yet, so /media serves none of the sets, #6's Home
#     records endpoint answers 503 with not-published for each photo, and an
#     original 404s.
[ "$(wc -l <"$TMP/sets.txt")" -eq "$((${#fixtures[@]} + 1))" ] || fail "Expected a set per photo, got: $(cat "$TMP/sets.txt")"
no_revision=rev_$(printf '0%.0s' {1..64})
while read -r path photo url; do
  code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$BASE_URL$url") || fail "GET $url failed."
  [ "$code" = 404 ] || fail "GET $url, the set of $path, returned $code before the first activation, expected 404."
  tr -d '\r' <"$TMP/headers.txt" | grep -qix 'cache-control: no-store' || fail "The 404 for $url did not send Cache-Control: no-store."
  expect_json "/api/catalog/home/series/ser_smoke/photos/$photo?revision=$no_revision" 503 no-store '. == {reason: "not-published"}'
done <"$TMP/sets.txt"
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$BASE_URL/assets/photos/${fixtures[0]}.jpg") ||
  fail "GET /assets/photos/${fixtures[0]}.jpg failed."
[ "$code" = 404 ] || fail "GET /assets/photos/${fixtures[0]}.jpg, an original, returned $code, expected 404."
echo "/media served none of the sets before the first activation, the #6 Home records endpoint answered 503 with not-published for each photo, and the original returned 404."

# 11. Recreated containers keep every photo ID, /media URL, and set.
set_digests "$TMP/sets.txt" "$TMP/before.txt"
compose down
compose up -d --pull never --wait --wait-timeout 180 "${services[@]}"
check_health
[ "$HEALTH" = ready ] || fail "GET /api/health reported dataRoot '$HEALTH' after the restart, expected ready."
media_sets "$TMP/sets-after.txt"
set_digests "$TMP/sets-after.txt" "$TMP/after.txt"
if ! diff -u "$TMP/before.txt" "$TMP/after.txt"; then
  fail "The photo IDs, /media URLs, or set digests changed when the containers were recreated."
fi
require_watcher_running
require_library_unchanged "$PHOTOS" "$TMP/listing-added.txt" "After the containers were recreated"
echo "After the containers were recreated, every photo kept its ID, /media URL, and set, and the library was unchanged."

# 12. With PHOTOGRAPHY_DATA_DIR unset, the image's watcher has nothing to do,
#     since it writes nothing but the data root: it exits 1, names the
#     variable, and writes nothing, in the library or anywhere else. The image
#     sets no default, so nothing names a data root. The library is mounted
#     read-write here, so only the watcher itself keeps it unchanged.
library_listing "$UNSET" >"$TMP/listing-unset.txt" || fail "Could not list $UNSET."
set +e
docker run --rm --pull never --user 1001:1001 -e PHOTOGRAPHY_LIBRARY_DIR=/data/library -v "$UNSET:/data/library" "$IMAGE" \
  node dist/scripts/imageWatcher.mjs --once >"$TMP/unset.log" 2>&1
code=$?
set -e
[ "$code" = 1 ] || { cat "$TMP/unset.log"; fail "The watcher with PHOTOGRAPHY_DATA_DIR unset exited $code, expected 1."; }
grep -q 'PHOTOGRAPHY_DATA_DIR is not set, and the watcher writes nothing but the data root' "$TMP/unset.log" || {
  cat "$TMP/unset.log"
  fail "The watcher with PHOTOGRAPHY_DATA_DIR unset did not say why it exited."
}
require_library_unchanged "$UNSET" "$TMP/listing-unset.txt" "With PHOTOGRAPHY_DATA_DIR unset"
echo "With PHOTOGRAPHY_DATA_DIR unset, the watcher exited 1, said why, and wrote nothing."

# 13. A v1.7.0 image on v1.6's compose file: the library at its old path,
#     /app/public/assets/photos, and no PHOTOGRAPHY_LIBRARY_DIR. The watcher
#     and the CLI exit 1 naming the variable, and never read the old path,
#     so no pass sees an empty or wrong folder and writes nothing.
mkdir "$TMP/old-path-data"
hand_to_image "$TMP/old-path-data"
for command in "node dist/scripts/imageWatcher.mjs --once" "node dist/scripts/photos.mjs migrate --dry-run"; do
  set +e
  # shellcheck disable=SC2086 # the command is ours, split on purpose
  docker run --rm --pull never --user 1001:1001 -e PHOTOGRAPHY_DATA_DIR=/data/portfolio \
    -v "$UNSET:/app/public/assets/photos" -v "$TMP/old-path-data:/data/portfolio" "$IMAGE" $command >"$TMP/old-path.log" 2>&1
  code=$?
  set -e
  [ "$code" = 1 ] || { cat "$TMP/old-path.log"; fail "'$command' with PHOTOGRAPHY_LIBRARY_DIR unset exited $code, expected 1."; }
  grep -q 'PHOTOGRAPHY_LIBRARY_DIR is not set. Point it at the photo library: /data/library' "$TMP/old-path.log" || {
    cat "$TMP/old-path.log"
    fail "'$command' with PHOTOGRAPHY_LIBRARY_DIR unset did not name the variable."
  }
done
# Listed as its owner, uid 1001, since the runner's user may not read a root that is 0700 to it.
old_path_entries=$(docker run --rm --pull never --network none --user 1001:1001 --entrypoint ls -v "$TMP/old-path-data:/d:ro" "$IMAGE" -A /d) ||
  fail "Could not list the old-path data root as uid 1001."
[ -z "$old_path_entries" ] || fail "With PHOTOGRAPHY_LIBRARY_DIR unset, something wrote the data root: $old_path_entries"
require_library_unchanged "$UNSET" "$TMP/listing-unset.txt" "With PHOTOGRAPHY_LIBRARY_DIR unset"
echo "With PHOTOGRAPHY_LIBRARY_DIR unset and the library at its old path, the watcher and photos.mjs exited 1 naming the variable, and wrote nothing."
