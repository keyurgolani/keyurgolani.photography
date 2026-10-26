#!/bin/sh
# Waits until neither heavy slot is held, then runs the command (which should
# be a KGN_HEAVY_EXCLUSIVE=1 kgn-heavy.sh call), so an exclusive run never
# sits on one slot for minutes waiting for the other. It never takes a slot itself.
while [ -d /tmp/kgn-heavy.lock ] || [ -d /tmp/kgn-heavy.lock.2 ]; do sleep 5; done
exec "$@"
