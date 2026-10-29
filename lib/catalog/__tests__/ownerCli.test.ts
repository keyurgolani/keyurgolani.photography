// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, runTsx, type TsxRun } from '../../../test/helpers/runTsx';
import { createTempLibrary } from '../../../test/helpers/tempLibrary';
import { readRegistry, writeRegistry } from '../../identity/registry';
import { parseFlags, publishReport, sequenceArgs, seriesArgs, UsageError } from '../owner-cli';
import { publish, type PublishResult } from '../publish';
import { createTestCatalog, type TestCatalog } from '../testing';
import { VARIANT_BYTES } from './catalogFixtures';

const P1 = 'ph_00000000-0000-4000-8000-000000000001';
const P2 = 'ph_00000000-0000-4000-8000-000000000002';
const S = 'ser_fixture-01';

const usage = (run: () => unknown) => {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(UsageError);
        return (error as Error).message;
    }
    throw new Error('Expected a usage error');
};

describe('sequence and series argv', () => {
    it.each([
        [['show', S], { command: 'show', seriesId: S }],
        [['set', S, P1, P2, '--expect-version', '3'], { command: 'set', seriesId: S, photoIds: [P1, P2], expectVersion: 3 }],
        [['insert', S, P1, '--start'], { command: 'insert', seriesId: S, photoId: P1, at: 'start' }],
        [['move', S, P1, '--end'], { command: 'move', seriesId: S, photoId: P1, at: 'end' }],
        [['move', S, P1, '--after', P2], { command: 'move', seriesId: S, photoId: P1, at: { after: P2 } }],
        [['insert', S, P1, '--to', '2'], { command: 'insert', seriesId: S, photoId: P1, at: { to: 2 } }],
        [['remove', S, P1], { command: 'remove', seriesId: S, photoId: P1 }],
        [['cover', S, P1, '--focal', '0.5,0.25'], { command: 'cover', seriesId: S, photoId: P1, focal: { x: 0.5, y: 0.25 } }],
        [['cover', S, P1, '--clear-focal'], { command: 'cover', seriesId: S, photoId: P1, focal: 'clear' }],
        [['opening', S, P1], { command: 'opening', seriesId: S, photoId: P1 }],
        [['opening', S, '--clear'], { command: 'opening', seriesId: S, photoId: null }],
        [['chapter', 'add', S, 'Fixture chapter', '--start', P1], { command: 'chapter-add', seriesId: S, title: 'Fixture chapter', startPhotoId: P1 }],
        [['chapter', 'add', S, '--start', P1, '--', '-Fixture chapter'], { command: 'chapter-add', seriesId: S, title: '-Fixture chapter', startPhotoId: P1 }],
        [['chapter', 'move', S, 'ch_one', '--start', P2], { command: 'chapter-move', seriesId: S, chapterId: 'ch_one', startPhotoId: P2 }],
        [['chapter', 'remove', S, 'ch_one'], { command: 'chapter-remove', seriesId: S, chapterId: 'ch_one' }],
    ])('parses sequence %j', (args, command) => {
        expect(sequenceArgs(args)).toEqual(expect.objectContaining(command));
    });

    it.each([
        [[], 'photos sequence needs a command.'],
        [['shuffle', S], 'Unknown sequence command: shuffle'],
        [['show'], 'Usage: photos sequence show <seriesId>'],
        [['show', S, '--expect-version', '1'], 'sequence show takes no --expect-version.'],
        [['set'], 'photos sequence set needs a series ID and at least one photo ID.'],
        [['set', S], 'photos sequence set needs a series ID and at least one photo ID.'],
        [['set', S, 'photo-1'], 'photo-1 is not a photo ID.'],
        [['insert', S, P1], 'Place the photo with exactly one of --start, --end, --after <photoId>, and --to <N>.'],
        [['insert', S, P1, '--start', '--end'], 'Place the photo with exactly one of'],
        [['move', S, P1, '--to', 'first'], '--to takes a position from 1.'],
        [['move', S, P1, '--to', '2', '--to', '3'], '--to is given more than once.'],
        [['move', S, P1, '--after'], "Option '--after <value>' argument missing"],
        [['remove', S, P1, '--expect-version', 'latest'], '--expect-version takes a version from 0.'],
        [['remove', S, P1, '--expect-version', '1', '--expect-version', '2'], '--expect-version is given more than once.'],
        [['cover', S, P1, '--focal', '2,0'], '--focal takes x,y, each from 0 to 1'],
        [['cover', S, P1, '--focal', '0.5,0.5', '--clear-focal'], "--focal and --clear-focal don't go together."],
        [['opening', S], 'Usage: photos sequence opening <seriesId> (<photoId> | --clear)'],
        [['chapter'], 'photos sequence chapter needs add, move, or remove.'],
        [['chapter', 'add', S, 'Title'], 'chapter add needs --start <photoId>.'],
        [['chapter', 'add', S, '-Title', '--start', P1], "Unknown option '-T'"],
        [['chapter', 'add', S, 'Title', '--start', P1, '--start', P2], '--start is given more than once.'],
        [['remove', S, P1, '--fast'], "Unknown option '--fast'"],
    ])('refuses sequence %j', (args, message) => {
        expect(usage(() => sequenceArgs(args))).toContain(message);
    });

    it('holds a chapter title to the import\'s plain-text rules', () => {
        expect(sequenceArgs(['chapter', 'add', S, '  Fixture Cafe\u0301 chapter  ', '--start', P1])).toMatchObject({ title: 'Fixture Caf\u00e9 chapter' });
        const bidi = usage(() => sequenceArgs(['chapter', 'add', S, 'Fixture \u202Echapter', '--start', P1]));
        expect(bidi).toBe('The chapter title has U+202E, a bidi embedding or override, at character 9. Remove it and run the command again.');
        expect(usage(() => sequenceArgs(['chapter', 'add', S, `Fixture ${'\u{E0041}'} chapter`, '--start', P1]))).toContain('U+E0041');
        expect(usage(() => sequenceArgs(['chapter', 'add', S, 'Two\nlines', '--start', P1]))).toBe('The chapter title has a line break. Put it on one line.');
        expect(usage(() => sequenceArgs(['chapter', 'add', S, 'x'.repeat(201), '--start', P1]))).toBe('The chapter title is 201 characters long, over its limit of 200.');
        expect(usage(() => sequenceArgs(['chapter', 'add', S, '   ', '--start', P1]))).toBe('chapter add needs a title.');
    });

    it('parses series order and featured, and needs an ID or --clear', () => {
        expect(seriesArgs(['order', S, 'ser_two', '--expect-version', '4'])).toEqual({ command: 'series-order', seriesIds: [S, 'ser_two'], expectVersion: 4 });
        expect(seriesArgs(['featured', S])).toEqual({ command: 'series-featured', seriesIds: [S] });
        expect(seriesArgs(['featured', '--clear'])).toEqual({ command: 'series-featured', seriesIds: [] });
        expect(usage(() => seriesArgs(['order']))).toBe('photos series order needs at least one series ID.');
        expect(usage(() => seriesArgs(['featured']))).toBe('photos series featured needs at least one series ID, or --clear to feature none.');
        expect(usage(() => seriesArgs(['featured', S, '--clear']))).toBe('photos series featured takes series IDs or --clear, not both.');
        expect(usage(() => seriesArgs(['order', S, '--clear']))).toContain("Unknown option '--clear'");
        expect(usage(() => seriesArgs(['sort']))).toBe('Unknown series command: sort');
    });

    it('refuses any flag given twice, in either form', () => {
        expect(usage(() => parseFlags({ args: ['--import', 'a.csv', '--import=b.csv'], options: { import: { type: 'string' } } }))).toBe('--import is given more than once. Give it once.');
        expect(usage(() => parseFlags({ args: ['--json', '--json'], options: { json: { type: 'boolean' } } }))).toBe('--json is given more than once. Give it once.');
        expect(parseFlags({ args: ['--import', 'a.csv'], options: { import: { type: 'string' } } }).values).toEqual({ import: 'a.csv' });
    });
});

