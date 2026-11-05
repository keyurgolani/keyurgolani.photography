# A6 (#17, review 7a): image-watcher exits 75 to re-bind a library share that
# went unreadable or empty, and relies on Docker starting it again, so it must
# keep `restart: always`. ci/check-compose.sh runs this against the resolved
# config; utils/__tests__/watcherRestart.test.ts runs it against fixtures.
.services["image-watcher"].restart == "always"
