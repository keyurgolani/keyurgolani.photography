// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { runTsx } from '../../../test/helpers/runTsx';
import { createTempDataRoot } from '../../../test/helpers/tempDataRoot';
import { applySequenceOp } from '../../catalog/sequence';
import type { AuthoredSeries } from '../../catalog/types';
import { readAuthoredRecord } from '../../catalog/working-layer';
import { writeAuthoredRecord } from '../../catalog/working-layer-writer';
import { readRegistry, writeRegistry } from '../../identity/registry';
import { parseCurationArgs, printable, runCurationCli, scrub, type CommandResult } from '../commands';
import { needsJudgment } from '../events';
import { placedItems } from '../placement';
import { listEvents } from '../repository';
import { createCurationSink } from '../sink';
import { createCurationFixture, DRAFT, writeRules, type CurationFixture } from './curationFixtures';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

async function fixture(options: Parameters<typeof createCurationFixture>[0] = {}): Promise<CurationFixture> {
    const created = await createCurationFixture(options);
    cleanups.push(() => created.cleanup());
    return created;
}

const cli = (f: CurationFixture, ...args: string[]): Promise<CommandResult> => runCurationCli(args, { dataRoot: f.root, libraryRoot: '/library/that/is/not/here' }, {});

describe('curation list', () => {
    it('says the inbox is empty when it is', async () => {
        const f = await fixture();
        expect(await cli(f, 'list')).toEqual({ exitCode: 0, output: 'Curation inbox: empty. Nothing requires judgment.\n' });
        expect(JSON.parse((await cli(f, 'list', '--json')).output)).toEqual({ needsJudgment: 0, waiting: 0, placed: 0, unplaced: 0, total: 0, events: [], problems: [] });
    });

    it('counts what needs judgment and lists each item with its version, type, status, and short photo ID', async () => {
        const f = await fixture();
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0]), f.fact('processing-failed', null, { reason: 'unsupported-format', path: 'trips/raw.heic' }), f.fact('missing', f.fresh[1])]);
        const listed = await cli(f, 'list');
        expect(listed.exitCode).toBe(0);
        const lines = listed.output.trimEnd().split('\n');
        expect(lines[0]).toBe('Curation inbox: 3 items require judgment, 3 in all.');
        expect(lines.slice(1).map((line) => line.split(/\s{2,}/).slice(1, 4))).toEqual(expect.arrayContaining([
            ['new', 'open', f.fresh[0].slice(0, 11)],
            ['processing-failure', 'failed', 'no photo ID'],
            ['missing', 'open', f.fresh[1].slice(0, 11)],
        ]));
        expect(lines[1]).toMatch(/^evt_[0-9a-f]{24}@1 /);
        const { events } = await listEvents(f.root);
        const fresh = events.find((event) => event.type === 'new');
        await cli(f, 'defer', fresh?.id as string, '--version', '1');
        expect((await cli(f, 'list')).output).toMatch(/^Curation inbox: 2 items require judgment, 3 in all\./);
        expect((await cli(f, 'list', '--status', 'deferred')).output.trimEnd().split('\n')).toHaveLength(2);
    });

    it('names an unreadable event by its ID and exits 4', async () => {
        const f = await fixture();
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0])]);
        const [event] = (await listEvents(f.root)).events;
        fs.writeFileSync(path.join(f.root, 'curation', 'events', event.id, 'v1.json'), '[]');
        const listed = await cli(f, 'list');
        expect(listed.exitCode).toBe(4);
        expect(listed.output).toContain(`Unreadable: ${event.id} (invalid-json)`);
        expect(listed.output).not.toContain(f.root);
    });
});

