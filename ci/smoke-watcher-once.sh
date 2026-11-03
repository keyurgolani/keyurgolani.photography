#!/usr/bin/env bash
# Checks that the built image ships the bundled scripts and no dev
# dependencies, then runs its watcher with --once against a generated
# fixture library, mounted read-only at /data/library as
# docker-compose.prod.yml mounts it, on a migrated data root. It builds a
# /media set, with its manifest.json, for every photo, writes nothing in the
# library (since v1.7.0, #13's slice E, no legacy derivative either), deletes
# nothing once a photo is removed, and says legacyDerivatives: false in its
# heartbeat. It exits 1 on a missing library or an unset
# PHOTOGRAPHY_LIBRARY_DIR, and 2 on --force. Then it starts the web server
# twice, on an empty data root, as a host has before the migration, and with
# no data root at all, each with a v1.6 host's library, legacy derivatives
# and all, under its public/ folder, where Next would serve it. Neither has
# published anything, so each answers the catalog's unavailable state:
# /api/ready and a #6 catalog endpoint 503 with not-published. The legacy
# derivatives never serve (#13's slice E), directly or through /_next/image,
# and neither do the original sources, the removed endpoints, /api/photos
# among them, and /gallery is a 308 to /work. ci/smoke-catalog.sh checks a
# published catalog.
#
#   IMAGE=ghcr.io/keyurgolani/keyurgolani.photography:ci-smoke ci/smoke-watcher-once.sh
#
# $IMAGE must already exist locally, since nothing pulls here. The image
# generates the library itself with this checkout's
# test/fixtures/makeLibrary.ts, which its node runs with the types stripped,
# so the runner needs no Node and no fixture binaries are committed.
# WATCHER_CMD overrides the watcher command. Binds a random port on 127.0.0.1.
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE=${IMAGE:-ghcr.io/keyurgolani/keyurgolani.photography:ci-smoke}
WATCHER_CMD=${WATCHER_CMD:-node dist/scripts/imageWatcher.mjs}
read -r -a WATCHER <<<"$WATCHER_CMD"

TMP=$(mktemp -d)
LIB=$TMP/library
# The watcher's data root, which the migration initializes.
ROOT=$TMP/root
# A v1.6 host's library: the photos and their legacy derivatives, for web.
PUBLIC=$TMP/public-photos
DATA=$TMP/data
WEB=photography-smoke-watcher-$$
WEB_STARTED=false
UNSET=photography-smoke-watcher-unset-$$
UNSET_STARTED=false
# The body of /_next/image's 400 for a url images.localPatterns doesn't allow.
NOT_ALLOWED='"url" parameter is not allowed'
OUTPUTS=(
  thumbnails/%s.webp medium/%s.webp optimized/%s.webp
  thumbnails-avif/%s.avif medium-avif/%s.avif optimized-avif/%s.avif
  lqip/%s.txt
)
LEGACY_FOLDERS=(thumbnails medium optimized thumbnails-avif medium-avif optimized-avif lqip cache)

fail() {
  echo "::error::$1"
  exit 1
}

