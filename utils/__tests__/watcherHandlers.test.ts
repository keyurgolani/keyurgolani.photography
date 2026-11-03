// @vitest-environment node
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FSWatcherEventMap } from 'chokidar';
import { scanLibrary } from '../../lib/identity/scan';
import { REPO_ROOT } from '../../test/helpers/runTsx';
import { createTempLibrary, type TempLibrary } from '../../test/helpers/tempLibrary';
import { attachWatcher, createIgnoreFilter } from '../watcherHandlers';

const BASIC = ['landscape.jpg', 'portrait.png', 'square.webp'];

let lib: TempLibrary;

const logger = { log: vi.fn(), error: vi.fn() };

beforeEach(async () => {
    lib = await createTempLibrary({ fixtures: 'basic' });
});

afterEach(async () => {
    await lib.cleanup();
    vi.clearAllMocks();
});

describe('attachWatcher', () => {
    it('reports every change in the library, nested ones included, and only the root\'s removal as that', () => {
        const watcher = new EventEmitter<FSWatcherEventMap>();
        const changes: [string, string][] = [];
        const onRootRemoved = vi.fn();
        attachWatcher(watcher, {
            root: lib.root,
            logger,
            onRootRemoved,
            onLibraryChange: (event, changed) => { changes.push([event, changed]); },
        });

        watcher.emit('add', lib.file('a.jpg'));
        watcher.emit('add', lib.file('trips', 'b.jpg'));
        watcher.emit('change', lib.file('trips', 'b.jpg'));
        watcher.emit('unlink', lib.file('c.jpg'));
        watcher.emit('addDir', lib.file('series'));
        watcher.emit('unlinkDir', lib.file('series'));
        // The root itself is no change in the library: its removal shuts the watcher down instead.
        watcher.emit('addDir', lib.root);
        expect(onRootRemoved).not.toHaveBeenCalled();
        watcher.emit('unlinkDir', lib.root);

        expect(onRootRemoved).toHaveBeenCalledTimes(1);
        expect(changes).toEqual([
            ['add', lib.file('a.jpg')],
            ['add', lib.file('trips', 'b.jpg')],
            ['change', lib.file('trips', 'b.jpg')],
            ['unlink', lib.file('c.jpg')],
            ['addDir', lib.file('series')],
            ['unlinkDir', lib.file('series')],
        ]);
    });

    it('calls onReady once chokidar has its baseline, and writes nothing in the library on any event', () => {
        const watcher = new EventEmitter<FSWatcherEventMap>();
        const onReady = vi.fn();
        const before = lib.snapshot();
        attachWatcher(watcher, { root: lib.root, logger, onRootRemoved: () => undefined, onReady });
        expect(onReady).not.toHaveBeenCalled();

        watcher.emit('ready');
        for (const name of BASIC) {
            watcher.emit('add', lib.file(name));
            watcher.emit('change', lib.file(name));
        }

        expect(onReady).toHaveBeenCalledTimes(1);
        expect(lib.snapshot()).toEqual(before);
    });

    it('is the watcher\'s only link to the library: no source in utils or scripts writes legacy derivatives any more', () => {
        // The script runs when it's imported, so this reads it instead.
        const script = fs.readFileSync(path.join(REPO_ROOT, 'scripts/imageWatcher.ts'), 'utf8');
        expect(script).not.toMatch(/imageOptimizer|ensureDirectories|createWatcherHandlers|processOnce|refreshImage|reprocessImage/);
        const handlers = fs.readFileSync(path.join(REPO_ROOT, 'utils/watcherHandlers.ts'), 'utf8');
        expect(handlers).not.toMatch(/from '\.\/imageOptimizer'/);
    });
});

describe('createIgnoreFilter', () => {
    it('skips the generated folders by exact name under the root, never by substring', () => {
        const ignored = createIgnoreFilter('/srv/cache/photos');

        expect(ignored('/srv/cache/photos')).toBe(false);
        expect(ignored('/srv/cache/photos/landscape.jpg')).toBe(false);
        expect(ignored('/srv/cache/photos/thumbnails-beach.jpg')).toBe(false);
        expect(ignored('/srv/cache/photos/optimized-avif')).toBe(true);
        expect(ignored('/srv/cache/photos/thumbnails/landscape.webp')).toBe(true);
        expect(ignored('/srv/cache/photos/lqip')).toBe(true);
        expect(ignored('/srv/cache/photos/cache')).toBe(true);
        expect(ignored('/srv/cache')).toBe(false);
    });

    it('skips dot-entries at any depth and watches nested folders, even ones named like a generated folder', () => {
        const ignored = createIgnoreFilter('/srv/photos');

        expect(ignored('/srv/photos/.DS_Store')).toBe(true);
        expect(ignored('/srv/photos/._landscape.jpg')).toBe(true);
        expect(ignored('/srv/photos/trips/.hidden')).toBe(true);
        expect(ignored('/srv/photos/trips/.hidden/x.jpg')).toBe(true);
        expect(ignored('/srv/photos/trips')).toBe(false);
        expect(ignored('/srv/photos/trips/x.jpg')).toBe(false);
        expect(ignored('/srv/photos/trips/thumbnails/x.webp')).toBe(false);
        expect(ignored('/srv/photos/cache-1.jpg')).toBe(false);
    });

    it('skips exactly what the identity scan skips', async () => {
        const files = [
            'a.jpg', '.b.jpg', 'cache-1.jpg', 'medium-format.jpg', 'notes.txt', 'raw.heic',
            'trips/c.jpg', 'trips/.d.jpg', 'trips/deep/e.png', 'trips/thumbnails/f.webp',
            '.hidden/g.jpg', 'thumbnails/h.webp', 'cache/dynamic/i.webp', 'optimized-avif/j.avif',
        ];
        for (const relativePath of files) {
            fs.mkdirSync(path.dirname(lib.file(relativePath)), { recursive: true });
            fs.writeFileSync(lib.file(relativePath), 'not decoded by a scan');
        }
        const ignored = createIgnoreFilter(lib.root);
        // chokidar never descends into an ignored folder, so a file counts as watched only if it and every folder above it are.
        const watched = (relativePath: string) => relativePath.split('/').every((_, index, segments) => !ignored(lib.file(...segments.slice(0, index + 1))));

        const scanned = (await scanLibrary(lib.root)).entries.map((entry) => entry.path).sort();
        // Every file with an extension the scan reads, the fixtures from beforeEach included.
        const scannable = [...BASIC, ...files].filter((relativePath) => !relativePath.endsWith('.txt'));
        expect(scannable.filter(watched).sort()).toEqual(scanned);
        expect(scanned).toEqual([...BASIC, 'a.jpg', 'cache-1.jpg', 'medium-format.jpg', 'raw.heic', 'trips/c.jpg', 'trips/deep/e.png', 'trips/thumbnails/f.webp'].sort());
    });
});
