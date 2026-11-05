#!/usr/bin/env node
/**
 * Image Watcher Script
 *
 * Watches the photo library and keeps the data root's identity state and
 * `/media` sets up to date. Uses chokidar for reliable file watching in Docker
 * bind-mount scenarios. It reads the library and never writes it: since
 * v1.7.0 (#13's slice E) it writes no legacy basename derivatives, and
 * leaves any a v1.6 watcher wrote as they are. It never deletes anything.
 *
 * The identity step runs when the data root (PHOTOGRAPHY_DATA_DIR) is ready:
 * each pass reconciles the whole library, nested folders included, and the
 * derivative worker builds the `/media` sets the pass left pending. Library
 * changes, a 10-minute timer, and work another process leaves, looked for
 * every 30 s, schedule a pass, 5 s after the last request. Each pass and each
 * 30 s check update status/watcher.json in the data root, with
 * `legacyDerivatives: false`.
 *
 * The library root is PHOTOGRAPHY_LIBRARY_DIR, /data/library in both compose
 * files, with no default. Both modes exit 1 if it's unset or the root is
 * missing, and watch mode also exits 1 if the root disappears while it runs.
 * Since v2.0.0 (A6) a missing root is first reported as the inbox's
 * `library-unavailable` item in the data root, which `photos status --check`
 * fails on, and a root that is empty or can't be read keeps the watcher
 * running, refusing each pass, looking again after 1 minute and then less
 * often, up to every 10 minutes.
 * Both exit 1 with no data root, since there is nothing else to do. An
 * unknown flag, and --force, which rebuilt the legacy derivatives, exit 2.
 *
 * Usage:
 *   # Watch mode (continuous)
 *   npx tsx scripts/imageWatcher.ts --watch
 *
 *   # One-shot mode (process once and exit)
 *   npx tsx scripts/imageWatcher.ts
 *
 *   # Process and exit. Exits 1 if the data root isn't ready, if a /media
 *   # set failed to build for any reason but a source that moved on, if a
 *   # photo was still changing, or if the derivative worker couldn't start.
 *   npx tsx scripts/imageWatcher.ts --once
 *
 * The image has no tsx, so it runs the bundle `npm run build:scripts` writes,
 * with the same flags: node dist/scripts/imageWatcher.mjs --watch.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import chokidar from 'chokidar';
import { createCandidateSink, owedSettles, settlingAfterBuild } from '../lib/curation/candidates';
import { createCurationSink } from '../lib/curation/sink';
import { createLibraryReporter } from '../lib/curation/library';
import { createSourcesSink, recordingFailuresAfterBuild } from '../lib/curation/sources';
import { buildDerivativeSet } from '../lib/identity/derivatives';
import { jsonLogSink } from '../lib/identity/pass';
import { scanKind } from '../lib/identity/scan';
import { createIdentityStep, runIdentityOnce, watchIdentity, type IdentityWatch } from '../lib/identity/watcherStep';
import { dataRoot, libraryRoot, LibraryRootConfigError } from '../lib/storage/config';
import { attachWatcher, watchSetup, type LibraryChange } from '../utils/watcherHandlers';

/** This script the way it was started: the bundle in the image, or the source under tsx. */
const PROGRAM = fileURLToPath(import.meta.url).endsWith('.mjs') ? 'node dist/scripts/imageWatcher.mjs' : 'npx tsx scripts/imageWatcher.ts';
const USAGE = `Usage: ${PROGRAM} [--watch | --once]`;

/** Strict, so a mistyped flag such as --froce exits 2 instead of being ignored. */
function readFlags(): { once: boolean } {
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
    if (values.force) {
        console.error('[ImageWatcher] --force rebuilt the legacy derivatives, which the watcher no longer writes (v1.7.0). Run it without --force.');
        console.error(USAGE);
        process.exit(2);
    }
    return { once: Boolean(values.once) || !values.watch };
}

const ONCE_MODE = readFlags().once;

/** Docker kills a container 10 s after SIGTERM, so a pass or build under way gets this long to finish. */
const SHUTDOWN_GRACE_MS = 8000;

/** How often watch mode checks that the library root is still there. */
const ROOT_CHECK_MS = 5000;

function libraryRootExists(root: string): boolean {
    try {
        const stat = fs.statSync(root);
        // A host folder deleted from under a bind mount still stats as a directory, with no links left
        return stat.isDirectory() && stat.nlink > 0;
    } catch {
        return false;
    }
}

/**
 * A6 (#17): record the library as missing in the data root's inbox, before
 * an exit, so `photos status --check` sees it. Best effort: with no ready
 * data root it logs why and records nothing. Docker restarts the container
 * with its own backoff, and each start finds the same open item, so a
 * library that stays gone writes nothing more.
 */
async function reportMissingLibrary(): Promise<void> {
    await createLibraryReporter()({ available: false, cause: 'missing' });
}

/**
 * Exit 1 unless the library is configured and there, and the data root is
 * named. Never creates a missing root, which would hide an unmounted library,
 * and never falls back to another folder.
 */
