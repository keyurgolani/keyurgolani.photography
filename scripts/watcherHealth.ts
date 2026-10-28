#!/usr/bin/env node
/**
 * The image-watcher container's healthcheck, which docker-compose.prod.yml
 * runs every 30 s.
 *
 *   node dist/scripts/watcherHealth.mjs
 *
 * Exits 0 while status/watcher.json in the data root says the watcher was
 * alive in the last 120 s and no identity pass has run longer than 30
 * minutes, and 1 otherwise, printing why. The watcher writes it every 30 s
 * while the data root exists and is writable, initialized or not, so an
 * unset, missing, or unwritable data root reads as unhealthy too. It proves
 * the watcher's loop runs, not that the legacy step makes progress.
 */

import { checkWatcherHealth } from '../lib/identity/heartbeat';

checkWatcherHealth()
    .then(({ healthy, message }) => {
        (healthy ? console.log : console.error)(`[watcher-health] ${message}`);
        process.exitCode = healthy ? 0 : 1;
    })
    .catch((error: unknown) => {
        console.error('[watcher-health] Error:', error);
        process.exitCode = 1;
    });
