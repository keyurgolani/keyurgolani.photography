#!/usr/bin/env bash
# Checks that docker-compose.prod.yml runs every service on the one release
# tag in PHOTOGRAPHY_IMAGE_TAG, that ci/smoke-image.sh starts every service
# Compose starts by default, that every published port is on the host's
# loopback, that the data root, the library, web's image cache, and the
# site config folder mounts keep their guarantees, and that the curator (#14)
# is the only service with CURATION_ENABLED, starts only by name, publishes
# on 127.0.0.1:3001 alone unless LAN mode's CURATOR_PUBLISH says otherwise
# (and only the curator reads it), and is the only service that mounts
# ./secrets. Compose runs from an empty project directory, with the curator's
# publish settings unset, so a local .env or this shell can't leak in.
set -euo pipefail

cd "$(dirname "$0")/.."
unset COMPOSE_PROFILES CURATOR_PUBLISH CURATOR_HOST_PORT CURATOR_EXTRA_HOSTS CURATOR_TUNNEL_PORT

FILE=docker-compose.prod.yml
IMAGE=ghcr.io/keyurgolani/keyurgolani.photography
# The services ci/smoke-image.sh starts.
SERVICES_FILE=ci/smoke-services
PROJECT_DIR=$(mktemp -d)
trap 'rm -rf "$PROJECT_DIR"' EXIT

# Without --profile, Compose only sees the services that start by default.
compose_default() {
  docker compose -f "$FILE" --project-directory "$PROJECT_DIR" "$@"
}

compose() {
  compose_default --profile '*' "$@"
}

fail() {
  echo "::error file=$FILE::$1"
  exit 1
}

# 1. Before interpolation, every image line is exactly
#    $IMAGE:${PHOTOGRAPHY_IMAGE_TAG:?<message>}, so a nested default such as
#    ${OTHER:-${PHOTOGRAPHY_IMAGE_TAG:?...}} can't slip through.
if ! raw=$(compose config --no-interpolate --format json); then
  fail "docker compose config --no-interpolate failed."
fi
if ! jq -e --arg prefix "$IMAGE:\${PHOTOGRAPHY_IMAGE_TAG:?" '
    [.services[].image] | length > 0 and all(
      type == "string" and startswith($prefix) and endswith("}")
      and (.[($prefix | length):-1] | test("[$}]") | not))' <<<"$raw" >/dev/null; then
  fail "Every service must use image $IMAGE:\${PHOTOGRAPHY_IMAGE_TAG:?<message>}, with nothing nested in or around the variable."
fi
echo "Every image line is $IMAGE:\${PHOTOGRAPHY_IMAGE_TAG:?...}."

# 2. Every service, including ones behind a profile, runs the tag that
#    PHOTOGRAPHY_IMAGE_TAG names.
if ! PHOTOGRAPHY_IMAGE_TAG=v9.9.9 compose config --format json \
  | jq -e --arg image "$IMAGE:v9.9.9" '[.services[].image] | unique == [$image]' >/dev/null; then
  fail "Every service must use image $IMAGE:\${PHOTOGRAPHY_IMAGE_TAG}."
fi
echo "Every service runs $IMAGE:\${PHOTOGRAPHY_IMAGE_TAG}."

# 3. Without PHOTOGRAPHY_IMAGE_TAG, Compose refuses the file because of it,
#    instead of falling back to a default tag.
if reason=$(unset PHOTOGRAPHY_IMAGE_TAG; compose config 2>&1 >/dev/null); then
  fail "docker compose config passed with PHOTOGRAPHY_IMAGE_TAG unset. Use \${PHOTOGRAPHY_IMAGE_TAG:?...} with no default."
fi
case $reason in
  *PHOTOGRAPHY_IMAGE_TAG*) ;;
  *)
    echo "$reason"
    fail "docker compose config failed with PHOTOGRAPHY_IMAGE_TAG unset, but its error doesn't name PHOTOGRAPHY_IMAGE_TAG."
    ;;
esac
echo "Unset PHOTOGRAPHY_IMAGE_TAG is refused: $reason"

# 4. Nothing pulls a moving tag.
if grep -n ':latest' "$FILE"; then
  fail "$FILE must not reference :latest."
fi
echo "$FILE has no :latest."

# 5. ci/smoke-image.sh starts exactly the services Compose starts by default,
#    since both read the list from ci/smoke-services.
if ! services=$(PHOTOGRAPHY_IMAGE_TAG=v9.9.9 compose_default config --services); then
  fail "docker compose config --services failed."
