// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildExif, withSegments } from '../../../test/fixtures/exif';
import { fixtureFiles } from '../../../test/fixtures/makeLibrary';
import { runTsx } from '../../../test/helpers/runTsx';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { migrateDryRun } from '../../identity/migration';
import { jsonLogSink, runReconcilePass, type PassOptions } from '../../identity/pass';
import { currentProfileId } from '../../identity/profile';
import { readRegistry, writeRegistry } from '../../identity/registry';
import type { IdentityFactType, Registry } from '../../identity/types';
import { VARIANT_FORMATS, VARIANT_PIXELS, VARIANT_WIDTHS } from '../../identity/variants';
import { mediaUrl } from '../../media/url';
import { runRules } from '../rules';
import { parseRevisionFile, revisionIdOf } from '../schema';
import { applySequenceOp } from '../sequence';
import { assertOrderUntouched, createTestCatalog, type OrderStep } from '../testing';
import type { CandidateContent, RevisionFile } from '../types';
import { authoredPaths, catalogPaths, readAuthoredRecord, readWorkingLayer } from '../working-layer';
import { writeAuthoredRecord } from '../working-layer-writer';

const SERIES = 'ser_invariance';
const DRAFT = 'ser_invariance-draft';
const LQIP = 'data:image/webp;base64,UklGRlYAAABXRUJQVlA4IEoAAADQAQCdASoKAAoAAUAmJYgCdAEO9ACA/v9P9f96f1AAAAAAfQ==';
const ALL_FACT_TYPES: IdentityFactType[] = ['new', 'renamed', 'reappeared', 'replaced', 'metadata-changed', 'ambiguous', 'missing', 'processing-failed'];

let fixtures: Map<string, Buffer>;
let fresh: Buffer;
let thumbnail: Buffer;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    fixtures = await fixtureFiles({ extras: true });
    // Pixels no other fixture has, for a replacement.
    fresh = await sharp({ create: { width: 720, height: 720, channels: 3, background: { r: 30, g: 90, b: 160 } } }).webp({ quality: 90 }).toBuffer();
    thumbnail = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } } }).jpeg().toBuffer();
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const bytesOf = (name: string) => {
    const bytes = fixtures.get(name);
    if (!bytes) throw new Error(`No fixture ${name}`);
    return bytes;
};

/** landscape.jpg's pixels with EXIF capture and modify dates, as a re-export writes them. */
function withDates(jpeg: Buffer, { original, modified }: { original: string; modified: string }): Buffer {
    const exif = buildExif({
        ifd0: { 0x0132: { type: 'ascii', value: modified } },
        exif: { 0x9003: { type: 'ascii', value: original } },
        gps: {},
        thumbnail,
    });
    return withSegments(jpeg, [{ marker: 0xe1, payload: exif }]);
}

