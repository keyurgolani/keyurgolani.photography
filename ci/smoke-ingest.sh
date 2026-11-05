#!/usr/bin/env bash
# The ingestion smoke test for a built image (#14 and #17, v2.0.0 A11), on a
# throwaway library and data root, with every command the image's own:
#
# 1. The image generates the fixture library from this checkout's
#    test/fixtures/makeLibrary.ts, and the extras beside it, outside the
#    library. `photos migrate` gives each photo its ID, the watcher's --once
#    run, with the library read-only at /data/library as
#    docker-compose.prod.yml mounts it, builds every set, and the owner's
#    commands publish the launch revision: draft:init, one series through
#    `photos edit`, its sequence, cover and order, Home's featured series,
#    the descriptions, and `publish --confirm-launch --expect`.
# 2. #14's inbox: one photo added, then --once and the bundled `curation`
#    commands. The pass records exactly one `new` item, for that photo, and
#    changes no other item. `curation show` reads it and `curation defer`
#    settles it for now, and a second --once records nothing: the inbox
#    lists the same, byte for byte.
# 3. #17's replacement: landscape.jpg gets other pixels in place. --once
#    builds the new bytes' set beside the published one, keeps every other
#    set, opens a replacement item, and writes nothing under catalog/, so the
#    pointer still names the launch revision. `photos status --check` passes:
#    a replacement waiting for `curation confirm` isn't a problem.
# 4. #17's missing source: landscape.jpg deleted from the temp library, as
#    the owner deleting it would. --once marks the photo missing, keeps both
#    its sets and every other, and writes nothing under catalog/.
#    `photos status --check` exits 1 with `missing-open` alone, naming that
#    photo, and `photos verify` passes the launch revision, whose sets are
#    all still whole.
#
#   ci/smoke-ingest.sh <tag>
#
# ghcr.io/keyurgolani/keyurgolani.photography:<tag> must already exist
# locally, since nothing pulls here. The checks need jq; the runner needs no
# Node. Nothing publishes a port. The temp root goes under $RUNNER_TEMP, the
# job's own temp folder in CI, or $TMPDIR elsewhere.
set -euo pipefail

if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: $0 <tag>" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

IMAGE=ghcr.io/keyurgolani/keyurgolani.photography:$1
TMP=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/photography-smoke-ingest.XXXXXX")
LIB=$TMP/library
# makeLibrary.ts's extras, outside the library: other pixels for landscape.jpg come from here.
EXTRAS=$TMP/extras
DATA=$TMP/data
# The owner's input files: the series record and the descriptions.
INPUT=$TMP/input
ACTOR=ci-smoke-ingest
SERIES=ser_smoke-ingest
# The photo the inbox step adds, from ci/fixtures/library.
ADDED=ci-added.jpg

# On stderr, so a failure inside a command substitution still shows.
fail() {
  echo "::error::$1" >&2
  exit 1
}

cleanup() {
  status=$?
  set +e
  # The containers wrote the library, the extras and the data root as the
  # image's user. Remove them with the image under test, so cleanup never pulls.
  docker run --rm --pull never --user 0 --entrypoint rm -v "$TMP:/t" "$IMAGE" -rf /t/library /t/extras /t/data /t/input
  rm -rf "$TMP"
  exit "$status"
}
trap cleanup EXIT

# Runs a command in the image as its user, with the library read-only at
# /data/library and the data root at /data/portfolio, as
# docker-compose.prod.yml mounts them for image-watcher, and the owner's input
# files read-only at /data/input.
in_image() {
  docker run --rm --pull never -e PHOTOGRAPHY_LIBRARY_DIR=/data/library -e PHOTOGRAPHY_DATA_DIR=/data/portfolio -e PHOTOS_ACTOR="$ACTOR" \
    -v "$LIB:/data/library:ro" -v "$DATA:/data/portfolio" -v "$INPUT:/data/input:ro" "$IMAGE" "$@"
}

# Runs photos.mjs in the image with <args>, and fails unless it exits 0. Prints its stdout.
photos() {
  local code=0
  in_image node dist/scripts/photos.mjs "$@" >"$TMP/photos.out" 2>"$TMP/photos.err" || code=$?
  [ "$code" = 0 ] || fail "photos $* exited $code: $(cat "$TMP/photos.out" "$TMP/photos.err")"
  cat "$TMP/photos.out"
}

# Runs photos.mjs in the image with <args>, leaving stdout and stderr in <file>, and prints its exit code.
photos_code() {
  local file=$1 code=0
  shift
  in_image node dist/scripts/photos.mjs "$@" >"$file" 2>&1 || code=$?
  echo "$code"
}