describe('curation show and the item commands', () => {
    it('shows facts, suggestions, and edits apart, and acts with the version it printed', async () => {
        const f = await fixture({ published: true });
        writeRules(f.root, { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0])]);
        const [event] = (await listEvents(f.root)).events;
        const shown = await cli(f, 'show', event.id);
        expect(shown.exitCode).toBe(0);
        expect(shown.output).toContain(`${event.id}, version 1: new, open`);
        expect(shown.output).toContain(`Stable photo identity: ${f.fresh[0]}, source present`);
        expect(shown.output).toMatch(/Reviewable suggestion \(generated, not reviewed\):\n {2}Suggested series: ser_fixture-01 \(high, rules@[0-9a-f]{12}, /);
        expect(shown.output).toContain('Proposed sequence position: the end (low, placement@1');
        expect(shown.output).toContain('Draft description: none suggested.');
        expect(shown.output).toContain('Your edits: none.');
        expect(shown.output).toContain('Published references: none');
        expect(shown.output).toContain('Published statement remains unchanged.');
        expect(shown.output).toContain(`To act on it: --version 1 --base ${f.catalog.revisionId}`);
        expect(shown.output).not.toContain(f.root);

        expect(await cli(f, 'edit', event.id, '--version', '1', '--start', '--description', 'A harbor at first light.')).toMatchObject({ exitCode: 0 });
        expect((await cli(f, 'show', event.id)).output).toContain('Your edits: position the start, description "A harbor at first light." (curator:cli, ');
        const stale = await cli(f, 'approve', event.id, '--version', '1');
        expect(stale).toMatchObject({ exitCode: 3, output: expect.stringMatching(/^Error \(stale\)/) });
        const approved = await cli(f, 'approve', event.id, '--version', '2', '--base', f.catalog.revisionId);
        expect(approved).toMatchObject({ exitCode: 0, output: expect.stringContaining(`Approved into ${DRAFT} at the start, in the draft.`) });
        expect((await readAuthoredRecord(f.root, 'series', DRAFT))?.photoIds[0]).toBe(f.fresh[0]);
        expect((await cli(f, 'show', event.id)).output).toMatch(new RegExp(`approve by curator:cli: ${DRAFT}, the start, wrote photo:${f.fresh[0]} v1, series:${DRAFT} v2`));
        expect((await cli(f, 'show', event.id)).output).toContain(`Published references: the draft series ${DRAFT}`);
    });

    it('exits 3 against a moved active revision, and 1 for a refused action, writing nothing', async () => {
        const f = await fixture({ published: true });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('missing', f.catalog.series[0].photoIds[0])]);
        const [event] = (await listEvents(f.root)).events;
        const before = folderBytes(f.root);
        expect(await cli(f, 'defer', event.id, '--version', '1', '--base', 'none')).toMatchObject({ exitCode: 3 });
        expect(await cli(f, 'dismiss', event.id, '--version', '1', '--reason', 'Gone.')).toMatchObject({ exitCode: 1, output: expect.stringMatching(/can't be dismissed/) });
        expect(await cli(f, 'approve', event.id, '--version', '1', '--series', DRAFT)).toMatchObject({ exitCode: 1 });
        expect(folderBytes(f.root)).toEqual(before);
    });

    it('records --actor, or PHOTOS_ACTOR, as who reviewed it', async () => {
        const f = await fixture();
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0]), f.fact('new', f.fresh[1])]);
        const [a, b] = (await listEvents(f.root)).events;
        await cli(f, 'defer', a.id, '--version', '1', '--actor', 'owner');
        await runCurationCli(['defer', b.id, '--version', '1'], { dataRoot: f.root }, { PHOTOS_ACTOR: 'from-env' });
        const reviewers = (await listEvents(f.root)).events.map((event) => event.reviewedBy).sort();
        expect(reviewers).toEqual(['from-env', 'owner']);
    });
});