function sequentialIds(): () => string {
    let next = 0;
    return () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}`;
}

interface Fixture {
    lib: TempLibrary;
    data: TempDataRoot;
    /** The published series' members, in path order: landscape.jpg, portrait.png, square.webp. */
    members: string[];
    revision: RevisionFile;
    options(extra?: PassOptions): PassOptions;
    /** One reconcile pass through the existing sink, and the fact types it committed. */
    pass(): Promise<IdentityFactType[]>;
    put(target: string, bytes: Buffer): void;
}

function publicPhoto(registry: Registry, photoId: string, index: number, profileId: string): CandidateContent['photos'][number] {
    const photo = registry.photos[photoId];
    const revision = photo.revisions[photo.source.observedRevision];
    const width = revision.width ?? 1;
    const height = revision.height ?? 1;
    const variants = Object.fromEntries(VARIANT_WIDTHS.map((variant) => {
        const scaled = Math.min(VARIANT_PIXELS[variant], width);
        const size = { width: scaled, height: Math.max(1, Math.round((scaled * height) / width)) };
        const formats = Object.fromEntries(VARIANT_FORMATS.map((format) => [format, { url: mediaUrl({ photoId, assetRevision: revision.assetRevision, profileId }, variant, format), ...size, bytes: 1_000 }]));
        return [variant, formats];
    })) as CandidateContent['photos'][number]['variants'];
    return {
        id: photoId,
        assetRevision: revision.assetRevision,
        profileId,
        width,
        height,
        aspectRatio: Math.round((width / height) * 10_000) / 10_000,
        variants,
        lqip: LQIP,
        technical: {},
        alt: { kind: 'described', text: `Fixture description of photograph ${index + 1}.` },
    };
}

/**
 * A library of three photographs that a reconcile pass has minted IDs for, a
 * published revision of them as #13's publish would write it, and the
 * working layer that revision came from: a published series with a cover,
 * an opening photo, and two chapters, a draft series, and the site record.
 */
async function prepare(): Promise<Fixture> {
    const lib = await createTempLibrary();
    cleanups.push(() => lib.cleanup());
    const data = createTempDataRoot();
    cleanups.push(() => data.cleanup());
    const put = (target: string, bytes: Buffer) => {
        fs.mkdirSync(path.dirname(lib.file(target)), { recursive: true });
        fs.writeFileSync(lib.file(target), bytes);
    };
    for (const name of ['landscape.jpg', 'portrait.png', 'square.webp']) put(name, bytesOf(name));

    const ids = sequentialIds();
    const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
    const options = (extra: PassOptions = {}): PassOptions => ({
        // Files written just now would be too fresh to read, so passes run a minute later.
        clock: () => Date.now() + 60_000,
        idGen: ids,
        logger: quiet,
        sinks: [jsonLogSink(quiet)],
        ...extra,
    });
    const pass = async () => {
        const outcome = await runReconcilePass(options());
        if (outcome.status !== 'committed') throw new Error(`The pass didn't commit: ${JSON.stringify(outcome)}`);
        return outcome.facts.map((fact) => fact.type);
    };
    await pass();

    const root = data.root;
    const registry = await readRegistry(root);
    const members = Object.values(registry.photos).sort((a, b) => (a.source.path < b.source.path ? -1 : 1)).map((photo) => photo.photoId);
    const profileId = currentProfileId();
    const chapters = [
        { id: 'ch_one', title: 'Fixture chapter one', startPhotoId: members[0] },
        { id: 'ch_two', title: 'Fixture chapter two', startPhotoId: members[2] },
    ];
    const cover = { photoId: members[0], focalPoint: { x: 0.5, y: 0.4 } };
    const copy = { title: 'Fixture series', statement: 'Fixture statement. Not real copy.', shortStatement: 'Fixture short statement.' };
    const content: CandidateContent = {
        site: { featuredSeriesIds: [SERIES] },
        series: [{ id: SERIES, slug: 'invariance', slugAliases: [], ...copy, photoIds: members, chapters, openingPhotoId: members[1], cover, derived: { photoCount: members.length } }],
        photos: members.map((photoId, index) => publicPhoto(registry, photoId, index, profileId)).sort((a, b) => (a.id < b.id ? -1 : 1)),
    };
    const revisionId = revisionIdOf(content);
    const parsed = parseRevisionFile({ revisionId, schemaVersion: 1, baseRevisionId: null, compiledAt: '2026-01-01T00:00:00.000Z', content });
    if (!parsed.ok) throw new Error(`The fixture revision is invalid: ${JSON.stringify(parsed.error.issues)}`);
    const paths = catalogPaths(root);
    fs.mkdirSync(paths.revisionsDir, { recursive: true });
    fs.mkdirSync(paths.candidatesDir, { recursive: true });
    fs.writeFileSync(path.join(paths.revisionsDir, `${revisionId}.json`), `${JSON.stringify(parsed.value, null, 2)}\n`);
    fs.writeFileSync(path.join(paths.candidatesDir, `${revisionId}.json`), `${JSON.stringify(parsed.value, null, 2)}\n`);
    fs.writeFileSync(paths.active, `${JSON.stringify({ schemaVersion: 1, revisionId, activationId: 'act_00000000-0000-4000-8000-000000000001' }, null, 2)}\n`);

    for (const [index, photoId] of members.entries()) {
        await writeAuthoredRecord({ kind: 'photo', id: photoId, assetRevision: registry.photos[photoId].source.observedRevision, alt: { kind: 'described', text: `Fixture description of photograph ${index + 1}.`, reviewed: true } }, { expectedVersion: 0, root });
    }
    await writeAuthoredRecord({ kind: 'series', id: SERIES, slug: 'invariance', ...copy, photoIds: members, chapters, openingPhotoId: members[1], cover, visibility: 'published' }, { expectedVersion: 0, root });
    await writeAuthoredRecord({ kind: 'series', id: DRAFT, slug: 'invariance-draft', visibility: 'draft' }, { expectedVersion: 0, root });
    await writeAuthoredRecord({ kind: 'site', featuredSeriesIds: [SERIES], seriesOrder: [SERIES, DRAFT] }, { expectedVersion: 0, root });
    return { lib, data, members, revision: parsed.value, options, pass, put };
}