async function requireRoots(): Promise<string> {
    let root: string;
    try {
        root = libraryRoot();
    } catch (error) {
        if (!(error instanceof LibraryRootConfigError)) throw error;
        console.error(`[ImageWatcher] ${error.message} Nothing was processed.`);
        process.exit(1);
    }
    if (!libraryRootExists(root)) {
        console.error(
            `[ImageWatcher] Library root not found: ${root}. Check the mount or PHOTOGRAPHY_LIBRARY_DIR. Nothing was processed.`,
        );
        if (dataRoot() !== null) await reportMissingLibrary();
        process.exit(1);
    }
    // Outside production dataRoot() falls back to ./portfolio-data, so this only stops an unconfigured production watcher.
    if (dataRoot() === null) {
        console.error('[ImageWatcher] PHOTOGRAPHY_DATA_DIR is not set, and the watcher writes nothing but the data root, so it has nothing to do. Set it to the data root: /data/portfolio in both compose files.');
        process.exit(1);
    }
    return root;
}

/** The replacement items a build couldn't settle yet, which the candidate sink settles on its next delivery. One per process. */
const owed = owedSettles();

/** The failed-build items a build couldn't settle yet, which the sources sink settles on its next delivery. One per process. */
const owedSources = owedSettles();

/**
 * Where the identity step's facts go: the log, the curation inbox, which
 * opens a draft item for each, then #17's candidate sink, which records on
 * each replacement item whether its new set is ready or failed, and #17's
 * sources sink, which closes a missing item once its source is back and
 * opens an item for each build that stays failed.
 */
function factSinks() {
    return [jsonLogSink(), createCurationSink(), createCandidateSink({ owed }), createSourcesSink({ owed: owedSources })];
}

/** The derivative worker's builds, each followed by recording its set on the revision's replacement item and settling a failed build's item, or owing those to their sinks. */
function workerBuilds() {
    return { build: recordingFailuresAfterBuild(settlingAfterBuild(buildDerivativeSet, { owed }), { owed: owedSources }) };
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

async function startWatcher(): Promise<void> {
    const root = await requireRoots();
    const setup = watchSetup(root);

    console.log(`[ImageWatcher] Starting chokidar watcher for: ${root}${setup.path === root ? '' : ` (${setup.path})`}`);

    // A pass asks the watch for any pass it needs next.
    let watch: IdentityWatch | null = null;
    const identity = createIdentityStep({
        sinks: factSinks(),
        worker: workerBuilds(),
        library: createLibraryReporter(),
        requestPass: (reason, delayMs) => watch?.schedule(reason, delayMs),
    });
    watch = watchIdentity(identity);
    void identity.check(); // The first heartbeat, before the first pass

    const watcher = chokidar.watch(setup.path, setup.options);

    // The startup pass runs once chokidar has its baseline, so a file saved during the initial scan isn't missed.
    attachWatcher(watcher, {
        root: setup.path,
        onRootRemoved: () => void shutdown(1, `Library root removed: ${root}`, { libraryGone: true }),
        onLibraryChange: (event, changedPath) => {
            if (concernsIdentity(event, changedPath)) watch?.schedule('event');
        },
        onReady: () => watch?.schedule('startup', 0),
    });

    // Polling may not report the root itself going away, so check it directly too
    const rootCheck = setInterval(() => {
        if (!libraryRootExists(root)) void shutdown(1, `Library root disappeared: ${root}`, { libraryGone: true });
    }, ROOT_CHECK_MS);

    // Stop taking events, close chokidar, give a pass or build under way a bounded time to finish, then exit
    let shuttingDown = false;
    async function shutdown(code: number, reason: string, { libraryGone = false }: { libraryGone?: boolean } = {}): Promise<void> {
        if (shuttingDown) return;
        shuttingDown = true;
        clearInterval(rootCheck);
        (code === 0 ? console.log : console.error)(`[ImageWatcher] ${reason}. Shutting down...`);
        watch?.stop();
        identity.stop();
        // A6: a bind mount whose host folder went needs a restart to see it again, so report it before going.
        if (libraryGone) await reportMissingLibrary();
        try {
            await watcher.close();
        } catch (err) {
            console.error('[ImageWatcher] Error closing watcher:', err);
            code = 1;
        }
        await drainIdentity(identity, SHUTDOWN_GRACE_MS);
        console.log('[ImageWatcher] Watcher closed.');
        process.exit(code);
    }

    process.on('SIGINT', () => void shutdown(0, 'Received SIGINT'));
    process.on('SIGTERM', () => void shutdown(0, 'Received SIGTERM'));

    console.log('[ImageWatcher] Watching for changes. Press Ctrl+C to exit.');
}

/**
 * The identity step's passes and builds, then exit. Returns 1 if the data
 * root isn't ready, if a set failed to build, or if a photo was still changing.
 */
async function runOnce(): Promise<number> {
    console.log('[ImageWatcher] Running in one-shot mode...');
    await requireRoots();
    return runIdentityOnce({ sinks: factSinks(), worker: workerBuilds(), library: createLibraryReporter() });
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
    startWatcher().catch((error) => {
        console.error('[ImageWatcher] Error:', error);
        process.exit(1);
    });
}