describe('curation arguments', () => {
    it.each([
        [[], /needs a command/],
        [['frobnicate'], /Unknown curation command/],
        [['show'], /needs one event ID/],
        [['show', '../../etc'], /is not an event ID/],
        [['defer', `evt_${'0'.repeat(24)}`], /needs --version/],
        [['defer', `evt_${'0'.repeat(24)}`, '--version', '0'], /from 1/],
        [['dismiss', `evt_${'0'.repeat(24)}`, '--version', '1'], /needs --reason/],
        [['dismiss', `evt_${'0'.repeat(24)}`, '--version', '1', '--reason', 'two\nlines'], /line break/],
        [['approve', `evt_${'0'.repeat(24)}`, '--version', '1', '--series', 'harbor'], /not a series ID/],
        [['approve', `evt_${'0'.repeat(24)}`, '--version', '1', '--unassigned', '--start'], /no position/],
        [['approve', `evt_${'0'.repeat(24)}`, '--version', '1', '--start', '--end'], /one of --start/],
        [['approve', `evt_${'0'.repeat(24)}`, '--version', '1', '--after', 'nope'], /not a photo ID/],
        [['approve', `evt_${'0'.repeat(24)}`, '--version', '1', '--description', '<i>x</i>'], /plain text/],
        [['edit', `evt_${'0'.repeat(24)}`, '--version', '1', '--base', 'latest'], /revision ID or none/],
        [['list', '--reason', 'x'], /doesn't go with curation list/],
        [['list', '--status', 'pending'], /--status takes one of/],
    ])('refuses %j as a usage error', (args, message) => {
        expect(() => parseCurationArgs(args as string[])).toThrow(message as RegExp);
    });

    it('names the program it runs as in its usage text, as 10C\'s PROGRAM does', async () => {
        const bundled = await runCurationCli(['show'], { dataRoot: '/nowhere', program: 'node dist/scripts/photos.mjs' }, {});
        expect(bundled.output).toContain('  node dist/scripts/photos.mjs curation list');
        expect(bundled.output).not.toContain('npx tsx');
        expect((await runCurationCli(['show'], { dataRoot: '/nowhere' }, {})).output).toContain('  npx tsx scripts/photos.ts curation list');
    });

    it('exits 2 with the usage text, and needs a data root to act', async () => {
        expect(await runCurationCli(['show'], { dataRoot: '/nowhere' }, {})).toMatchObject({ exitCode: 2, output: expect.stringContaining('Usage:') });
        expect(await runCurationCli(['list'], { dataRoot: null }, {})).toMatchObject({ exitCode: 3, output: expect.stringMatching(/PHOTOGRAPHY_DATA_DIR is not set/) });
    });

    it('scrubs the data root and the library from anything it prints', () => {
        expect(scrub('/data/root/curation/x and /data/root/library/a.jpg', ['/data/root', '/data/root/library'])).toBe('<data root>/curation/x and <library>/a.jpg');
    });
});

describe('npm run photos -- curation', () => {
    it('runs from scripts/photos.ts against an uninitialized and an empty data root', async () => {
        const data = createTempDataRoot({ state: 'uninitialized' });
        cleanups.push(() => data.cleanup());
        const env = { PHOTOGRAPHY_DATA_DIR: data.root, PHOTOGRAPHY_LIBRARY_DIR: path.join(data.root, '..', 'no-library') };
        const notReady = await runTsx('scripts/photos.ts', ['curation', 'list'], { env });
        expect(notReady.code).toBe(3);
        expect(`${notReady.stdout}${notReady.stderr}`).not.toContain(data.root);
        fs.writeFileSync(path.join(data.root, 'data-root.json'), `${JSON.stringify({ schemaVersion: 1, initializedAt: '2026-01-01T00:00:00.000Z' })}\n`);
        const empty = await runTsx('scripts/photos.ts', ['curation', 'list'], { env });
        expect(empty).toMatchObject({ code: 0, stdout: 'Curation inbox: empty. Nothing requires judgment.\n' });
        const usage = await runTsx('scripts/photos.ts', ['curation', 'approve', `evt_${'0'.repeat(24)}`], { env });
        expect(usage.code).toBe(2);
    }, 60_000);
});

describe('curation output, round 1', () => {
    it.skipIf(process.getuid?.() === 0)('scrubs the data root from a storage error on the command path', async () => {
        const f = await fixture();
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0])]);
        const events = path.join(f.root, 'curation', 'events');
        fs.chmodSync(events, 0o000);
        cleanups.push(async () => fs.chmodSync(events, 0o700));
        const listed = await cli(f, 'list');
        expect(listed.exitCode).toBe(4);
        expect(listed.output).toContain('<data root>');
        expect(listed.output).not.toContain(f.root);
        fs.chmodSync(events, 0o700);
    });

    it('escapes control and bidi characters in every path and name it prints', async () => {
        const f = await fixture();
        writeRules(f.root, { schemaVersion: 1, series: [{ seriesId: DRAFT, folders: ['trips'] }] });
        const hostile = 'trips/evil\nevt_000000000000000000000000@1  new  open\u001b[2J\u202e\u0085\u007f.jpg';
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0], { path: hostile, folder: 'trips' })]);
        const [event] = (await listEvents(f.root)).events;
        for (const output of [(await cli(f, 'list')).output, (await cli(f, 'show', event.id)).output]) {
            // eslint-disable-next-line no-control-regex
            expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u);
            expect(output).toContain('trips/evil\\nevt_');
            expect(output).toContain('\\u001b[2J\\u202e\\u0085\\u007f.jpg');
        }
        expect((await cli(f, 'list')).output.trimEnd().split('\n')).toHaveLength(2);
    });
});

