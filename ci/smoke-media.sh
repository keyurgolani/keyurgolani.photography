#!/usr/bin/env bash
# The /media smoke test, `npm run smoke:media`. Publishes a small test
# catalog into an empty data root in a temp folder with
# ci/publish-fixture.ts, and serves .next/standalone on it. Checks that a set
# the active revision holds is served with 200, `immutable`, and an ETag of
# its bytes, that the ETag gets 304, that a set whose files exist but which
# no revision holds gets a `no-store` 404, as does a malformed URL, and that
# /api/ready names the revision.
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

# Field <name> of the JSON in file <file>.
field() {
  node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))[process.argv[2]] ?? "")' "$1" "$2"
}

[ -f .next/standalone/server.js ] || fail "There is no .next/standalone/server.js. Run npm run build first."
if curl -s --max-time 2 -o /dev/null "$BASE_URL/"; then
  fail "Something already answers on $BASE_URL. Set SMOKE_MEDIA_PORT to a free port."
fi

# 1. A published test catalog, with an empty library beside it.
mkdir -p "$PHOTOGRAPHY_LIBRARY_DIR"
npx tsx ci/publish-fixture.ts "$PHOTOGRAPHY_DATA_DIR" >"$TMP/fixture.json" || fail "ci/publish-fixture.ts failed."
revision=$(field "$TMP/fixture.json" revisionId)
active=$(field "$TMP/fixture.json" active)
inactive=$(field "$TMP/fixture.json" inactive)
[ -n "$revision" ] && [ -n "$active" ] && [ -n "$inactive" ] || fail "ci/publish-fixture.ts printed no revision or URLs."
echo "Published $revision."

# 2. The server reads the data root at each request.
(
  cd .next/standalone
  PORT=$PORT HOSTNAME=127.0.0.1 exec node server.js
) >"$TMP/server.log" 2>&1 &
SERVER_PID=$!
deadline=$((SECONDS + 60))
until curl -s --max-time 5 -o /dev/null "$BASE_URL/api/health"; do
  [ "$SECONDS" -lt "$deadline" ] || fail "The server did not answer within 60s."
  sleep 1
done

# The value of header <name> in the last response's headers, or nothing.
header() {
  tr -d '\r' <"$TMP/headers.txt" | { grep -i "^$1:" || true; } | head -1 | sed 's/^[^:]*: *//'
}

# 3. /api/ready names the revision.
code=$(curl -sS --max-time 30 -o "$TMP/ready.json" -w '%{http_code}' "$BASE_URL/api/ready") || fail "GET /api/ready failed."
[ "$code" = 200 ] || fail "GET /api/ready returned $code, expected 200."
[ "$(field "$TMP/ready.json" revisionId)" = "$revision" ] || fail "GET /api/ready names $(field "$TMP/ready.json" revisionId), expected $revision."
echo "/api/ready names $revision."

# 4. 200 with immutable, an ETag of the bytes, and 304 for that ETag.
code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o "$TMP/body" -w '%{http_code}' "$BASE_URL$active") || fail "GET $active failed."
[ "$code" = 200 ] || fail "GET $active returned $code, expected 200."
[ "$(header cache-control)" = 'public, max-age=31536000, immutable' ] || fail "GET $active sent Cache-Control: $(header cache-control)."
[ "$(header content-type)" = image/webp ] || fail "GET $active sent Content-Type: $(header content-type)."
etag=$(header etag)
digest=$(node -e 'console.log(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("hex"))' "$TMP/body")
[ "$etag" = "\"$digest\"" ] || fail "GET $active sent ETag $etag, but its bytes hash to $digest."
code=$(curl -sS --max-time 30 -o /dev/null -w '%{http_code}' -H "If-None-Match: $etag" "$BASE_URL$active") || fail "The conditional GET failed."
[ "$code" = 304 ] || fail "GET $active with If-None-Match returned $code, expected 304."
echo "/media served a set the active revision holds, with immutable and its ETag, and answered 304 to that ETag."

# 5. A set no revision holds, and a malformed URL, get a 404 nothing caches.
for url in "$inactive" /media/not-a-photo/x/y/w800.webp; do
  code=$(curl -sS --max-time 30 -D "$TMP/headers.txt" -o /dev/null -w '%{http_code}' "$BASE_URL$url") || fail "GET $url failed."
  [ "$code" = 404 ] || fail "GET $url returned $code, expected 404."
  [ "$(header cache-control)" = no-store ] || fail "The 404 for $url sent Cache-Control: $(header cache-control)."
done
echo "A set no revision holds, and a malformed /media URL, returned no-store 404s."
echo "smoke:media passed."
