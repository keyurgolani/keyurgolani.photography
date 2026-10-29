import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { runCarryOver } from '../../lib/catalog/carry-over';
import { publish } from '../../lib/catalog/publish';
import { readWorkingLayer } from '../../lib/catalog/working-layer';
import { createCurationSink } from '../../lib/curation/sink';
import { readRegistry, writeRegistry } from '../../lib/identity/registry';
import { runIdentityOnce } from '../../lib/identity/watcherStep';
import { writeDataRootMarker } from '../../test/helpers/tempDataRoot';
import { processImage } from '../../utils/imageOptimizer';

/**
 * A site at the launch, through the real pipeline: a library of twelve
 * photographs the legacy Gallery lists, so its names run past one digit,
 * with their legacy derivatives, the watcher's IDs, catalog sets and inbox
 * items. Three more test the edges: unready.jpg is on the Gallery but its
 * catalog set failed, so the carry-over can't take it until --allow-missing
 * names it, broken.jpg is a file the watcher can't read, and thumbless.jpg
 * lost a legacy thumbnail, so the Gallery doesn't show it today, though the
 * site still counts it as on it, so it needs naming too. Then
 * `photos carry-over --apply --allow-missing unready.jpg,thumbless.jpg` and
 * the launch publish. A sixteenth photograph arrives after it, as one the owner adds
 * later. Test files and test values only, in a temp folder outside the
 * repository.
 */

export interface CarryOverFixture {
    root: string;
    library: string;
    /** Photo IDs by file name. */
    ids: Record<string, string>;
    /** The Gallery's order, as legacy /api/photos listed it, which the carried series keeps: newest capture first, undated last. */
    order: string[];
    /** What the dry run printed and exited with, then the apply. */
    output: { dryRun: string; dryRunExit: number; apply: string };
    gone: number;
    cleanup(): Promise<void>;
}

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined, info: () => undefined };