/** The watcher run `npm run images:process` starts, against the temp roots. */
async function runWatcherOnce(fixture: Fixture, ...args: string[]): Promise<void> {
    const run = await runTsx('scripts/imageWatcher.ts', ['--once', ...args], {
        env: { PHOTOGRAPHY_LIBRARY_DIR: fixture.lib.root, PHOTOGRAPHY_DATA_DIR: fixture.data.root },
    });
    if (run.code !== 0) throw new Error(`The watcher exited ${run.code}:\n${run.stdout}\n${run.stderr}`);
}

describe('assertOrderUntouched', () => {
    it('names a step that changes, adds, or removes a file under catalog/ or authored/', async () => {
        const catalog = await createTestCatalog({ seed: 81 });
        cleanups.push(() => catalog.cleanup());
        const seriesId = catalog.series[0].id;
        const editor = { name: 'an editor operation', run: () => applySequenceOp({ dataRoot: catalog.root }, { kind: 'move', seriesId, photoId: catalog.series[0].photoIds[0], at: 'end' }, { expectedVersion: 1, actor: { kind: 'editor' } }) };
        await expect(assertOrderUntouched(catalog.root, [{ name: 'nothing', run: () => undefined }, editor]))
            .rejects.toThrow(`The step "an editor operation" touched authored order: changed authored/series/${seriesId}.json.`);
        const added = {
            name: 'a stray candidate',
            run: () => {
                fs.mkdirSync(catalogPaths(catalog.root).candidatesDir, { recursive: true });
                fs.writeFileSync(path.join(catalogPaths(catalog.root).candidatesDir, 'x.json'), '{}');
            },
        };
        await expect(assertOrderUntouched(catalog.root, [added])).rejects.toThrow('added catalog/candidates/x.json');
        const removed = { name: 'a deleted photo record', run: () => fs.rmSync(path.join(authoredPaths(catalog.root).photosDir, `${catalog.photos[0].id}.json`)) };
        await expect(assertOrderUntouched(catalog.root, [removed])).rejects.toThrow(`removed authored/photos/${catalog.photos[0].id}.json`);
    });

    it('refuses a data root with nothing to compare', async () => {
        const data = createTempDataRoot();
        cleanups.push(() => data.cleanup());
        await expect(assertOrderUntouched(data.root, [])).rejects.toThrow(/nothing to compare/);
    });
});

