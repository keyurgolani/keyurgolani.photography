#!/usr/bin/env node
/**
 * Image Watcher Script
 *
 * Watches the photos directory for changes and processes new images automatically.
 * Uses chokidar for reliable file watching in Docker bind-mount scenarios.
 * It never deletes a source or a derivative. Removing a source keeps its
 * derivatives.
 *
 * Two steps run. The legacy step writes the derivatives under the library
 * for photos directly in its root. The identity step runs only when the data
 * root (PHOTOGRAPHY_DATA_DIR) is ready: each pass reconciles the whole
 * library, nested folders included, and the derivative worker builds the
 * `/media` sets the pass left pending. Library changes, a 10-minute timer,
 * and work another process leaves, looked for every 30 s, schedule a pass,
 * 5 s after the last request. Each pass and each 30 s check update
 * status/watcher.json in the data root.
 *
 * The library root is PHOTOGRAPHY_LIBRARY_DIR, or public/assets/photos under
 * the working directory. Both modes exit 1 if the root is missing, and watch
 * mode also exits 1 if the root disappears while it runs. An unknown flag
 * exits 2.
 *
 * Usage:
 *   # Watch mode (continuous)
 *   npx tsx scripts/imageWatcher.ts --watch
 *
 *   # One-shot mode (process once and exit)
 *   npx tsx scripts/imageWatcher.ts
 *
 *   # Process and exit. Exits 1 if any photo failed or changed while it was
 *   # processed, if a /media set failed to build for any reason but a
 *   # source that moved on, or if the derivative worker couldn't start.
 *   npx tsx scripts/imageWatcher.ts --once
 *
 *   # Regenerate every legacy derivative, not only missing or outdated ones
 *   npx tsx scripts/imageWatcher.ts --once --force
 *
 * The image has no tsx, so it runs the bundle `npm run build:scripts` writes,
 * with the same flags: node dist/scripts/imageWatcher.mjs --watch.
 */

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import chokidar from 'chokidar';
import { scanKind } from '../lib/identity/scan';
import { createIdentityStep, runIdentityOnce, watchIdentity, type IdentityWatch } from '../lib/identity/watcherStep';
import { dataRoot } from '../lib/storage/config';
import { ensureDirectories, libraryPaths, libraryRootExists } from '../utils/imageOptimizer';
import { attachWatcher, createWatcherHandlers, createWatchModeHandlers, drainOrReport, processOnce, watchSetup, type LibraryChange } from '../utils/watcherHandlers';

/** This script the way it was started: the bundle in the image, or the source under tsx. */
const PROGRAM = fileURLToPath(import.meta.url).endsWith('.mjs') ? 'node dist/scripts/imageWatcher.mjs' : 'npx tsx scripts/imageWatcher.ts';
const USAGE = `Usage: ${PROGRAM} [--watch | --once] [--force]`;

/** Strict, so a mistyped flag such as --froce exits 2 instead of being ignored. */
function readFlags(): { once: boolean; force: boolean } {
    let values: { watch?: boolean; once?: boolean; force?: boolean; help?: boolean };
    try {
        ({ values } = parseArgs({
            args: process.argv.slice(2),
            options: {
                watch: { type: 'boolean' },
                once: { type: 'boolean' },
                force: { type: 'boolean' },
                help: { type: 'boolean', short: 'h' },
            },
            strict: true,
        }));
    } catch (error) {
        console.error(`[ImageWatcher] ${error instanceof Error ? error.message : String(error)}`);
        console.error(USAGE);
        process.exit(2);
    }
    if (values.help) {
        console.log(USAGE);
        process.exit(0);
    }
    return { once: Boolean(values.once) || !values.watch, force: Boolean(values.force) };
}

const FLAGS = readFlags();
const ONCE_MODE = FLAGS.once;
const FORCE = FLAGS.force;

/** Docker kills a container 10 s after SIGTERM, so queued jobs get this long to finish. */
const SHUTDOWN_GRACE_MS = 8000;

/** How often watch mode checks that the library root is still there. */
const ROOT_CHECK_MS = 5000;
    
/** Exit 1 instead of recreating a missing root, which would hide an unmounted library. */
function requireLibraryRoot(): string {
    const { root } = libraryPaths();
    if (!libraryRootExists(root)) {
        console.error(
            `[ImageWatcher] Library root not found: ${root}. Check the mount or PHOTOGRAPHY_LIBRARY_DIR. Nothing was processed.`,
        );
        process.exit(1);
    }
    return root;
}

