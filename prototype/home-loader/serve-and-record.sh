#!/bin/zsh
# Serves one worktree's production build on 127.0.0.1:<port>, refuses to go on
# unless lsof shows only 127.0.0.1 on that port, runs record.mjs once per plan
# line, and stops the server. Prototype only.
#
#   serve-and-record.sh <worktree> <port> <out-root> <plan-file>
#
# Plan lines: <name> <path-and-query> <record.mjs args...>
# Optional env: SITE_CONFIG (PHOTOGRAPHY_SITE_CONFIG_DIR for the server).
set -u
wt=$1 port=$2 outroot=$3 plan=$4
here=${0:A:h}
mkdir -p "$outroot"
log="$outroot/server-$port.log"
if lsof -nP -iTCP:"$port" -sTCP:LISTEN > /dev/null 2>&1; then
  echo "port $port is taken, not starting"; exit 1
fi
lib=$(mktemp -d "${TMPDIR:-/tmp}/ll-library.XXXXXX")
cd "$wt" || exit 1
unset CI
env PHOTOGRAPHY_LIBRARY_DIR="$lib" ${SITE_CONFIG:+PHOTOGRAPHY_SITE_CONFIG_DIR="$SITE_CONFIG"} \
  ./node_modules/.bin/next start --hostname 127.0.0.1 --port "$port" > "$log" 2>&1 &
pid=$!
cleanup() {
  for child in $(pgrep -P $pid 2>/dev/null); do kill $child 2>/dev/null; done
  kill $pid 2>/dev/null; wait $pid 2>/dev/null
  rm -rf "$lib"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN > /dev/null 2>&1 && echo "WARNING: $port still listening"
}
trap cleanup EXIT INT TERM
ready=0
for i in {1..90}; do
  curl -s -o /dev/null "http://127.0.0.1:$port/" && { ready=1; break; }
  kill -0 $pid 2>/dev/null || break
  sleep 1
done
[ $ready = 1 ] || { echo "server never answered"; exit 1; }
listen=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2)
echo "listener: $listen"
if [ -z "$listen" ] || print -r -- "$listen" | grep -v "127\.0\.0\.1:$port " | grep -q .; then
  echo "listener is not loopback only, stopping"; exit 1
fi
# Warm the route once (and the portrait variants), so the first recording isn't a cold compile.
curl -s -o /dev/null "http://127.0.0.1:$port/"
sleep 2
code=0
while read -r name urlpath rest; do
  [ -z "$name" ] && continue
  case $name in \#*) continue ;; esac
  rm -rf "$outroot/$name"
  echo "== $name"
  node "$here/record.mjs" --url "http://127.0.0.1:$port$urlpath" --out "$outroot/$name" ${=rest} || code=1
done < "$plan"
exit $code