describe('printable, round 2', () => {
    it('escapes a backslash, so a literal backslash-n never looks like a newline', () => {
        expect(printable('a\\nb')).not.toBe(printable('a\nb'));
        expect(printable('a\\nb')).toBe('a\\\\nb');
        expect(printable('a\nb')).toBe('a\\nb');
    });

    it('keeps JSON output valid when a path holds a backslash and invisible characters', async () => {
        const f = await fixture();
        const hostile = 'trips/back\\slash\u202e\u2028.jpg';
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0], { path: hostile, folder: 'trips' })]);
        const listed = JSON.parse((await cli(f, 'list', '--json')).output) as { events: { sourcePath: string }[] };
        expect(listed.events[0].sourcePath).toBe(hostile);
        expect((await cli(f, 'list')).output).toContain('trips/back\\\\slash\\u202e\\u2028.jpg');
    });
});

describe('round 3: a replacement whose set is still building', () => {
    it('is listed as waiting with its reason, not as needing judgment, until its set is ready', async () => {
        const f = await fixture();
        const photoId = f.catalog.photos[0].id;
        const registry = await readRegistry(f.root);
        const photo = registry.photos[photoId];
        const newer = `sha256-${'8'.repeat(64)}`;
        photo.revisions[newer] = { ...photo.revisions[photo.source.observedRevision], assetRevision: newer, profiles: { [f.catalog.profileId]: { state: 'pending', attempts: 0 } } };
        await writeRegistry(f.root, registry, registry.version);
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('replaced', photoId, { assetRevision: newer }), f.fact('new', f.fresh[0])]);
        const listed = await cli(f, 'list');
        expect(listed.output).toMatch(/^Curation inbox: 1 item requires judgment, 1 waiting, 2 in all\./);
        expect(listed.output).toMatch(/replacement .*waiting: its new derivatives are still building/);
        expect(JSON.parse((await cli(f, 'list', '--json')).output)).toMatchObject({ needsJudgment: 1, waiting: 1, events: expect.arrayContaining([expect.objectContaining({ type: 'replacement', waiting: 'its new derivatives are still building' })]) });
        const { events } = await listEvents(f.root);
        const replacement = events.find((event) => event.type === 'replacement');
        expect((await cli(f, 'show', replacement?.id as string)).output).toContain('Waiting: its new derivatives are still building');

        const ready = await readRegistry(f.root);
        ready.photos[photoId].revisions[newer].profiles[f.catalog.profileId] = { state: 'ready', attempts: 1, readyAt: '2026-02-01T00:00:00.000Z' };
        await writeRegistry(f.root, ready, ready.version);
        expect((await cli(f, 'list')).output).toMatch(/^Curation inbox: 2 items require judgment, 2 in all\./);
    });

    it('counts a failed build as needing judgment, since retry is the next step', async () => {
        const f = await fixture();
        const photoId = f.catalog.photos[0].id;
        const registry = await readRegistry(f.root);
        const photo = registry.photos[photoId];
        const newer = `sha256-${'9'.repeat(64)}`;
        photo.revisions[newer] = { ...photo.revisions[photo.source.observedRevision], assetRevision: newer, profiles: { [f.catalog.profileId]: { state: 'failed', attempts: 3 } } };
        await writeRegistry(f.root, registry, registry.version);
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('replaced', photoId, { assetRevision: newer })]);
        expect((await cli(f, 'list')).output).toMatch(/^Curation inbox: 1 item requires judgment, 1 in all\./);
    });
});