# One watcher pass with --once, as image-watcher runs it. <label> names it in a failure.
run_once() {
  in_image node dist/scripts/imageWatcher.mjs --once >"$TMP/once.log" 2>&1 || {
    cat "$TMP/once.log"
    fail "$1: the watcher's --once run exited non-zero."
  }
}

# Writes every ready set the registry lists to <file>, one line each, sorted:
# its photo ID, asset revision, profile ID, and the SHA-256 of its
# manifest.json, which must exist. A set that goes or changes changes the list.
list_sets() {
  # shellcheck disable=SC2016 # the ${...} are JavaScript template strings
  in_image node -e '
    const fs = require("fs");
    const crypto = require("crypto");
    const dir = "/data/portfolio/identity/registry";
    const newest = Math.max(...fs.readdirSync(dir).map((name) => Number((/^v([1-9][0-9]*)\.json$/.exec(name) || [])[1] || 0)));
    const registry = JSON.parse(fs.readFileSync(`${dir}/v${newest}.json`, "utf8"));
    const lines = [];
    for (const photo of Object.values(registry.photos)) {
      for (const [assetRevision, revision] of Object.entries(photo.revisions)) {
        for (const [profileId, profile] of Object.entries(revision.profiles)) {
          if (profile.state !== "ready") continue;
          const manifest = `/data/portfolio/assets/${photo.photoId}/${assetRevision}/${profileId}/manifest.json`;
          lines.push(`${photo.photoId} ${assetRevision} ${profileId} ${crypto.createHash("sha256").update(fs.readFileSync(manifest)).digest("hex")}`);
        }
      }
    }
    console.log(lines.sort().join("\n"));' | LC_ALL=C sort >"$1" || fail "Could not read a manifest.json for every ready set."
}

# Prints the photo ID, observed asset revision and source health of the photo whose source path is <path>.
source_of() {
  in_image node -e '
    const fs = require("fs");
    const dir = "/data/portfolio/identity/registry";
    const newest = Math.max(...fs.readdirSync(dir).map((name) => Number((/^v([1-9][0-9]*)\.json$/.exec(name) || [])[1] || 0)));
    const registry = JSON.parse(fs.readFileSync(dir + "/v" + newest + ".json", "utf8"));
    const matches = Object.values(registry.photos).filter((photo) => photo.source.path === process.argv[1]);
    if (matches.length !== 1) throw new Error(matches.length + " photos have the source path " + process.argv[1]);
    const [photo] = matches;
    console.log([photo.photoId, photo.source.observedRevision, photo.sourceHealth].join(" "));' "$1" ||
    fail "Could not read the registry's photo for $1."
}

# Writes every file under the data root's catalog/ to <file>, sorted, with its
# size and SHA-256: the pointer, the activations and the revisions.
list_catalog() {
  in_image node -e '
    const fs = require("fs");
    const path = require("path");
    const crypto = require("crypto");
    const root = "/data/portfolio/catalog";
    const lines = [];
    for (const name of fs.readdirSync(root, { recursive: true })) {
      const file = path.join(root, name);
      if (!fs.lstatSync(file).isFile()) continue;
      const bytes = fs.readFileSync(file);
      lines.push(name + " " + bytes.length + " " + crypto.createHash("sha256").update(bytes).digest("hex"));
    }
    console.log(lines.sort().join("\n"));' >"$1" || fail "Could not list catalog/."
}

# Writes `curation list --all --json` to <file>.
inbox_all() {
  photos curation list --all --json >"$1"
}

# 1. The library and the extras, generated by the image under test with this
#    checkout's fixtures mounted read-only, and an empty data root, all
#    writable by the image's user, and the owner's input folder.
mkdir "$LIB" "$EXTRAS" "$DATA" "$INPUT"
chmod 777 "$LIB" "$EXTRAS" "$DATA"
docker run --rm --pull never -v "$PWD/test/fixtures:/app/test/fixtures:ro" -v "$LIB:/library" \
  "$IMAGE" node test/fixtures/makeLibrary.ts /library || fail "Generating the fixture library in $IMAGE failed."
docker run --rm --pull never -v "$PWD/test/fixtures:/app/test/fixtures:ro" -v "$EXTRAS:/library" \
  "$IMAGE" node test/fixtures/makeLibrary.ts /library --extras || fail "Generating the fixture extras in $IMAGE failed."
[ -s "$LIB/landscape.jpg" ] || fail "The fixture library has no landscape.jpg."
[ -s "$EXTRAS/landscape-edited.jpg" ] || fail "The fixture extras have no landscape-edited.jpg."
cmp -s "$LIB/landscape.jpg" "$EXTRAS/landscape-edited.jpg" && fail "landscape-edited.jpg has landscape.jpg's bytes, so replacing one with the other would prove nothing."

