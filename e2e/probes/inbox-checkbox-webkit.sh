#!/bin/sh
# A one-off CI probe, never merged: build this checkout and measure the Inbox row checkbox in WebKit
# with e2e/probes/inbox-checkbox-webkit.ts, writing <out-dir>/v2-f4-webkit.json and its PNGs.
#
#   sh e2e/probes/inbox-checkbox-webkit.sh <out-dir>         build, then measure
#   sh e2e/probes/inbox-checkbox-webkit.sh <out-dir> --dry   on a build already made: the fixture, the server and one
#                                                            request, then stop before the measure
#
# Every temp dir goes under a fresh TMPDIR in $RUNNER_TEMP, or the system's temp elsewhere, never inside the checkout:
# the stand-in portrait is written only under os.tmpdir(), and a test catalog only outside the repository. The server
# listens on 127.0.0.1 only. Nothing here deletes anything.
set -eu

if [ "$#" -lt 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 <out-dir> [--dry]" >&2
  exit 2
fi
OUT=$1
MODE=${2:-}

cd "$(dirname "$0")/../.."
CHECKOUT=$(pwd -P)
BASE=${RUNNER_TEMP:-${TMPDIR:-/tmp}}
TMPDIR=$(mktemp -d "${BASE%/}/v2-f4-webkit.XXXXXX")
export TMPDIR
case "$(cd "$TMPDIR" && pwd -P)/" in
  "$CHECKOUT"/*) echo "TMPDIR $TMPDIR is inside the checkout $CHECKOUT" >&2; exit 1 ;;
esac
SITE_CONFIG=$(mktemp -d "$TMPDIR/site-config.XXXXXX")
EMPTY_LIBRARY=$(mktemp -d "$TMPDIR/empty-library.XXXXXX")
mkdir -p "$OUT"
export ALLOW_PROVISIONAL_COPY=1
export E2E_SITE_CONFIG_DIR="$SITE_CONFIG"
unset GIT_EDITOR || true
echo "TMPDIR: $TMPDIR"

npx tsx e2e/support/write-site-config.ts "$SITE_CONFIG"
ls -l "$SITE_CONFIG/about"

if [ "$MODE" = "--dry" ]; then
  [ -f .next/BUILD_ID ] || { echo "--dry needs a build already made in $CHECKOUT" >&2; exit 1; }
  echo "dry run: using the build already in $CHECKOUT/.next"
  PROBE_DRY=1 npx tsx e2e/probes/inbox-checkbox-webkit.ts "$OUT/v2-f4-webkit.json"
  exit 0
fi

PHOTOGRAPHY_LIBRARY_DIR="$EMPTY_LIBRARY" PHOTOGRAPHY_SITE_CONFIG_DIR="$SITE_CONFIG" npm run build
echo "build ok"
npx tsx e2e/probes/inbox-checkbox-webkit.ts "$OUT/v2-f4-webkit.json"