cleanup() {
  status=$?
  set +e
  if [ "$WEB_STARTED" = true ]; then
    if [ "$status" -ne 0 ]; then
      echo "Smoke test failed. Web container logs:"
      docker logs "$WEB"
    fi
    docker rm -f "$WEB" >/dev/null
  fi
  if [ "$UNSET_STARTED" = true ]; then
    if [ "$status" -ne 0 ]; then
      echo "Web container (no data root) logs:"
      docker logs "$UNSET"
    fi
    docker rm -f "$UNSET" >/dev/null
  fi
  # The image wrote the library and the data root as uid 1001. Remove them
  # with the image under test, so cleanup never pulls anything.
  docker run --rm --pull never --user 0 --entrypoint rm -v "$TMP:/t" "$IMAGE" -rf /t/library /t/root /t/public-photos
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

# Runs a command in the image as image-watcher does: the library read-only at
# /data/library, and the data root read-write.
in_watcher() {
  docker run --rm --pull never -e PHOTOGRAPHY_LIBRARY_DIR=/data/library -e PHOTOGRAPHY_DATA_DIR=/data/portfolio \
    -v "$LIB:/data/library:ro" -v "$ROOT:/data/portfolio" "$IMAGE" "$@"
}

run_once() {
  in_watcher "${WATCHER[@]}" --once
}

# Prints every file and folder under the library, sorted, with each file's
# size, mtime, and SHA-256, so two equal listings mean nothing changed.
library_listing() {
  (
    cd "$LIB" || exit 1
    find . -mindepth 1 -printf '%P %y %s %T@\n' | LC_ALL=C sort
    find . -type f -print0 | LC_ALL=C sort -z | xargs -0 -r sha256sum
  )
}

# Fails unless the library lists exactly as <listing file> does, and holds no legacy folder.
require_library_unchanged() {
  local folder
  library_listing >"$TMP/listing-now.txt" || fail "Could not list the library."
  diff -u "$1" "$TMP/listing-now.txt" || fail "$2: the watcher changed the library, which it must never write."
  for folder in "${LEGACY_FOLDERS[@]}"; do
    [ ! -e "$LIB/$folder" ] || fail "$2: the library has a $folder/ folder, which the watcher no longer writes."
  done
}

# Writes the seven legacy derivatives of <base> into $PUBLIC, from any bytes.
plant_outputs() {
  local base=$1 pattern output
  for pattern in "${OUTPUTS[@]}"; do
    # shellcheck disable=SC2059 # the pattern is ours, with one %s
    output=$(printf "$pattern" "$base")
    mkdir -p "$PUBLIC/$(dirname "$output")"
    printf 'legacy %s from v1.6\n' "$output" >"$PUBLIC/$output"
  done
}

# Writes each photo's ready set and the sha256 of its manifest.json to <file>, from the registry.
set_manifests() {
  # shellcheck disable=SC2016 # the ${...} are JavaScript template strings
  in_watcher node -e '
    const fs = require("fs");
    const dir = "/data/portfolio/identity/registry";
    const newest = Math.max(...fs.readdirSync(dir).map((name) => Number((/^v([1-9][0-9]*)\.json$/.exec(name) || [])[1] || 0)));
    const registry = JSON.parse(fs.readFileSync(`${dir}/v${newest}.json`, "utf8"));
    const crypto = require("crypto");
    const lines = [];
    for (const photo of Object.values(registry.photos)) {
      const revision = photo.revisions[photo.source.observedRevision];
      const ready = Object.entries(revision.profiles).filter(([, profile]) => profile.state === "ready").map(([id]) => id);
      if (ready.length !== 1) throw new Error(`${photo.source.path} has ${ready.length} ready sets, expected 1`);
      const manifest = `/data/portfolio/assets/${photo.photoId}/${revision.assetRevision}/${ready[0]}/manifest.json`;
      const bytes = fs.readFileSync(manifest);
      if (!JSON.parse(bytes).variants.w800.webp) throw new Error(`${manifest} names no w800 WebP`);
      lines.push(`${photo.source.path} ${photo.photoId} ${crypto.createHash("sha256").update(bytes).digest("hex")}`);
    }
    console.log(lines.sort().join("\n"));' >"$1" || fail "Could not read a manifest.json for every photo's set."
}

# 0. The image runs the watcher and the CLIs from their bundles, and carries
#    none of package.json's devDependencies, tsx among them, and none of the
#    sources the bundles are built from.
problems=$(docker run --rm --pull never "$IMAGE" node -e '
  const fs = require("fs");
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const problems = [];
  for (const name of new Set(["tsx", ...Object.keys(pkg.devDependencies || {})])) {
    if (fs.existsSync("node_modules/" + name)) problems.push("node_modules/" + name);
  }
  for (const source of ["scripts", "utils", "lib", "tsconfig.json"]) {
    if (fs.existsSync(source)) problems.push(source);
  }
  for (const script of ["imageWatcher", "photos", "watcherHealth"]) {
    if (!fs.existsSync("dist/scripts/" + script + ".mjs")) problems.push("no dist/scripts/" + script + ".mjs");
  }
  console.log(problems.join(", "));
') || fail "Listing what $IMAGE ships failed."
[ -z "$problems" ] || fail "The image should ship only the bundled scripts and runtime packages, but has: $problems."
echo "The image ships dist/scripts and no dev dependencies, tsx, or script sources."

# 1. A library generated by the image under test with this checkout's
#    fixtures mounted read-only, and a data root uid 1001 can write, which
#    the migration initializes as docs/data-root.md runs it.
mkdir "$LIB" "$ROOT"
chmod 777 "$LIB" "$ROOT"
docker run --rm --pull never -v "$PWD/test/fixtures:/app/test/fixtures:ro" -v "$LIB:/library" \
  "$IMAGE" node test/fixtures/makeLibrary.ts /library || fail "Generating the fixture library in $IMAGE failed."
for base in landscape portrait square; do
  compgen -G "$LIB/$base.*" >/dev/null || fail "The fixture library has no $base photo."
done
dry_run=$(in_watcher node dist/scripts/photos.mjs migrate --dry-run) || fail "The migration dry run failed: $dry_run"
plan=$(sed -n 's/^Plan: //p' <<<"$dry_run")
[ -n "$plan" ] || fail "The dry run printed no plan: $dry_run"
in_watcher node dist/scripts/photos.mjs migrate --apply --plan "$plan" >/dev/null || fail "Applying $plan failed."
library_listing >"$TMP/listing-start.txt" || fail "Could not list the library."

# 2. --once builds a set, with its manifest.json, for each fixture, says
#    legacyDerivatives: false, and writes nothing in the library.
echo "Running ${WATCHER_CMD} --once in $IMAGE."
run_once || fail "The first --once run exited non-zero."
set_manifests "$TMP/manifests-first.txt"
[ "$(wc -l <"$TMP/manifests-first.txt")" -eq 3 ] || fail "Expected a set with a manifest.json for each of the 3 fixtures, got: $(cat "$TMP/manifests-first.txt")"
in_watcher cat /data/portfolio/status/watcher.json | jq -e '.legacyDerivatives == false and .lastPassResult == "committed"' >/dev/null ||
  fail "The heartbeat after --once does not say legacyDerivatives: false after a committed pass."
require_library_unchanged "$TMP/listing-start.txt" "After the first --once run"
echo "--once built a set and manifest.json for each fixture, and wrote nothing in the library."

# 3. With a source gone, another --once run keeps every set and manifest.
# The image wrote it as uid 1001, so force the removal and check it took.
rm -f "$LIB"/landscape.*
compgen -G "$LIB/landscape.*" >/dev/null && fail "Could not remove landscape from the fixture library."
library_listing >"$TMP/listing-removed.txt" || fail "Could not list the library."
run_once || fail "The second --once run exited non-zero."
set_manifests "$TMP/manifests-second.txt"
diff -u "$TMP/manifests-first.txt" "$TMP/manifests-second.txt" || fail "A set or its manifest.json changed or went once landscape was removed."
require_library_unchanged "$TMP/listing-removed.txt" "After removing landscape"
echo "--once kept every set and manifest.json after landscape was removed."

# 4. A missing library root, and an unset PHOTOGRAPHY_LIBRARY_DIR with the
#    library at its old path, exit 1 and name the problem, and --force,
#    which rebuilt the legacy derivatives, exits 2.
expect_exit() {
  local expected=$1 message=$2 code
  shift 2
  set +e
  "$@" >"$TMP/exit.log" 2>&1
  code=$?
  set -e
  [ "$code" -eq "$expected" ] || { cat "$TMP/exit.log"; fail "'$*' exited $code, expected $expected."; }
  grep -qF "$message" "$TMP/exit.log" || { cat "$TMP/exit.log"; fail "'$*' did not say: $message"; }
}
expect_exit 1 'Library root not found: /tmp/missing-library' \
  docker run --rm --pull never -e PHOTOGRAPHY_LIBRARY_DIR=/tmp/missing-library -e PHOTOGRAPHY_DATA_DIR=/data/portfolio -v "$ROOT:/data/portfolio" "$IMAGE" "${WATCHER[@]}" --once
expect_exit 1 'PHOTOGRAPHY_LIBRARY_DIR is not set. Point it at the photo library: /data/library' \
  docker run --rm --pull never -e PHOTOGRAPHY_DATA_DIR=/data/portfolio -v "$LIB:/app/public/assets/photos:ro" -v "$ROOT:/data/portfolio" "$IMAGE" "${WATCHER[@]}" --once
expect_exit 2 '--force rebuilt the legacy derivatives, which the watcher no longer writes' run_once --force
set_manifests "$TMP/manifests-third.txt"
diff -u "$TMP/manifests-first.txt" "$TMP/manifests-third.txt" || fail "A refused run changed a set."
require_library_unchanged "$TMP/listing-removed.txt" "After the refused runs"
echo "--once exited 1 on a missing library and on an unset PHOTOGRAPHY_LIBRARY_DIR, 2 on --force, and changed nothing."

# The v1.6 host's library web gets under public/: the fixtures, and the
# legacy derivatives a v1.6 watcher wrote for each, so a 404 for one proves
# that the proxy refuses a file Next would otherwise serve.
mkdir "$PUBLIC"
cp "$LIB"/* "$PUBLIC/"
for base in portrait square landscape; do
  plant_outputs "$base"
done
chmod -R a+rX "$PUBLIC"

# Sets WEB_URL to container $1's port 3000 on 127.0.0.1, once /api/health
# answers 200. GET / is #21's error page until a catalog is published.
wait_for_web() {
  local address deadline
  address=$(docker port "$1" 3000/tcp)
  address=${address%%$'\n'*}
  WEB_URL=http://127.0.0.1:${address##*:}
  deadline=$((SECONDS + 60))
  until [ "$(curl -s --max-time 5 -o /dev/null -w '%{http_code}' "$WEB_URL/api/health")" = 200 ]; do
    [ "$SECONDS" -lt "$deadline" ] || fail "GET /api/health on $1 did not return 200 within 60s."
    sleep 1
  done
}

# Fails unless <method> <url> answers <code>, with Cache-Control: no-store when <no-store> is yes.
expect_code() {
  local method=$1 url=$2 expected=$3 no_store=${4:-no} code
  code=$(curl -sS --max-time 30 -X "$method" -D "$TMP/headers.txt" -o "$TMP/body.txt" -w '%{http_code}' "$url") || fail "$method $url failed."
  [ "$code" = "$expected" ] || fail "$method $url returned $code, expected $expected."
  if [ "$no_store" = yes ]; then
    tr -d '\r' <"$TMP/headers.txt" | grep -qix 'cache-control: no-store' || fail "The $code for $url did not send Cache-Control: no-store."
  fi
}

# The checks on web at <base>, named <label>, which has published nothing.
check_unpublished() {
  local base=$1 label=$2 asset url
  # The removed endpoints, the legacy photo list among them.
  expect_code POST "$base/api/photos/optimize" 404
  expect_code GET "$base/api/image?src=portrait.png" 404
  expect_code GET "$base/api/photos" 404
  # The catalog's unavailable state: /api/ready and a #6 endpoint answer 503 with not-published.
  expect_code GET "$base/api/ready" 503 yes
  jq -e '. == {mode: "catalog", state: "unavailable", revisionId: null, revisionNumber: null, activatedAt: null, reason: "not-published"}' "$TMP/body.txt" >/dev/null ||
    fail "GET /api/ready $label returned $(cat "$TMP/body.txt"), expected not-published with no revision."
  expect_code GET "$base/api/catalog/home/series/ser_smoke/photos/ph_00000000-0000-4000-8000-000000000001?revision=rev_$(printf '0%.0s' {1..64})" 503 yes
  jq -e '. == {reason: "not-published"}' "$TMP/body.txt" >/dev/null || fail "The #6 Home records endpoint $label returned $(cat "$TMP/body.txt"), expected not-published."
  # /gallery is Work's now, in every state.
  expect_code GET "$base/gallery" 308
  tr -d '\r' <"$TMP/headers.txt" | grep -qix 'location: /work' || fail "GET /gallery $label did not send Location: /work."
  # The derivatives the watcher wrote, and the originals, 404 with no-store.
  # Each is on disk, so its 404 proves something: a renamed fixture fails here instead of passing.
  for asset in optimized/portrait.webp thumbnails-avif/square.avif lqip/landscape.txt portrait.png square.webp portrait%2Epng; do
    [ -s "$PUBLIC/${asset//%2E/.}" ] || fail "The library holds no $asset, so its 404 $label would prove nothing."
    expect_code GET "$base/assets/photos/$asset" 404 yes
  done
  # /_next/image refuses them with its own 400, before its cache can answer.
  for url in %2Fassets%2Fphotos%2Foptimized%2Fportrait.webp %2Fassets%2Fphotos%2Fthumbnails-avif%2Fsquare.avif %2Fassets%2Fphotos%2Fportrait.png; do
    expect_code GET "$base/_next/image?url=$url&w=400&q=75" 400 yes
    [ "$(cat "$TMP/body.txt")" = "$NOT_ALLOWED" ] ||
      fail "GET /_next/image?url=$url $label answered 400 with '$(cat "$TMP/body.txt")', expected '$NOT_ALLOWED'."
  done
}

# 5. The web server, with a v1.6 host's library, legacy derivatives and all,
#    under its public/ folder, and an empty data root mounted read-only where
#    production mounts it, as before the migration. Production's web mounts
#    no library at all since v1.7.0. This one does, so a file Next would serve
#    from public/ is there to be refused.
mkdir "$DATA"
chmod 755 "$DATA"
docker run -d --pull never --name "$WEB" -p 127.0.0.1::3000 -e PHOTOGRAPHY_DATA_DIR=/data/portfolio \
  -v "$PUBLIC:/app/public/assets/photos:ro" -v "$DATA:/data/portfolio:ro" "$IMAGE" >/dev/null
WEB_STARTED=true
wait_for_web "$WEB"
check_unpublished "$WEB_URL" "on an empty data root"
echo "On an empty data root, /api/ready and the #6 endpoint answer 503 not-published, /api/photos and the removed endpoints 404, /gallery is a 308 to /work, and the derivatives and originals return 404, and 400 through /_next/image."

# 6. With no data root at all, the same answers.
docker run -d --pull never --name "$UNSET" -p 127.0.0.1::3000 -v "$PUBLIC:/app/public/assets/photos:ro" "$IMAGE" >/dev/null
UNSET_STARTED=true
wait_for_web "$UNSET"
check_unpublished "$WEB_URL" "with no data root"
echo "With no data root, the same."
