#!/usr/bin/env bash
# The /media smoke test, `npm run smoke:media`. Generates a fixture library
# and an empty data root in a temp folder, migrates them, builds every set
# with the watcher's --once, and serves .next/standalone on them with
# PHOTOGRAPHY_MEDIA_ACCESS=all. Checks that a set is served with 200,
# `immutable`, and an ETag of its bytes, that the ETag gets 304, that a
# malformed URL gets a `no-store` 404, and that a photo added while the
# server runs is served once --once builds it, with no restart.
#
#   npm run build && npm run smoke:media
#
# Never touches the real library or data root. SMOKE_MEDIA_PORT picks the
# port on 127.0.0.1, 3940 by default.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT=${SMOKE_MEDIA_PORT:-3940}
BASE_URL=http://127.0.0.1:$PORT
TMP=$(mktemp -d)
export PHOTOGRAPHY_LIBRARY_DIR=$TMP/library
export PHOTOGRAPHY_DATA_DIR=$TMP/data
SERVER_PID=

fail() {
  echo "::error::$1"
  exit 1
}

cleanup() {
  status=$?
  set +e
  if [ -n "$SERVER_PID" ]; then
    if [ "$status" -ne 0 ]; then
      echo "Smoke test failed. Server log:"
      cat "$TMP/server.log"
    fi
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

run_once() {
  npx tsx scripts/imageWatcher.ts --once >"$TMP/once.log" 2>&1 || {
    cat "$TMP/once.log"
    fail "$1: --once exited non-zero."
  }
}

# The /media URL of the w800 WebP in the ready set of the photo at <library path>, from the registry's
# newest version file, identity/registry/v<N>.json.
media_url() {
  node -e '
    const fs = require("fs");
    const versions = fs.readdirSync(process.argv[1]).map((name) => /^v([1-9][0-9]*)\.json$/.exec(name)).filter(Boolean).map((match) => Number(match[1]));
    if (versions.length === 0) process.exit(1);
    const registry = JSON.parse(fs.readFileSync(`${process.argv[1]}/v${Math.max(...versions)}.json`, "utf8"));
    const photo = Object.values(registry.photos).find((candidate) => candidate.source.path === process.argv[2]);
    const revision = photo && photo.revisions[photo.source.observedRevision];
    const ready = revision ? Object.keys(revision.profiles).filter((id) => revision.profiles[id].state === "ready") : [];
    if (ready.length !== 1) process.exit(1);
    console.log(["", "media", photo.photoId, revision.assetRevision, ready[0], "w800.webp"].join("/"));
  ' "$PHOTOGRAPHY_DATA_DIR/identity/registry" "$1"
}

[ -f .next/standalone/server.js ] || fail "There is no .next/standalone/server.js. Run npm run build first."
if curl -s --max-time 2 -o /dev/null "$BASE_URL/"; then
  fail "Something already answers on $BASE_URL. Set SMOKE_MEDIA_PORT to a free port."
fi

# 1. A fixture library and an empty data root, migrated the way the runbook does it.
npx tsx test/fixtures/makeLibrary.ts "$PHOTOGRAPHY_LIBRARY_DIR" >/dev/null
mkdir -m 700 "$PHOTOGRAPHY_DATA_DIR"
plan=$(npx tsx scripts/photos.ts migrate --dry-run | sed -n 's/^Plan: //p')
[ -n "$plan" ] || fail "The dry run printed no plan."
npx tsx scripts/photos.ts migrate --apply --plan "$plan" >/dev/null || fail "migrate --apply failed."
echo "Migrated the fixture library."

# 2. --once builds every set.
run_once "The first run"
for photo in landscape.jpg portrait.png square.webp; do
  media_url "$photo" >/dev/null || fail "$photo has no ready set after --once."
done
echo "--once built a set for each fixture."

# 3. The server reads the data root at each request.
(
  cd .next/standalone
  PORT=$PORT HOSTNAME=127.0.0.1 PHOTOGRAPHY_MEDIA_ACCESS=all exec node server.js
) >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
deadline=$((SECONDS + 60))
until curl -s --max-time 5 -o /dev/null "$BASE_URL/"; do
  [ "$SECONDS" -lt "$deadline" ] || fail "The server did not answer within 60s."
  sleep 1
done

# 4. 200 with immutable, an ETag of the bytes, and 304 for that ETag.
url=$(media_url landscape.jpg)
code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o "$TMP/body" -w '%{http_code}' "$BASE_URL$url") || fail "GET $url failed."
[ "$code" = 200 ] || fail "GET $url returned $code, expected 200."
# The value of header <name> in the last response's headers, or nothing.
header() {
  tr -d '\r' <"$TMP/headers.txt" | { grep -i "^$1:" || true; } | head -1 | sed 's/^[^:]*: *//'
}
[ "$(header cache-control)" = 'public, max-age=31536000, immutable' ] || fail "GET $url sent Cache-Control: $(header cache-control)."
[ "$(header content-type)" = image/webp ] || fail "GET $url sent Content-Type: $(header content-type)."
etag=$(header etag)
digest=$(node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$TMP/body")
[ "$etag" = "\"$digest\"" ] || fail "GET $url sent ETag $etag, but its bytes hash to $digest."
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$BASE_URL$url") || fail "The conditional GET failed."
[ "$code" = 304 ] || fail "GET $url with If-None-Match returned $code, expected 304."
echo "/media served a set with immutable and its ETag, and answered 304 to that ETag."

# 5. A malformed URL gets a 404 nothing caches.
code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$BASE_URL/media/not-a-photo/x/y/w800.webp") || fail "GET of a malformed /media URL failed."
[ "$code" = 404 ] || fail "A malformed /media URL returned $code, expected 404."
[ "$(header cache-control)" = no-store ] || fail "The 404 sent Cache-Control: $(header cache-control)."
echo "A malformed /media URL returned a no-store 404."

# 6. A photo added while the server runs, in a nested folder, is served once built.
npx tsx test/fixtures/makeLibrary.ts "$TMP/extras" --extras >/dev/null
mkdir "$PHOTOGRAPHY_LIBRARY_DIR/later"
cp "$TMP/extras/landscape-edited.jpg" "$PHOTOGRAPHY_LIBRARY_DIR/later/added.jpg"
run_once "After adding later/added.jpg"
added=$(media_url later/added.jpg) || fail "later/added.jpg has no ready set after --once."
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' "$BASE_URL$added") || fail "GET $added failed."
[ "$code" = 200 ] || fail "GET $added, built after the server started, returned $code, expected 200."
echo "/media served a set built after the server started, with no restart."
echo "smoke:media passed."