fi
services=$(LC_ALL=C sort <<<"$services" | tr '\n' ' ')
services=${services% }
if ! smoke=$(awk '{ sub(/#.*/, ""); for (i = 1; i <= NF; i++) print $i }' "$SERVICES_FILE"); then
  fail "Could not read $SERVICES_FILE."
fi
smoke=$(LC_ALL=C sort <<<"$smoke" | tr '\n' ' ')
smoke=${smoke% }
if [ "$services" != "$smoke" ]; then
  fail "$FILE starts '$services' by default, but $SERVICES_FILE lists '$smoke'. A PR that adds a service lists it in $SERVICES_FILE and extends ci/smoke-image.sh to check it."
fi
echo "ci/smoke-image.sh starts every default service: $services."

# The resolved file the last checks read, with every profile.
if ! resolved=$(PHOTOGRAPHY_IMAGE_TAG=v9.9.9 compose config --format json); then
  fail "docker compose config failed."
fi

# 6. Every published port is on the host's 127.0.0.1, whatever
#    PHOTOGRAPHY_PORT says. A reverse proxy or tunnel on the host serves it.
for port in '' 3456; do
  if ! ports=$(PHOTOGRAPHY_IMAGE_TAG=v9.9.9 PHOTOGRAPHY_PORT=$port compose config --format json); then
    fail "docker compose config failed with PHOTOGRAPHY_PORT='$port'."
  fi
  if ! jq -e '[.services[] | (.ports // [])[]] | all(type == "object" and .host_ip == "127.0.0.1")' <<<"$ports" >/dev/null; then
    fail "Every ports: entry must publish on 127.0.0.1, as \"127.0.0.1:\${PHOTOGRAPHY_PORT:-3000}:3000\"."
  fi
done
if ! jq -e '.services.web.ports | length > 0' <<<"$resolved" >/dev/null; then
  fail "web must publish its port on 127.0.0.1."
fi
# A service on the host's network has no ports: to check, and web listens on
# every interface inside its container.
if ! jq -e 'all(.services[]; (.network_mode // "") != "host")' <<<"$resolved" >/dev/null; then
  fail "No service may use network_mode: host, since it would bypass the 127.0.0.1 publish."
fi
echo "Every published port is on 127.0.0.1, and no service shares the host's network."

# 7. web mounts the data root read-only, and no bind of the data root, the
#    library, or web's image cache is ever created when its source is missing.
#    Docker would create the image cache owned by root, which uid 1001 can't
#    write. How Compose writes create_host_path: false in its output differs
#    between versions, so compare against a probe file holding one
#    long-syntax bind with it and one short-syntax bind, which Compose creates
#    when missing.
PROBE="$PROJECT_DIR/probe.yml"
cat >"$PROBE" <<'YAML'
services:
  probe:
    image: probe
    volumes:
      - type: bind
        source: ./kept
        target: /kept
        bind:
          create_host_path: false
      - ./created:/created
YAML
if ! probe=$(docker compose -f "$PROBE" --project-directory "$PROJECT_DIR" config --format json); then
  fail "docker compose config failed on the create_host_path probe."
fi
never_created=$(jq -c '.services.probe.volumes[] | select(.target == "/kept") | .bind.create_host_path' <<<"$probe")
short_syntax=$(jq -c '.services.probe.volumes[] | select(.target == "/created") | .bind.create_host_path' <<<"$probe")
if [ "$never_created" = "$short_syntax" ]; then
  fail "This Compose writes create_host_path the same way for a long-syntax bind with false and a short-syntax bind ($never_created), so the check can't tell them apart."
