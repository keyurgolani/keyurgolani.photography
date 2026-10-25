// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { runTsx } from '../../../test/helpers/runTsx';
import { createTempDataRoot } from '../../../test/helpers/tempDataRoot';
import { readAuthoredRecord } from '../../catalog/working-layer';
import { parseCurationArgs, printable, runCurationCli, scrub, type CommandResult } from '../commands';
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
        expect(JSON.parse((await cli(f, 'list', '--json')).output)).toEqual({ needsJudgment: 0, total: 0, events: [], problems: [] });
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
        [['dismiss', `evt_${'0'.repeat(24)}`, '--version', '1', '--reason', 'two\nlines'], /control characters/],
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
    it('scrubs the data root from a storage error on the command path', async () => {
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