# The migration, as docs/data-root.md runs it: a dry run, then its plan.
dry_run=$(photos migrate --dry-run)
plan=$(sed -n 's/^Plan: //p' <<<"$dry_run")
[ -n "$plan" ] || fail "The dry run printed no plan: $dry_run"
photos migrate --apply --plan "$plan" >/dev/null
run_once "After the migration"
photos identity status --json >"$TMP/identity.json"
jq -e '.dataRoot.state == "ready" and .photos.total == 3 and .pendingJobs == 0 and .failedProfiles == []' "$TMP/identity.json" >/dev/null ||
  fail "After the first --once run, photos identity status reported $(cat "$TMP/identity.json")."

# The launch revision, through the owner's commands.
photos draft:init >/dev/null
photos list --json >"$TMP/list.json"
id_of() {
  jq -er --arg source "$1" '.[] | select(.source == $source) | .photoId' "$TMP/list.json" || fail "photos list --json names no photo for $1: $(cat "$TMP/list.json")"
}
landscape=$(id_of landscape.jpg)
portrait=$(id_of portrait.png)
square=$(id_of square.webp)
cat >"$INPUT/series.json" <<EOF
{
  "kind": "series",
  "id": "$SERIES",
  "slug": "smoke-ingest",
  "title": "Ingest smoke fixture series",
  "statement": "A fixture statement for the ingest smoke test. Not real copy.",
  "shortStatement": "A fixture short statement.",
  "photoIds": [],
  "chapters": [],
  "cover": null,
  "visibility": "published"
}
EOF
printf '%s\n' 'photoId,alt' "$landscape,A warm fixture gradient." "$portrait,A green fixture gradient." "$square,A purple fixture checkerboard." >"$INPUT/descriptions.csv"
chmod -R a+rX "$INPUT"
photos edit "$SERIES" --file /data/input/series.json >/dev/null
photos sequence set "$SERIES" "$landscape" "$portrait" "$square" >/dev/null
photos sequence cover "$SERIES" "$portrait" >/dev/null
photos series order "$SERIES" >/dev/null
photos series featured "$SERIES" >/dev/null
photos describe --import /data/input/descriptions.csv >/dev/null
code=$(photos_code "$TMP/launch-unconfirmed.txt" publish --actor "$ACTOR")
[ "$code" = 3 ] || fail "The first publish exited $code without --confirm-launch, expected 3: $(cat "$TMP/launch-unconfirmed.txt")"
launch=$(sed -n 's/.*--confirm-launch --expect \(rev_[0-9a-f]\{64\}\)\..*/\1/p' "$TMP/launch-unconfirmed.txt" | head -1)
[ -n "$launch" ] || fail "The first publish named no candidate to confirm: $(cat "$TMP/launch-unconfirmed.txt")"
photos publish --actor "$ACTOR" --confirm-launch --expect "$launch" >"$TMP/launch.txt"
grep -qF -- "[photos] PUBLISHED: Published $launch as revision 1." "$TMP/launch.txt" || fail "The launch publish didn't say it published $launch as revision 1: $(cat "$TMP/launch.txt")"
photos status --json >"$TMP/status-launch.json"
# shellcheck disable=SC2016 # $launch is jq's
jq -e '.catalog.active.revisionId == $launch and .catalog.active.revisionNumber == 1' --arg launch "$launch" "$TMP/status-launch.json" >/dev/null ||
  fail "After the launch, photos status reported $(jq -c .catalog "$TMP/status-launch.json")."
echo "The migration gave the 3 fixtures their IDs, --once built their sets, and the owner's commands published $launch as revision 1."

# 2. #14: one photo added, one --once run, and the bundled curation commands.
inbox_all "$TMP/inbox-launch.json"
jq -e '.total == 3 and .problems == [] and all(.events[]; .type == "new")' "$TMP/inbox-launch.json" >/dev/null ||
  fail "After the launch, curation list --all --json listed $(cat "$TMP/inbox-launch.json")."