fi
echo "create_host_path probe: long syntax with false=$never_created, short syntax=$short_syntax"
# A data root mount is one at /data/portfolio, however its target is spelled,
# or one of ./portfolio-data or a folder inside it wherever it lands, so a
# second read-write bind of the same folder can't slip past.
DATA_ROOT_MOUNT='((.target // "") | rtrimstr("/")) == "/data/portfolio" or ((.source // "") | test("/portfolio-data(/|$)"))'
if ! jq -e "[.services.web.volumes[]? | select($DATA_ROOT_MOUNT)]
    | length == 1 and all(.type == \"bind\" and .target == \"/data/portfolio\" and .read_only == true)" <<<"$resolved" >/dev/null; then
  fail "web must mount the data root once, at /data/portfolio, as a bind with read_only: true."
fi
if ! jq -e '.services.web.environment.PHOTOGRAPHY_DATA_DIR == "/data/portfolio"' <<<"$resolved" >/dev/null; then
  fail "web must set PHOTOGRAPHY_DATA_DIR=/data/portfolio, the read-only mount."
fi
if ! jq -e --argjson never "$never_created" "
    [.services[] | (.volumes // [])[] | select(($DATA_ROOT_MOUNT) or (((.target // \"\") | rtrimstr(\"/\")) | IN(\"/app/public/assets/photos\", \"/app/.next/cache/images\")))]
    | length > 0 and all(.type == \"bind\" and .bind.create_host_path == \$never)" <<<"$resolved" >/dev/null; then
  fail "Every mount of the data root, /app/public/assets/photos, or /app/.next/cache/images must be a long-syntax bind with bind.create_host_path: false."
fi
echo "web mounts the data root read-only, and no data root, library, or image cache bind is created when missing."

# 8. web and curator each mount the site config folder, which holds About's
#    portrait, once, read-only, at /config/site, and point
#    PHOTOGRAPHY_SITE_CONFIG_DIR at it: web for About, curator for the draft
#    preview's About (v1.2.1). No other service mounts it, and none writes
#    it, so nothing in the stack can change the portrait, and nothing mounts
#    it under /app/public, where Next would serve the original file,
#    metadata and all.
SITE_CONFIG_MOUNT='((.target // "") | rtrimstr("/")) == "/config/site" or ((.source // "") | test("/site-config(/|$)"))'
for service in web curator; do
  if ! jq -e --arg service "$service" "[.services[\$service].volumes[]? | select($SITE_CONFIG_MOUNT)]
      | length == 1 and all(.type == \"bind\" and .target == \"/config/site\" and .read_only == true)" <<<"$resolved" >/dev/null; then
    fail "$service must mount ./site-config once, at /config/site, as a bind with read_only: true."
  fi
  if ! jq -e --arg service "$service" '.services[$service].environment.PHOTOGRAPHY_SITE_CONFIG_DIR == "/config/site"' <<<"$resolved" >/dev/null; then
    fail "$service must set PHOTOGRAPHY_SITE_CONFIG_DIR=/config/site, the read-only mount."
  fi
done
# The same create-when-missing behaviour on both, however this Compose writes it, so a missing folder starts both alike.
if ! jq -e "[.services.web.volumes[]? | select($SITE_CONFIG_MOUNT) | .bind.create_host_path] == [.services.curator.volumes[]? | select($SITE_CONFIG_MOUNT) | .bind.create_host_path]" <<<"$resolved" >/dev/null; then
  fail "curator's ./site-config bind must be created when missing exactly as web's is."
fi
if ! jq -e "[.services | to_entries[] | select(.key | IN(\"web\", \"curator\") | not) | .value.volumes[]? | select($SITE_CONFIG_MOUNT)] | length == 0" <<<"$resolved" >/dev/null; then
  fail "Only web and curator may mount the site config folder."
fi
if ! jq -e '[.services[] | (.volumes // [])[] | select(((.target // "") | startswith("/app/public")) and (((.source // "") | test("/site-config(/|$)"))))] | length == 0' <<<"$resolved" >/dev/null; then
  fail "The site config folder must never be mounted under /app/public."
fi
echo "web and curator mount the site config folder once each, read-only, at /config/site, and no other service mounts it."

# 9. web can't write the library or the data root: it mounts both read-only.
LIBRARY_MOUNT='((.target // "") | rtrimstr("/")) == "/app/public/assets/photos"'
if ! jq -e "[.services.web.volumes[]? | select($LIBRARY_MOUNT)]
    | length == 1 and all(.type == \"bind\" and .read_only == true)" <<<"$resolved" >/dev/null; then
  fail "web must mount the library once, at /app/public/assets/photos, as a bind with read_only: true."
fi
echo "web mounts the library and the data root read-only."

# 10. CURATION_ENABLED and CURATION_BIND_SCOPE are set on curator alone, and
#     no service but curator sets either, through environment or env_file,
#     which Compose resolves into environment.
if ! jq -e '.services.curator' <<<"$resolved" >/dev/null; then
  fail "docker-compose.prod.yml must define the curator service."
fi
if ! jq -e '[.services | to_entries[] | select(.key != "curator") | .value.environment // {} | has("CURATION_ENABLED", "CURATION_BIND_SCOPE")] | any | not' <<<"$resolved" >/dev/null; then
  fail "Only curator may set CURATION_ENABLED or CURATION_BIND_SCOPE."
fi
if ! jq -e '.services.curator.environment | .CURATION_ENABLED == "true" and .CURATION_BIND_SCOPE == "container" and .PHOTOGRAPHY_DATA_DIR == "/data/portfolio"' <<<"$resolved" >/dev/null; then
  fail "curator must set CURATION_ENABLED=true, CURATION_BIND_SCOPE=container, and PHOTOGRAPHY_DATA_DIR=/data/portfolio."
fi
echo "Only curator sets CURATION_ENABLED and CURATION_BIND_SCOPE."

# 11. curator is off by default, publishes one port on the host's
#     127.0.0.1:3001 alone, shares no network with another service, runs as
#     the watcher's uid, mounts the library read-only and the data root
#     read-write.
if ! jq -e '.services.curator.profiles == ["curator"]' <<<"$resolved" >/dev/null; then
  fail "curator must sit behind the curator profile, so it starts only by name."
fi
if ! jq -e '.services.curator.ports | length == 1 and all(.host_ip == "127.0.0.1" and (.published | tostring) == "3001" and .target == 3000)' <<<"$resolved" >/dev/null; then
  fail "With CURATOR_PUBLISH and CURATOR_HOST_PORT unset, curator must publish exactly \"127.0.0.1:3001:3000\"."
fi
if ! jq -e '(.services.curator.network_mode // "") == "" and (.services.curator.networks // {} | keys) == ["curator"]
    and ([.services | to_entries[] | select(.key != "curator") | (.value.networks // {"default": null}) | keys[]] | index("curator") == null)' <<<"$resolved" >/dev/null; then
  fail "curator must be on the curator network alone, and no other service may join it."
fi
if ! jq -e '.services.curator.healthcheck.test | index("Host: localhost:3001") != null' <<<"$resolved" >/dev/null; then
  fail "curator's healthcheck must send Host: localhost:3001, since the curator answers no other Host."
fi
if ! jq -e '.services.curator.user == "1001:1001"' <<<"$resolved" >/dev/null; then
  fail "curator must run as user 1001:1001, the watcher's uid."
fi
if ! jq -e "[.services.curator.volumes[]? | select($LIBRARY_MOUNT)] | length == 1 and all(.type == \"bind\" and .read_only == true)" <<<"$resolved" >/dev/null; then
  fail "curator must mount the library once, at /app/public/assets/photos, read-only."
fi
if ! jq -e "[.services.curator.volumes[]? | select($DATA_ROOT_MOUNT)] | length == 1 and all(.type == \"bind\" and .target == \"/data/portfolio\" and (.read_only // false) == false)" <<<"$resolved" >/dev/null; then
  fail "curator must mount the data root once, at /data/portfolio, read-write."
fi
echo "curator starts only by name, publishes 127.0.0.1:3001 alone on a network of its own, and runs as uid 1001."

# 12. The curator's secret files (docs/curator.md): ./secrets is mounted into
#     curator alone, once, read-only, at /run/secrets/curator, and never
#     created when missing. No service carries a secret or names another
#     place for one in its environment, so the files are the only source.
SECRETS_MOUNT='((.source // "") | test("/secrets/?$")) or ((.target // "") | startswith("/run/secrets"))'
if ! jq -e "[.services.curator.volumes[]? | select($SECRETS_MOUNT)]
    | length == 1 and all(.type == \"bind\" and .target == \"/run/secrets/curator\" and .read_only == true and .bind.create_host_path == false)" <<<"$resolved" >/dev/null; then
  fail "curator must mount ./secrets once, at /run/secrets/curator, as a read-only bind with bind.create_host_path: false."
fi
if ! jq -e "([.services | to_entries[] | select(.key != \"curator\") | .value.volumes[]? | select($SECRETS_MOUNT)] | length == 0)
    and ([.services[] | .secrets // [] | length] | add // 0) == 0 and ((.secrets // {}) | length) == 0" <<<"$resolved" >/dev/null; then
  fail "No service but curator may mount ./secrets or use Compose secrets."
fi
if ! jq -e '[.services[] | .environment // {} | keys[] | select(test("PASSPHRASE|SESSION_SECRET|SECRET_FILE"))] | length == 0' <<<"$resolved" >/dev/null; then
  fail "No service may set a passphrase, a session secret, or a secret file path in its environment. curator reads the files from its mount."
fi
echo "Only curator mounts ./secrets, read-only, and no environment carries a secret."

# 13. LAN mode (docs/curator.md, From your home network). The resolved file
#     with nothing set is check 11's: curator on 127.0.0.1:3001 alone. In the
#     raw file, only curator names CURATOR_PUBLISH, CURATOR_HOST_PORT or
#     CURATOR_EXTRA_HOSTS, and web's publish keeps its literal 127.0.0.1. With
#     them set, curator publishes on the address and port they name, hands the
#     same values to the curator process, which answers 503 to anything but
#     loopback or a private address, and every other service publishes
#     exactly as it does with them unset.
LAN_VARIABLES='CURATOR_PUBLISH|CURATOR_HOST_PORT|CURATOR_EXTRA_HOSTS'
# The service each line sits in, from the two-space keys under services:, for every non-comment line naming a LAN variable.
if ! users=$(awk -v pattern="$LAN_VARIABLES" '
    /^[^ #]/ { in_services = ($0 ~ /^services:/); service = ""; next }
    in_services && /^  [A-Za-z0-9_.-]+:/ { service = $1; sub(/:$/, "", service); next }
    { line = $0; sub(/#.*/, "", line) }
    line ~ pattern { print (in_services && service != "" ? service : "(outside services)") }' "$FILE"); then
  fail "Could not read $FILE for the LAN mode variables."
fi
if [ -z "$users" ] || [ "$(LC_ALL=C sort -u <<<"$users")" != "curator" ]; then
  fail "Only curator may name CURATOR_PUBLISH, CURATOR_HOST_PORT or CURATOR_EXTRA_HOSTS. Found in: $(LC_ALL=C sort -u <<<"$users" | tr '\n' ' ')"
fi
# web's ports: entries, as written: every one starts with the literal 127.0.0.1.
if ! web_ports=$(awk '
    /^[^ #]/ { in_services = ($0 ~ /^services:/); service = ""; next }
    in_services && /^  [A-Za-z0-9_.-]+:/ { service = $1; sub(/:$/, "", service); in_ports = 0; next }
    service == "web" && /^    [A-Za-z_]+:/ { in_ports = ($1 == "ports:"); next }
    service == "web" && in_ports && /^      - / { print }' "$FILE"); then
  fail "Could not read web's ports from $FILE."
fi
if [ -z "$web_ports" ] || grep -qv '^      - "127\.0\.0\.1:' <<<"$web_ports"; then
  fail "web's ports: entries must each start with the literal 127.0.0.1, as \"127.0.0.1:\${PHOTOGRAPHY_PORT:-3000}:3000\". Found: $web_ports"
fi
if ! jq -e '.services.curator.environment | .CURATOR_PUBLISH == "" and .CURATOR_HOST_PORT == "" and .CURATOR_EXTRA_HOSTS == ""' <<<"$resolved" >/dev/null; then
  fail "With them unset, curator must pass CURATOR_PUBLISH, CURATOR_HOST_PORT and CURATOR_EXTRA_HOSTS to the container empty, which it reads as loopback mode."
fi
if ! lan=$(PHOTOGRAPHY_IMAGE_TAG=v9.9.9 CURATOR_PUBLISH=192.168.86.250 CURATOR_HOST_PORT=4011 CURATOR_EXTRA_HOSTS=homelab.local:4011 compose config --format json); then
  fail "docker compose config failed with the LAN mode variables set."
fi
if ! jq -e '.services.curator.ports | length == 1 and all(.host_ip == "192.168.86.250" and (.published | tostring) == "4011" and .target == 3000)' <<<"$lan" >/dev/null; then
  fail "With CURATOR_PUBLISH=192.168.86.250 and CURATOR_HOST_PORT=4011, curator must publish exactly 192.168.86.250:4011:3000."
fi
if ! jq -e '.services.curator.environment | .CURATOR_PUBLISH == "192.168.86.250" and .CURATOR_HOST_PORT == "4011" and .CURATOR_EXTRA_HOSTS == "homelab.local:4011"' <<<"$lan" >/dev/null; then
  fail "curator must pass CURATOR_PUBLISH, CURATOR_HOST_PORT and CURATOR_EXTRA_HOSTS to the container as set, the values its publish reads."
fi
if ! jq -e --argjson before "$(jq -c '.services | del(.curator) | map_values(.ports // [])' <<<"$resolved")" \
    '(.services | del(.curator) | map_values(.ports // [])) == $before' <<<"$lan" >/dev/null; then
  fail "The LAN mode variables must change curator's publish alone: every other service must publish as it does with them unset."
fi
echo "With nothing set, curator publishes 127.0.0.1:3001; only curator reads CURATOR_PUBLISH, CURATOR_HOST_PORT and CURATOR_EXTRA_HOSTS, and web keeps its literal 127.0.0.1."