/** A file the identity scan reads, or any folder, since a moved folder moves the photos in it. */
function concernsIdentity(event: LibraryChange, changedPath: string): boolean {
    return event === 'addDir' || event === 'unlinkDir' || scanKind(changedPath) !== null;
}

/** Wait up to `timeoutMs` for the identity pass and build under way. Resolves false if they were still running. */
async function drainIdentity(identity: ReturnType<typeof createIdentityStep>, timeoutMs: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
    });
    try {
        if (await Promise.race([identity.idle().then(() => true), timedOut])) return true;
        console.error(`[identity] A pass or a build was still running after ${timeoutMs / 1000}s. Exiting anyway. The next start picks it up again.`);
        return false;
    } finally {
        clearTimeout(timer);
    }
}

function startWatcher(): void {
    const root = requireLibraryRoot();
    ensureDirectories();
    // With no data root the identity step never runs, so the watch stays exactly as it was before it.
    // Outside production dataRoot() falls back to ./portfolio-data, so dev and `npm run images:watch` count as on.
    const setup = watchSetup(root, { identity: dataRoot() !== null });

    console.log(`[ImageWatcher] Starting chokidar watcher for: ${root}${setup.path === root ? '' : ` (${setup.path})`}`);

    // Not idle before chokidar's ready queues the startup batch, so the identity step's first pass can't build alongside it.
    const handlers = createWatchModeHandlers();
    // A pass reads the library after the legacy step's queued jobs, and asks the watch for any pass it needs next.
    let watch: IdentityWatch | null = null;
    const identity = createIdentityStep({
        legacyIdle: () => handlers.idle(),
        requestPass: (reason, delayMs) => watch?.schedule(reason, delayMs),
    });
    watch = watchIdentity(identity);
    void identity.check(); // The first heartbeat, before the first pass

    const watcher = chokidar.watch(setup.path, setup.options);

    // Events, and the startup batch once the initial scan is ready. Live events still jump ahead of that backlog.
    // The identity step's startup pass comes after that batch.
    attachWatcher(watcher, handlers, {
        root: setup.path,
        force: FORCE,
        onRootRemoved: () => void shutdown(1, `Library root removed: ${root}`),
        onLibraryChange: (event, changedPath) => {
            if (concernsIdentity(event, changedPath)) watch?.schedule('event');
        },
        onReady: () => watch?.schedule('startup', 0),
    });

    // Polling may not report the root itself going away, so check it directly too
    const rootCheck = setInterval(() => {
        if (!libraryRootExists(root)) void shutdown(1, `Library root disappeared: ${root}`);
    }, ROOT_CHECK_MS);

    // Stop taking events, close chokidar, give queued jobs a bounded time to finish, then exit
    let shuttingDown = false;
    async function shutdown(code: number, reason: string): Promise<void> {
        if (shuttingDown) return;
        shuttingDown = true;
        clearInterval(rootCheck);
        (code === 0 ? console.log : console.error)(`[ImageWatcher] ${reason}. Shutting down...`);
        handlers.stop();
        watch?.stop();
        identity.stop();
        try {
            await watcher.close();
        } catch (err) {
            console.error('[ImageWatcher] Error closing watcher:', err);
            code = 1;
        }
        await Promise.all([drainOrReport(handlers, SHUTDOWN_GRACE_MS), drainIdentity(identity, SHUTDOWN_GRACE_MS)]);
        console.log('[ImageWatcher] Watcher closed.');
        process.exit(code);
    }
    
    process.on('SIGINT', () => void shutdown(0, 'Received SIGINT'));
    process.on('SIGTERM', () => void shutdown(0, 'Received SIGTERM'));
    
    console.log('[ImageWatcher] Watching for changes. Press Ctrl+C to exit.');
}

/**
 * The same startup batch watch mode runs, then the identity step's passes
 * and builds, then exit. Returns 1 if any photo failed or changed meanwhile,
 * or if a set failed to build.
 */
async function runOnce(): Promise<number> {
    console.log('[ImageWatcher] Running in one-shot mode...');
    requireLibraryRoot();
    ensureDirectories();
    const handlers = createWatcherHandlers();
    const legacy = await processOnce(handlers, { force: FORCE });
    const identity = await runIdentityOnce({ legacyIdle: () => handlers.idle() });
    return Math.max(legacy, identity);
}

// Main execution
if (ONCE_MODE) {
    runOnce()
        .then((code) => {
            process.exit(code);
        })
        .catch((error) => {
            console.error('[ImageWatcher] Error:', error);
            process.exit(1);
        });
} else {
    startWatcher();
}