describe('reconcile never authors order', () => {
    it('leaves catalog/ and authored/ byte-identical through every fact type, the sinks, and the migration dry run', async () => {
        const fixture = await prepare();
        const { lib, members, put } = fixture;
        const [landscape, portrait, square] = members;
        const seen = new Set<IdentityFactType>();
        const scan = (name: string, edit: () => unknown, expected: IdentityFactType[] = []): OrderStep => ({
            name,
            run: async () => {
                await edit();
                const types = await fixture.pass();
                for (const type of types) seen.add(type);
                expect(types.sort(), name).toEqual([...expected].sort());
            },
        });
        const exported = withDates(bytesOf('landscape.jpg'), { original: '2024:05:01 10:00:00', modified: '2024:05:01 10:00:00' });
        const reexported = withDates(bytesOf('landscape.jpg'), { original: '2024:05:01 10:00:00', modified: '2025:02:03 04:05:06' });

        await assertOrderUntouched(fixture.data.root, [
            scan('a repeat pass over unchanged sources', () => undefined),
            scan('an mtime change', () => fs.utimesSync(lib.file('square.webp'), new Date('2020-01-01'), new Date('2020-01-01'))),
            scan('a birthtime reset: the same bytes as a new file', () => {
                const bytes = fs.readFileSync(lib.file('square.webp'));
                fs.rmSync(lib.file('square.webp'));
                put('square.webp', bytes);
            }),
            scan('an EXIF DateTimeOriginal edit', () => put('landscape.jpg', exported), ['metadata-changed']),
            scan('an EXIF ModifyDate edit', () => put('landscape.jpg', reexported), ['metadata-changed']),
            scan('a new photograph', () => put('added.jpg', bytesOf('landscape-edited.jpg')), ['new']),
            scan('a rename, seen in one scan', () => fs.renameSync(lib.file('portrait.png'), lib.file('portrait-renamed.png')), ['renamed']),
            scan('a same-bytes copy', () => fs.copyFileSync(lib.file('portrait-renamed.png'), lib.file('portrait-copy.png')), ['new']),
            scan('a rename arriving as an add, then an unlink: the original goes', () => fs.rmSync(lib.file('portrait-renamed.png')), ['missing']),
            scan('a replacement with new pixels', () => put('square.webp', fresh), ['replaced']),
            {
                name: 'a member\'s source deleted while its pinned profile is ready',
                run: async () => {
                    const registry = await readRegistry(fixture.data.root);
                    const pinned = (await readAuthoredRecord(fixture.data.root, 'photo', landscape))?.assetRevision as string;
                    registry.photos[landscape].revisions[pinned].profiles[currentProfileId()] = { state: 'ready', attempts: 1, readyAt: '2026-01-01T00:00:00.000Z' };
                    await writeRegistry(fixture.data.root, registry, registry.version);
                    fs.rmSync(lib.file('landscape.jpg'));
                    expect(await fixture.pass()).toEqual(['missing']);
                    seen.add('missing');
                    const issues = runRules({
                        candidate: fixture.revision.content,
                        authored: await readWorkingLayer(fixture.data.root),
                        active: fixture.revision,
                        registry: await readRegistry(fixture.data.root),
                        roots: { dataRoot: fixture.data.root, libraryRoot: lib.root },
                    });
                    // The portrait went missing two steps back with a pending profile, so it gets no warning.
                    expect(issues).toEqual([expect.objectContaining({ code: 'order.source-missing', severity: 'warning', record: { kind: 'series', id: SERIES }, field: 'photoIds[0]' })]);
                },
            },
            scan('a rename arriving as an unlink, then an add', () => put('landscape-moved.jpg', reexported), ['renamed']),
            scan('a member deleted', () => fs.rmSync(lib.file('square.webp')), ['missing']),
            scan('the same file back at its path', () => put('square.webp', fresh), ['reappeared']),
            scan('ambiguous evidence: one photo\'s bytes at another\'s path', () => put('added.jpg', bytesOf('portrait.png')), ['ambiguous']),
            scan('an undecodable file', () => put('corrupt.jpg', bytesOf('corrupt.jpg')), ['new', 'processing-failed']),
            scan('an unsupported format', () => put('raw.dng', Buffer.from('fixture raw file, not a real DNG\n')), ['processing-failed']),
            {
                name: 'the migration dry run',
                run: async () => {
                    await migrateDryRun({ ...fixture.options(), settleMs: 0 });
                },
            },
            scan('a final repeat pass', () => undefined),
        ]);

        expect([...seen].sort()).toEqual([...ALL_FACT_TYPES].sort());
        // Identity moved underneath, but the published members keep their IDs and positions.
        expect((await readAuthoredRecord(fixture.data.root, 'series', SERIES))?.photoIds).toEqual([landscape, portrait, square]);
    }, 120_000);

    it('lets an editor operation beside a reconcile pass change authored bytes, and only by that operation', async () => {
        const fixture = await prepare();
        fs.renameSync(fixture.lib.file('portrait.png'), fixture.lib.file('portrait-renamed.png'));
        const before = await readAuthoredRecord(fixture.data.root, 'series', SERIES);
        const others = ['authored/site.json', `authored/series/${DRAFT}.json`, ...fixture.members.map((id) => `authored/photos/${id}.json`)]
            .map((file) => [file, fs.readFileSync(path.join(fixture.data.root, file), 'utf8')] as const);

        const [types, result] = await Promise.all([
            fixture.pass(),
            applySequenceOp({ dataRoot: fixture.data.root }, { kind: 'move', seriesId: SERIES, photoId: fixture.members[1], at: 'end' }, { expectedVersion: before?.version ?? 0, actor: { kind: 'editor' } }),
        ]);

        expect(types).toEqual(['renamed']);
        expect(result).toMatchObject({ ok: true, changed: true });
        const after = await readAuthoredRecord(fixture.data.root, 'series', SERIES);
        expect(after).toEqual({ ...before, version: (before?.version ?? 0) + 1, photoIds: [fixture.members[0], fixture.members[2], fixture.members[1]] });
        for (const [file, text] of others) expect(fs.readFileSync(path.join(fixture.data.root, file), 'utf8'), file).toBe(text);
    }, 60_000);
});