cp "ci/fixtures/library/ci-portrait.jpg" "$LIB/$ADDED"
chmod a+r "$LIB/$ADDED"
run_once "After adding $ADDED"
inbox_all "$TMP/inbox-added.json"
# shellcheck disable=SC2016 # $added and $before are jq's
jq -e --arg added "$ADDED" --slurpfile before "$TMP/inbox-launch.json" '
  ([.events[] | select(.sourcePath == $added)]) as $new
  | ($new | length) == 1 and $new[0].type == "new" and $new[0].status == "open" and $new[0].photoId != null
    and .total == $before[0].total + 1
    and ([.events[] | select(.sourcePath != $added)] | sort_by(.id)) == ($before[0].events | sort_by(.id))' "$TMP/inbox-added.json" >/dev/null ||
  fail "Adding $ADDED should record exactly one new item, for it, and change no other, but curation list --all --json went from $(cat "$TMP/inbox-launch.json") to $(cat "$TMP/inbox-added.json")."
item=$(jq -r --arg added "$ADDED" '.events[] | select(.sourcePath == $added) | .id' "$TMP/inbox-added.json")
version=$(jq -r --arg added "$ADDED" '.events[] | select(.sourcePath == $added) | .version' "$TMP/inbox-added.json")
photos curation list --json >"$TMP/inbox-active.json"
# shellcheck disable=SC2016 # $item is jq's
jq -e '.needsJudgment == 1 and ([.events[].id] == [$item])' --arg item "$item" "$TMP/inbox-active.json" >/dev/null ||
  fail "curation list --json should list only $item as needing judgment: $(cat "$TMP/inbox-active.json")"
photos curation list >"$TMP/inbox-active.txt"
grep -q '^Curation inbox: 1 item requires judgment, 3 already placed, 4 in all\.$' "$TMP/inbox-active.txt" ||
  fail "curation list didn't sum up one item requiring judgment: $(cat "$TMP/inbox-active.txt")"
photos curation show "$item" --json >"$TMP/item.json"
# shellcheck disable=SC2016 # $added and $launch are jq's
jq -e '.event.type == "new" and .event.status == "open" and .event.derivedFacts.sourcePath == $added and .activeRevisionId == $launch' \
  --arg added "$ADDED" --arg launch "$launch" "$TMP/item.json" >/dev/null || fail "curation show $item --json printed $(cat "$TMP/item.json")."
photos curation defer "$item" --version "$version" --reason "Ingest smoke: later." >/dev/null
inbox_all "$TMP/inbox-deferred.json"
# shellcheck disable=SC2016 # $item and $version are jq's
jq -e '.events[] | select(.id == $item) | .status == "deferred" and .version == ($version | tonumber) + 1' \
  --arg item "$item" --arg version "$version" "$TMP/inbox-deferred.json" >/dev/null || fail "curation defer didn't defer $item: $(cat "$TMP/inbox-deferred.json")"
run_once "The second run"
inbox_all "$TMP/inbox-second.json"
diff -u "$TMP/inbox-deferred.json" "$TMP/inbox-second.json" || fail "A second --once run with nothing changed recorded or changed an inbox item."
echo "Adding $ADDED recorded exactly one new item, $item, which curation show read and curation defer deferred, and a second --once run recorded nothing."

# 3. #17: landscape.jpg replaced in place by other pixels. The image's user owns it, so the image copies them over it.
list_sets "$TMP/sets-launch.txt"
[ "$(wc -l <"$TMP/sets-launch.txt")" -eq 4 ] || fail "Expected a ready set for each of the 4 photos, got: $(cat "$TMP/sets-launch.txt")"
list_catalog "$TMP/catalog-launch.txt"
state=$(source_of landscape.jpg)
read -r photo_a revision_a health_a <<<"$state"
[ "$photo_a" = "$landscape" ] && [ "$health_a" = present ] || fail "Before the replacement, landscape.jpg is $photo_a, $health_a; expected $landscape, present."
docker run --rm --pull never --entrypoint cp -v "$EXTRAS:/extras:ro" -v "$LIB:/library" "$IMAGE" /extras/landscape-edited.jpg /library/landscape.jpg ||
  fail "Could not copy other pixels over landscape.jpg."
cmp -s "$LIB/landscape.jpg" "$EXTRAS/landscape-edited.jpg" || fail "landscape.jpg doesn't hold the new pixels."
run_once "After replacing landscape.jpg"
state=$(source_of landscape.jpg)
read -r photo_b revision_b health_b <<<"$state"
[ "$photo_b" = "$landscape" ] && [ "$health_b" = present ] || fail "After the replacement, landscape.jpg is $photo_b, $health_b; expected $landscape, still present."
[ "$revision_b" != "$revision_a" ] || fail "The replacement left landscape.jpg at asset revision $revision_a."
list_sets "$TMP/sets-replaced.txt"
[ -z "$(LC_ALL=C comm -23 "$TMP/sets-launch.txt" "$TMP/sets-replaced.txt")" ] ||
  fail "The replacement removed or changed a set: $(LC_ALL=C comm -23 "$TMP/sets-launch.txt" "$TMP/sets-replaced.txt")"