describe('the publish report', () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
        for (const cleanup of cleanups.splice(0)) await cleanup();
    });

    /** Six photos, four in a published series; of the other two, one is nested in a folder and one is merged, so neither is on the legacy site. */
    async function launchFixture(): Promise<TestCatalog> {
        const catalog = await createTestCatalog({ seed: 1320, photos: 6, series: [{ photos: 4 }], variantBytes: VARIANT_BYTES });
        cleanups.push(() => catalog.cleanup());
        const registry = await readRegistry(catalog.root);
        const published = new Set(catalog.content.photos.map((photo) => photo.id));
        const [nested, merged] = catalog.photos.map((photo) => photo.id).filter((id) => !published.has(id));
        registry.photos[nested].source.path = `nested/${registry.photos[nested].source.path}`;
        registry.photos[merged].mergedInto = [...published][0];
        await writeRegistry(catalog.root, registry, registry.version);
        return catalog;
    }

    const quiet = { log: () => undefined };
    const report = (result: PublishResult, root: string) => publishReport(result, root).join('\n');

    it('counts only photos the legacy site lists as leaving it, by the registry, so an empty library lowers nothing', async () => {
        const catalog = await launchFixture();
        const library = await createTempLibrary();
        cleanups.push(() => library.cleanup());
        const result = await publish({ dataRoot: catalog.root, actor: 'test', logger: quiet });
        expect(result).toMatchObject({ outcome: 'LAUNCH_CONFIRMATION_REQUIRED', launch: { published: 4, gone: 0 } });
        const registry = await readRegistry(catalog.root);
        const nested = Object.values(registry.photos).find((photo) => photo.source.path.startsWith('nested/'));
        if (!nested) throw new Error('no nested photo');
        nested.source.path = nested.source.path.slice('nested/'.length);
        await writeRegistry(catalog.root, registry, registry.version);
        expect((await publish({ dataRoot: catalog.root, actor: 'test', logger: quiet })).launch).toEqual({ published: 4, gone: 1 });
    });

    it('prints the checklist and an --expect hint before the launch, and only the impact after it', async () => {
        const catalog = await launchFixture();
        const required = await publish({ dataRoot: catalog.root, actor: 'test', logger: quiet });
        const before = report(required, catalog.root);
        expect(before).toContain('Launch: this revision replaces the legacy Home and Gallery with 4 photographs. Every photograph the legacy site lists is in it.');
        expect(before).toContain('Launch checklist, from the README\'s "Curating the catalog":');
        expect(before).toContain("#15's 15-1 and 15-2");
        expect(before).toContain(`To publish exactly this candidate, run publish again with --confirm-launch --expect ${required.candidateId}.`);
        expect(before).not.toContain('docs/curation.md');

        const dryRun = await publish({ dataRoot: catalog.root, actor: 'test', dryRun: true, logger: quiet });
        const dry = report(dryRun, catalog.root);
        expect(dryRun.outcome).toBe('DRY_RUN_OK');
        expect(dry).toContain('Launch checklist');
        expect(dry).toContain(`--confirm-launch --expect ${dryRun.candidateId}`);

        const published = await publish({ dataRoot: catalog.root, actor: 'test', confirmLaunch: true, expectedRevisionId: required.candidateId ?? undefined, logger: quiet });
        const after = report(published, catalog.root);
        expect(published.outcome).toBe('PUBLISHED');
        expect(after).toContain('Launch: this revision replaced the legacy Home and Gallery with 4 photographs.');
        expect(after).not.toContain('checklist');
        expect(after).not.toContain('--confirm-launch');
    });

    it('lists what a publish takes off the site under Removed, once a revision is active (#17)', () => {
        const base: PublishResult = { outcome: 'DRY_RUN_OK', message: 'Fixture.', candidateId: null, revisionId: null, revisionNumber: null, activationId: null, issues: [], errors: 0, warnings: 0 };
        expect(report(base, '/root')).not.toContain('Removed');
        expect(report({ ...base, removed: [] }, '/root')).toContain('Removed: nothing. Every photograph the active revision shows stays on the site.');
        const one = report({ ...base, removed: [{ photoId: P1, series: [S] }] }, '/root');
        expect(one).toContain(`Removed: 1 photograph the active revision shows leaves the site if this publishes:\n  ${P1}, from ${S}`);
        const done = report({ ...base, outcome: 'PUBLISHED', removed: [{ photoId: P1, series: [] }, { photoId: P2, series: [S] }] }, '/root');
        expect(done).toContain(`Removed: 2 photographs the active revision shows leave the site:\n  ${P1}\n  ${P2}, from ${S}`);
        const many = Array.from({ length: 202 }, (_, n) => ({ photoId: `ph_00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, series: [] }));
        expect(report({ ...base, removed: many }, '/root')).toContain('  and 2 more');
    });
});

describe('scripts/photos.ts', { timeout: 120_000 }, () => {
    const cleanups: (() => Promise<void>)[] = [];
    afterEach(async () => {
        for (const cleanup of cleanups.splice(0)) await cleanup();
    });

    const photos = (args: string[], env: Record<string, string | undefined>): Promise<TsxRun> => runTsx('scripts/photos.ts', args, { env: { PHOTOS_ACTOR: undefined, ...env } });

    it('exits 1, not 3, for the owner commands when PHOTOGRAPHY_DATA_DIR is unset in production, and status still reports', async () => {
        const env = { PHOTOGRAPHY_DATA_DIR: undefined, NODE_ENV: 'production' };
        const [status, list, draftInit, describe] = await Promise.all([
            photos(['status'], env),
            photos(['list'], env),
            photos(['draft:init'], env),
            photos(['describe', '--import', 'missing.csv'], env),
        ]);
        expect(status.code).toBe(1);
        expect(status.stderr).toBe('Data root: not set (unset: PHOTOGRAPHY_DATA_DIR is not set)\n');
        for (const run of [list, draftInit, describe]) {
            expect(run.code).toBe(1);
            expect(run.stderr).toContain('[photos] The data root is unset: PHOTOGRAPHY_DATA_DIR is not set.');
        }
    });

    it('refuses a repeated flag and an empty series order with exit 2, and takes a chapter title after --', async () => {
        const catalog = await createTestCatalog({ seed: 1321, photos: 3, series: 1 });
        cleanups.push(() => catalog.cleanup());
        const env = { PHOTOGRAPHY_DATA_DIR: catalog.root };
        const seriesId = catalog.series[0].id;
        const [twice, empty, chapter] = await Promise.all([
            photos(['describe', '--import', 'a.csv', '--import', 'b.csv'], env),
            photos(['series', 'order'], env),
            photos(['sequence', 'chapter', 'add', seriesId, '--start', catalog.series[0].photoIds[0], '--', '-Fixture chapter'], env),
        ]);
        expect(twice.code).toBe(2);
        expect(twice.stderr).toContain('--import is given more than once.');
        expect(empty.code).toBe(2);
        expect(empty.stderr).toContain('photos series order needs at least one series ID.');
        expect(chapter.code, chapter.stderr).toBe(0);
        expect(chapter.stdout).toContain(': -Fixture chapter');
    });

    it('prints usage that names the README section and the image-watcher form, and nothing deferred', async () => {
        const run = await photos([], { PHOTOGRAPHY_DATA_DIR: path.join(os.tmpdir(), 'kg13d-none') });
        expect(run.code).toBe(2);
        expect(run.stderr).toContain('series featured (<seriesId>... | --clear)');
        expect(run.stderr).toContain('run --rm --no-deps image-watcher node dist/scripts/photos.mjs <command>');
        expect(run.stderr).toContain('"Curating the catalog"');
        const sources = [path.join(REPO_ROOT, 'scripts/photos.ts'), ...fs.readdirSync(path.join(REPO_ROOT, 'lib/catalog')).filter((name) => name.endsWith('.ts')).map((name) => path.join(REPO_ROOT, 'lib/catalog', name))];
        for (const text of [run.stderr, ...sources.map((file) => fs.readFileSync(file, 'utf8'))]) {
            expect(text).not.toContain('docs/curation.md');
            expect(text).not.toMatch(/--profile tools|`tools` service/);
        }
    });
});
