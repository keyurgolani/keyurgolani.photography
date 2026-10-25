// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { watchSetup, type WatchSetup } from '../watcherHandlers';

/** The options scripts/imageWatcher.ts passed chokidar before the identity step, apart from `ignored`. */
const OPTIONS_BEFORE_IDENTITY = {
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
    interval: 2000,
    binaryInterval: 3000,
    alwaysStat: true,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 3000, pollInterval: 500 },
};

let temp: string;
/** The library's real folder. */
let real: string;
/** A symlink to it, which the library root is configured as. */
let link: string;
/** A folder outside the library. */
let outside: string;
const watchers: FSWatcher[] = [];

beforeEach(() => {
    temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kg-watch-setup-')));
    real = path.join(temp, 'library');
    link = path.join(temp, 'library-link');
    outside = path.join(temp, 'outside');
    fs.mkdirSync(path.join(real, 'trips'), { recursive: true });
    fs.mkdirSync(outside);
    fs.symlinkSync(real, link);
    fs.writeFileSync(path.join(real, 'a.jpg'), 'a');
    fs.writeFileSync(path.join(real, 'trips', 'target.jpg'), 'target');
    fs.writeFileSync(path.join(outside, 'far.jpg'), 'far');
    // A top-level link to a nested photo, a linked folder, and a nested link to a file outside
    fs.symlinkSync(path.join(real, 'trips', 'target.jpg'), path.join(real, 'linked.jpg'));
    fs.symlinkSync(outside, path.join(real, 'elsewhere'));
    fs.symlinkSync(path.join(outside, 'far.jpg'), path.join(real, 'trips', 'far.jpg'));
});

afterEach(async () => {
    await Promise.all(watchers.splice(0).map((watcher) => watcher.close()));
    fs.rmSync(temp, { recursive: true, force: true });
});

type Event = [string, string];

/** Start chokidar the way the watcher does, with the same options but faster polling, and collect what it reports. */
async function watch(setup: WatchSetup): Promise<{ events: Event[]; until: (wanted: (events: Event[]) => boolean) => Promise<void> }> {
    const watcher = chokidar.watch(setup.path, {
        ...setup.options,
        interval: 50,
        binaryInterval: 50,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
    });
    watchers.push(watcher);
    const events: Event[] = [];
    for (const event of ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const) {
        watcher.on(event, (changed: string) => { events.push([event, changed]); });
    }
    await new Promise<void>((resolve) => watcher.on('ready', () => resolve()));
    return {
        events,
        async until(wanted) {
            const deadline = Date.now() + 8_000;
            while (!wanted(events)) {
                if (Date.now() > deadline) throw new Error(`Timed out. Events so far: ${JSON.stringify(events)}`);
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
        },
    };
}

const quietFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const has = (event: string, changed: string) => (events: Event[]) => events.some(([name, at]) => name === event && at === changed);

/** A later mtime, so polling sees the change whatever the clock's resolution. */
function touch(file: string, data: string): void {
    fs.writeFileSync(file, data);
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(file, later, later);
}

describe('watchSetup without a data root', () => {
    it('watches the root as configured, with the options from before the identity step', () => {
        const setup = watchSetup(link, { identity: false });
        const { ignored, ...options } = setup.options;

        expect(setup.path).toBe(link);
        // followSymlinks is left at chokidar's default, true, as it was
        expect(options).toStrictEqual(OPTIONS_BEFORE_IDENTITY);
        expect(typeof ignored).toBe('function');
    });

    it('skips only the generated folders, as the old filter did', () => {
        const ignored = watchSetup(link, { identity: false }).options.ignored as (watched: string, stats?: fs.Stats) => boolean;
        const symlinkStats = fs.lstatSync(path.join(real, 'elsewhere'));

        expect(ignored(path.join(link, 'thumbnails'))).toBe(true);
        expect(ignored(path.join(link, 'cache'))).toBe(true);
        expect(ignored(path.join(link, '.DS_Store'))).toBe(false);
        expect(ignored(path.join(link, 'elsewhere'), symlinkStats)).toBe(false);
        expect(ignored(path.join(link, 'linked.jpg'), fs.lstatSync(path.join(real, 'linked.jpg')))).toBe(false);
    });

    it('keeps reporting a symlinked root, through a top-level link, and nothing nested', async () => {
        const watching = await watch(watchSetup(link, { identity: false }));
        await quietFor(300);
        expect(watching.events).toEqual([]);

        fs.writeFileSync(path.join(real, 'b.jpg'), 'b');
        await watching.until(has('add', path.join(link, 'b.jpg')));
        touch(path.join(real, 'trips', 'target.jpg'), 'edited');
        await watching.until(has('change', path.join(link, 'linked.jpg')));
        fs.writeFileSync(path.join(real, 'trips', 'nested.jpg'), 'n');
        await quietFor(500);

        // depth 0: no nested file is polled or reported
        expect(watching.events.filter(([, at]) => at.includes(`${path.sep}trips${path.sep}`))).toEqual([]);
    }, 20_000);
});

describe('watchSetup with a data root', () => {
    it("watches the root's real path at every depth, through symlinks", () => {
        const setup = watchSetup(link, { identity: true });
        const { ignored, ...options } = setup.options;

        expect(setup.path).toBe(real);
        const { depth: _depth, ...before } = OPTIONS_BEFORE_IDENTITY;
        expect(options).toStrictEqual({ ...before, followSymlinks: true });
        expect(typeof ignored).toBe('function');
    });

    it('reports new and nested photos under a symlinked root, and a change through a top-level link', async () => {
        const watching = await watch(watchSetup(link, { identity: true }));
        // No add for the links that were already there
        await quietFor(300);
        expect(watching.events).toEqual([]);

        fs.writeFileSync(path.join(real, 'b.jpg'), 'b');
        await watching.until(has('add', path.join(real, 'b.jpg')));
        fs.writeFileSync(path.join(real, 'trips', 'nested.jpg'), 'n');
        await watching.until(has('add', path.join(real, 'trips', 'nested.jpg')));
        touch(path.join(real, 'trips', 'target.jpg'), 'edited');
        await watching.until(has('change', path.join(real, 'linked.jpg')));
    }, 20_000);

    it('reports nothing reached through a linked folder or a nested link', async () => {
        const watching = await watch(watchSetup(link, { identity: true }));
        touch(path.join(outside, 'far.jpg'), 'edited');
        fs.writeFileSync(path.join(outside, 'new.jpg'), 'new');
        // A change in the library afterwards, so the polls that would have caught those have run
        fs.writeFileSync(path.join(real, 'c.jpg'), 'c');
        await watching.until(has('add', path.join(real, 'c.jpg')));
        await quietFor(500);

        expect(watching.events.filter(([, at]) => at.includes('elsewhere') || at.endsWith(`${path.sep}far.jpg`) || at.endsWith(`${path.sep}new.jpg`))).toEqual([]);
    }, 20_000);
});