describe('the watcher never authors order', () => {
    it('leaves catalog/ and authored/ byte-identical at startup and after each kind of library edit', async () => {
        const fixture = await prepare();
        const { lib, put } = fixture;
        const run = (name: string, edit: () => unknown, ...args: string[]): OrderStep => ({
            name,
            run: async () => {
                await edit();
                await runWatcherOnce(fixture, ...args);
            },
        });
        await assertOrderUntouched(fixture.data.root, [
            run('startup over unchanged sources', () => undefined),
            run('a rename', () => fs.renameSync(lib.file('portrait.png'), lib.file('portrait-renamed.png'))),
            run('an EXIF DateTimeOriginal edit', () => put('landscape.jpg', withDates(bytesOf('landscape.jpg'), { original: '2023:07:08 09:10:11', modified: '2023:07:08 09:10:11' }))),
            run('a replacement with new pixels', () => put('square.webp', fresh)),
            run('a new photograph', () => put('added.jpg', bytesOf('landscape-edited.jpg'))),
            run('a deletion', () => fs.rmSync(lib.file('added.jpg'))),
            run('regenerating every derivative', () => undefined, '--force'),
        ]);
        expect(fs.existsSync(lib.file('optimized', 'square.webp'))).toBe(true);
    }, 180_000);

    it('leaves them alone at startup against an uninitialized data root too', async () => {
        const fixture = await prepare();
        const uninitialized = createTempDataRoot({ state: 'uninitialized' });
        cleanups.push(() => uninitialized.cleanup());
        for (const dir of ['catalog', 'authored']) fs.cpSync(path.join(fixture.data.root, dir), path.join(uninitialized.root, dir), { recursive: true });
        await assertOrderUntouched(uninitialized.root, [{
            name: 'startup',
            run: () => runWatcherOnce({ ...fixture, data: uninitialized }),
        }]);
        // The watcher writes its heartbeat to any data root it can write, initialized or not, and nothing else.
        expect(fs.readdirSync(uninitialized.root).sort()).toEqual(['authored', 'catalog', 'status']);
        expect(fs.readdirSync(path.join(uninitialized.root, 'status'))).toEqual(['watcher.json']);
    }, 60_000);
});