added_sets=$(LC_ALL=C comm -13 "$TMP/sets-launch.txt" "$TMP/sets-replaced.txt")
[ "$(grep -c . <<<"$added_sets")" = 1 ] && [[ $added_sets == "$landscape $revision_b "* ]] ||
  fail "The replacement should add exactly one set, $landscape $revision_b, but added: $added_sets"
list_catalog "$TMP/catalog-replaced.txt"
diff -u "$TMP/catalog-launch.txt" "$TMP/catalog-replaced.txt" || fail "The watcher wrote under catalog/ after the replacement."
photos curation list --json >"$TMP/inbox-replaced.json"
# shellcheck disable=SC2016 # $landscape is jq's
jq -e 'any(.events[]; .type == "replacement" and .status == "open" and .photoId == $landscape)' --arg landscape "$landscape" "$TMP/inbox-replaced.json" >/dev/null ||
  fail "The replacement opened no replacement item for $landscape: $(cat "$TMP/inbox-replaced.json")"
code=$(photos_code "$TMP/check-replaced.json" status --check --json)
[ "$code" = 0 ] || fail "photos status --check exited $code after the replacement, expected 0: $(cat "$TMP/check-replaced.json")"
# shellcheck disable=SC2016 # $launch is jq's
jq -e '.check.ok == true and .check.problems == [] and .catalog.active.revisionId == $launch' --arg launch "$launch" "$TMP/check-replaced.json" >/dev/null ||
  fail "After the replacement, photos status --check --json printed $(cat "$TMP/check-replaced.json")."
echo "Replacing landscape.jpg built $revision_b's set beside $revision_a's, kept every set, opened a replacement item, left catalog/ and the pointer on $launch, and passed photos status --check."

# 4. #17: landscape.jpg deleted from the temp library, as the owner would.
rm -f "$LIB/landscape.jpg"
[ ! -e "$LIB/landscape.jpg" ] || fail "Could not remove landscape.jpg from the fixture library."
run_once "After deleting landscape.jpg"
state=$(source_of landscape.jpg)
read -r photo_c revision_c health_c <<<"$state"
[ "$photo_c" = "$landscape" ] && [ "$revision_c" = "$revision_b" ] && [ "$health_c" = missing ] ||
  fail "After the deletion, landscape.jpg is $photo_c $revision_c, $health_c; expected $landscape $revision_b, missing."
list_sets "$TMP/sets-deleted.txt"
diff -u "$TMP/sets-replaced.txt" "$TMP/sets-deleted.txt" || fail "A set changed or went once landscape.jpg was deleted."
list_catalog "$TMP/catalog-deleted.txt"
diff -u "$TMP/catalog-launch.txt" "$TMP/catalog-deleted.txt" || fail "The watcher wrote under catalog/ after the deletion."
code=$(photos_code "$TMP/check-deleted.json" status --check --json)
[ "$code" = 1 ] || fail "photos status --check exited $code with landscape.jpg missing, expected 1: $(cat "$TMP/check-deleted.json")"
# shellcheck disable=SC2016 # $landscape and $launch are jq's
jq -e '.check.ok == false and ([.check.problems[].code] == ["missing-open"]) and ([.inbox.missing[].photoId] == [$landscape]) and .catalog.active.revisionId == $launch' \
  --arg landscape "$landscape" --arg launch "$launch" "$TMP/check-deleted.json" >/dev/null ||
  fail "With landscape.jpg missing, photos status --check --json printed $(cat "$TMP/check-deleted.json")."
code=$(photos_code "$TMP/check-deleted.txt" status --check)
if [ "$code" != 1 ] || ! grep -q '^Check: failed\.$' "$TMP/check-deleted.txt" || ! grep -qF -- '1 missing source open' "$TMP/check-deleted.txt"; then
  fail "photos status --check exited $code with landscape.jpg missing, expected 1 and the missing source: $(cat "$TMP/check-deleted.txt")"
fi
code=$(photos_code "$TMP/verify.json" verify --json)
[ "$code" = 0 ] || fail "photos verify --json exited $code with landscape.jpg missing, expected 0: $(cat "$TMP/verify.json")"
jq -e '.outcome == "VERIFIED"' "$TMP/verify.json" >/dev/null || fail "photos verify --json printed $(cat "$TMP/verify.json")."
echo "Deleting landscape.jpg marked $landscape missing, kept both its sets and every other, left catalog/ and the pointer on $launch, and failed photos status --check with missing-open alone; photos verify still passed $launch."
echo "smoke-ingest passed."