/** A landscape gradient, so the shots show photographs and not flat blocks. */
async function photograph(from: string, to: string, day: string | null): Promise<Buffer> {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/><circle cx="860" cy="250" r="105" fill="#f5e6c8" opacity="0.8"/><rect y="570" width="1200" height="230" fill="#1d2a2f" opacity="0.55"/></svg>`;
    const image = sharp(Buffer.from(svg));
    return (day ? image.withExif({ IFD2: { DateTimeOriginal: `${day.replace(/-/g, ':')} 12:00:00` } }) : image).jpeg({ quality: 82 }).toBuffer();
}

/** Run `fn` with the library and data root this fixture uses, as the CLI would see them. */
async function withRoots<T>(library: string, root: string, fn: () => Promise<T>): Promise<T> {
    const previous = { library: process.env.PHOTOGRAPHY_LIBRARY_DIR, root: process.env.PHOTOGRAPHY_DATA_DIR };
    process.env.PHOTOGRAPHY_LIBRARY_DIR = library;
    process.env.PHOTOGRAPHY_DATA_DIR = root;
    try {
        return await fn();
    } finally {
        if (previous.library === undefined) delete process.env.PHOTOGRAPHY_LIBRARY_DIR;
        else process.env.PHOTOGRAPHY_LIBRARY_DIR = previous.library;
        if (previous.root === undefined) delete process.env.PHOTOGRAPHY_DATA_DIR;
        else process.env.PHOTOGRAPHY_DATA_DIR = previous.root;
    }
}

const pass = () => runIdentityOnce({ sinks: [createCurationSink({ logger: quiet })], logger: quiet, pass: { clock: () => Date.now() + 60_000 } });

export async function createCarryOverFixture(): Promise<CarryOverFixture> {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-carry-over-'));
    const library = path.join(temp, 'library');
    const root = path.join(temp, 'data');
    fs.mkdirSync(library);
    fs.mkdirSync(root);
    writeDataRootMarker(root);
    const palette: [string, string][] = [
        ['#29506b', '#d9a066'], ['#7a5c3e', '#e8d3a8'], ['#1f3b2c', '#9fb8a0'], ['#4b2e3e', '#e0a7a0'],
        ['#203040', '#88a8c8'], ['#5a4a20', '#d8c890'], ['#2e2240', '#b0a0d8'], ['#183830', '#80c0a8'],
        ['#40281c', '#d89870'], ['#30383c', '#c0c8cc'], ['#3c2c18', '#e0c080'], ['#1c2c3c', '#a0b8d0'],
    ];
    // Eleven dated across two years, newest first in the Gallery, and the last one undated, which the Gallery puts last.
    const photos: [string, Buffer][] = await Promise.all(palette.map(async ([from, to], n): Promise<[string, Buffer]> => [
        `place-${String(n + 1).padStart(2, '0')}.jpg`,
        await photograph(from, to, n === palette.length - 1 ? null : `202${3 + (n % 2)}-${String(1 + n).padStart(2, '0')}-1${n % 9}`),
    ]));
    return withRoots(library, root, async () => {
        for (const [name, bytes] of photos) fs.writeFileSync(path.join(library, name), bytes);
        const edges: [string, Buffer][] = [
            ['unready.jpg', await photograph('#502020', '#d0a0a0', '2022-05-05')],
            ['thumbless.jpg', await photograph('#205020', '#a0d0a0', '2022-06-06')],
        ];
        for (const [name, bytes] of edges) fs.writeFileSync(path.join(library, name), bytes);
        fs.writeFileSync(path.join(library, 'broken.jpg'), 'not a photograph');
        for (const [name] of [...photos, ...edges]) await processImage(name);
        // thumbless.jpg's legacy thumbnail goes aside, so today's Gallery doesn't list it, though the registry still does.
        const thumbnail = fs.readdirSync(path.join(library, 'thumbnails')).find((name) => name.startsWith('thumbless'));
        if (!thumbnail) throw new Error('thumbless.jpg has no legacy thumbnail to set aside');
        fs.renameSync(path.join(library, 'thumbnails', thumbnail), path.join(temp, thumbnail));
        if ((await pass()) !== 0) throw new Error('The watcher pass for the carry-over fixture failed');
        // unready.jpg's catalog set failed, so no revision can publish it, though the Gallery shows it.
        const built = await readRegistry(root);
        const unready = Object.values(built.photos).find((photo) => photo.source.path === 'unready.jpg');
        if (!unready) throw new Error('unready.jpg has no photo ID');
        const revision = unready.revisions[unready.source.observedRevision];
        for (const profile of Object.keys(revision.profiles)) revision.profiles[profile] = { state: 'failed', attempts: 3, error: 'fixture' };
        await writeRegistry(root, built, built.version);
        const dryRun = await runCarryOver({ dataRoot: root });
        const apply = await runCarryOver({ dataRoot: root }, { apply: true, actor: 'e2e', allow: ['unready.jpg', 'thumbless.jpg'] });
        if (apply.exitCode !== 0) throw new Error(`The carry-over exited ${apply.exitCode}:\n${apply.output}`);
        const dry = await publish({ dataRoot: root, actor: 'e2e', dryRun: true, logger: quiet });
        const gone = dry.launch?.gone ?? -1;
        const live = await publish({ dataRoot: root, actor: 'e2e', reason: 'carry-over fixture launch', confirmLaunch: true, logger: quiet });
        if (live.outcome !== 'PUBLISHED') throw new Error(`The launch publish ended ${live.outcome}: ${live.message}`);
        // A photograph the owner adds after the launch: the Inbox should show only this one.
        fs.writeFileSync(path.join(library, 'later.jpg'), await photograph('#3a2f5c', '#c9a6d8', '2025-01-02'));
        if ((await pass()) !== 0) throw new Error('The watcher pass for the later photograph failed');
        const registry = await readRegistry(root);
        const ids = Object.fromEntries(Object.values(registry.photos).map((photo) => [photo.source.path, photo.photoId]));
        const order = (await readWorkingLayer(root)).series.find((series) => series.id === 'ser_gallery')?.photoIds ?? [];
        if (order.length !== photos.length) throw new Error(`The carry-over placed ${order.length} of ${photos.length} photographs`);
        return {
            root,
            library,
            ids,
            order,
            output: { dryRun: dryRun.output, dryRunExit: dryRun.exitCode, apply: apply.output },
            gone,
            cleanup: async () => fs.rmSync(temp, { recursive: true, force: true }),
        };
    });
}