describe('a new photograph that is already placed', () => {
    const editor = { kind: 'editor' } as const;

    it('needs no judgment while a series holds it, and comes back when it leaves', async () => {
        const f = await fixture();
        const placedPhoto = f.catalog.series[0].photoIds[0];
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', placedPhoto), f.fact('new', f.fresh[0])]);
        const { events } = await listEvents(f.root);
        const placedItem = events.find((event) => event.photoId === placedPhoto);
        const freshItem = events.find((event) => event.photoId === f.fresh[0]);

        const listed = (await cli(f, 'list')).output.trimEnd().split('\n');
        expect(listed[0]).toBe('Curation inbox: 1 item requires judgment, 1 already placed, 2 in all.');
        expect(listed.slice(1).map((line) => line.split(' ')[0])).toEqual([`${freshItem?.id}@1`]);
        expect((await cli(f, 'list', '--all')).output).toContain(`placed: its photo is in the series ${f.catalog.series[0].id}`);
        expect((await cli(f, 'list', '--status', 'open')).output.trimEnd().split('\n')).toHaveLength(3);
        expect(JSON.parse((await cli(f, 'list', '--json')).output)).toMatchObject({ needsJudgment: 1, placed: 1, total: 2 });
        expect((await cli(f, 'show', placedItem?.id as string)).output).toContain(`Already placed: its photo is in the series ${f.catalog.series[0].id}, so it needs no judgment while it stays there.`);
        expect((await cli(f, 'show', freshItem?.id as string)).output).not.toContain('Already placed');
        expect(JSON.parse((await cli(f, 'show', placedItem?.id as string, '--json')).output)).toMatchObject({ placed: `its photo is in the series ${f.catalog.series[0].id}`, placementUnknown: null });
        expect(JSON.parse((await cli(f, 'show', freshItem?.id as string, '--json')).output)).toMatchObject({ placed: null, placementUnknown: null });

        // `sequence insert`, as the owner runs it, settles the other one too. Nothing is written to either item.
        const before = folderBytes(path.join(f.root, 'curation'));
        expect(await applySequenceOp({ dataRoot: f.root }, { kind: 'insert', seriesId: DRAFT, photoId: f.fresh[0], at: 'end' }, { expectedVersion: 1, actor: editor })).toMatchObject({ ok: true, changed: true });
        expect((await cli(f, 'list')).output).toBe('Curation inbox: 0 items require judgment, 2 already placed, 2 in all.\nNothing matches open, failed, or deferred but the 2 items already placed. --all lists them.\n');
        expect(folderBytes(path.join(f.root, 'curation'))).toEqual(before);

        // Taken out again, it needs judgment again, still at the version it was shown at.
        expect(await applySequenceOp({ dataRoot: f.root }, { kind: 'remove', seriesId: DRAFT, photoId: f.fresh[0] }, { expectedVersion: 2, actor: editor })).toMatchObject({ ok: true, changed: true });
        expect((await cli(f, 'list')).output).toMatch(new RegExp(`^Curation inbox: 1 item requires judgment, 1 already placed, 2 in all\\.\\n${freshItem?.id}@1 `));
    });

    it('keeps a missing or replacement item for a placed photo open, and approve still works on a placed one', async () => {
        const f = await fixture();
        const [first, second] = f.catalog.series[1].photoIds;
        const registry = await readRegistry(f.root);
        const photo = registry.photos[second];
        const newer = `sha256-${'7'.repeat(64)}`;
        photo.revisions[newer] = { ...photo.revisions[photo.source.observedRevision], assetRevision: newer, profiles: { [f.catalog.profileId]: { state: 'ready', attempts: 1, readyAt: '2026-02-01T00:00:00.000Z' } } };
        await writeRegistry(f.root, registry, registry.version);
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', first), f.fact('missing', first), f.fact('replaced', second, { assetRevision: newer })]);
        expect((await cli(f, 'list')).output).toMatch(/^Curation inbox: 2 items require judgment, 1 already placed, 3 in all\./);
        const fresh = (await listEvents(f.root)).events.find((event) => event.type === 'new');
        const approved = await cli(f, 'approve', fresh?.id as string, '--version', '1', '--series', DRAFT, '--base', 'none');
        expect(approved).toMatchObject({ exitCode: 0, output: expect.stringContaining(`Approved into ${DRAFT}, where it kept its place`) });
        expect((await cli(f, 'list')).output).toMatch(/^Curation inbox: 2 items require judgment, 3 in all\./);
    });

    it('lists an approval whose photo nothing holds now, but not one left unassigned on purpose', async () => {
        const f = await fixture();
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0]), f.fact('new', f.fresh[1])]);
        const { events } = await listEvents(f.root);
        const [placedItem, loose] = [events.find((event) => event.photoId === f.fresh[0]), events.find((event) => event.photoId === f.fresh[1])];
        expect(await cli(f, 'approve', placedItem?.id as string, '--version', '1', '--series', DRAFT, '--description', 'A harbor.')).toMatchObject({ exitCode: 0 });
        expect(await cli(f, 'approve', loose?.id as string, '--version', '1', '--unassigned', '--description', 'A pier.')).toMatchObject({ exitCode: 0 });
        expect((await cli(f, 'list')).output).toBe('Curation inbox: 0 items require judgment, 2 in all.\nNothing matches open, failed, or deferred.\n');

        const before = folderBytes(path.join(f.root, 'curation'));
        expect(await applySequenceOp({ dataRoot: f.root }, { kind: 'remove', seriesId: DRAFT, photoId: f.fresh[0] }, { expectedVersion: 2, actor: editor })).toMatchObject({ ok: true, changed: true });
        const listed = (await cli(f, 'list')).output.trimEnd().split('\n');
        expect(listed[0]).toBe('Curation inbox: 0 items require judgment, 1 approved but no longer placed, 2 in all.');
        expect(listed.slice(1)).toEqual([expect.stringMatching(new RegExp(`^${placedItem?.id}@2 .* approved .*unplaced: approved into ${DRAFT}, but no series or the live revision holds its photo now$`))]);
        expect(JSON.parse((await cli(f, 'list', '--json')).output)).toMatchObject({ needsJudgment: 0, unplaced: 1, events: [{ id: placedItem?.id, unplaced: DRAFT }] });
        expect((await cli(f, 'show', placedItem?.id as string)).output).toContain(`No longer placed: it was approved into ${DRAFT}, but no series or the live revision holds its photo now, as after a rollback. To place it again, reopen it, then approve it.`);
        expect((await cli(f, 'show', loose?.id as string)).output).not.toContain('No longer placed');
        expect(folderBytes(path.join(f.root, 'curation'))).toEqual(before);
    });

    it('counts every item when the data root can\'t show what is placed, and says why', async () => {
        const f = await fixture({ published: true });
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.catalog.series[0].photoIds[0])]);
        expect((await cli(f, 'list')).output).toMatch(/^Curation inbox: 0 items require judgment, 1 already placed, 1 in all\./);
        fs.writeFileSync(path.join(f.root, 'catalog', 'revisions', `${f.catalog.revisionId}.json`), '{');
        const listed = await cli(f, 'list');
        expect(listed.exitCode).toBe(0);
        expect(listed.output).toMatch(/^Curation inbox: 1 item requires judgment, 1 in all\.\nCan't tell which new photographs are already placed, since catalog\/revisions\/rev_[0-9a-f]{64}\.json can't be used \(invalid-json\), so each one counts\.\n/);
        const [event] = (await listEvents(f.root)).events;
        expect(JSON.parse((await cli(f, 'show', event.id, '--json')).output)).toMatchObject({ placed: null, placementUnknown: { file: `catalog/revisions/${f.catalog.revisionId}.json`, reason: 'invalid-json' } });
    });

    it('stops settling an item that new bytes moved, since no photo record pins the bytes it was placed with', async () => {
        const f = await fixture();
        const photoId = f.fresh[0];
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', photoId)]);
        expect(await applySequenceOp({ dataRoot: f.root }, { kind: 'insert', seriesId: DRAFT, photoId, at: 'end' }, { expectedVersion: 1, actor: editor })).toMatchObject({ ok: true, changed: true });
        expect(await readAuthoredRecord(f.root, 'photo', photoId)).toBeNull();
        expect((await cli(f, 'list')).output).toMatch(/^Curation inbox: 0 items require judgment, 1 already placed, 1 in all\./);

        const registry = await readRegistry(f.root);
        const photo = registry.photos[photoId];
        const newer = `sha256-${'8'.repeat(64)}`;
        photo.revisions[newer] = { ...photo.revisions[photo.source.observedRevision], assetRevision: newer };
        photo.source.observedRevision = newer;
        await writeRegistry(f.root, registry, registry.version);
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('replaced', photoId, { assetRevision: newer })]);
        const { events } = await listEvents(f.root);
        expect(events.map((event) => [event.type, event.status, event.version, event.assetRevision])).toEqual([['new', 'open', 2, newer]]);
        const listed = await cli(f, 'list');
        expect(listed.output).toMatch(new RegExp(`^Curation inbox: 1 item requires judgment, 1 in all\\.\\n${events[0].id}@2 `));
        expect((await cli(f, 'show', events[0].id)).output).not.toContain('Already placed');

        // A photo record that pins the new bytes, as draft:init writes one, places them, so the moved item settles again.
        await writeAuthoredRecord({ kind: 'photo', id: photoId, assetRevision: newer, alt: null }, { expectedVersion: 0, root: f.root });
        expect((await cli(f, 'list')).output).toMatch(/^Curation inbox: 0 items require judgment, 1 already placed, 1 in all\./);
    });

    it('counts only a series sequence as a placement, not a cover outside it', async () => {
        const f = await fixture();
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', f.fresh[0])]);
        const series = await readAuthoredRecord(f.root, 'series', DRAFT) as AuthoredSeries;
        await writeAuthoredRecord({ ...series, cover: { photoId: f.fresh[0] } }, { expectedVersion: series.version, root: f.root });
        expect((await readAuthoredRecord(f.root, 'series', DRAFT) as AuthoredSeries).photoIds).not.toContain(f.fresh[0]);
        expect((await cli(f, 'list')).output).toMatch(/^Curation inbox: 1 item requires judgment, 1 in all\./);
    });

    it('is the one placement rule, exported for every view of the inbox', async () => {
        const f = await fixture();
        const placedPhoto = f.catalog.series[0].photoIds[0];
        await createCurationSink({ root: f.root, logger: quiet })([f.fact('new', placedPhoto), f.fact('new', f.fresh[0])]);
        const { events } = await listEvents(f.root);
        const { placed, unknown } = await placedItems(f.root, events);
        expect(unknown).toBeNull();
        expect([...placed.keys()]).toEqual([events.find((event) => event.photoId === placedPhoto)?.id]);
        // @ts-expect-error The placement argument is required, so a view that hasn't adopted placedItems() doesn't compile.
        expect(needsJudgment({ status: 'open' }, null)).toBe(true);
    });
});
