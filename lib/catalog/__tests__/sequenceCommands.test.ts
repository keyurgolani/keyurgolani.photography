// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { withLock } from '../../storage/lock';
import { runSequenceCommand, type SequenceCommand } from '../sequence-commands';
import { createTestCatalog, type TestCatalog } from '../testing';
import { authoredRecordDir, readAuthoredRecord } from '../working-layer';
import { writeAuthoredRecord } from '../working-layer-writer';

const P = Array.from({ length: 8 }, (_, index) => `ph_00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
const S1 = 'ser_fixture-01';
const S2 = 'ser_fixture-02';

let catalog: TestCatalog;

beforeEach(async () => {
    // S1: P0 to P3, chapters one (P0) and two (P2), cover P0, opening P1. S2: P4, P5. P6 and P7 are in no series.
    catalog = await createTestCatalog({
        seed: 10,
        photos: P.map((id) => ({ id })),
        series: [
            {
                id: S1,
                photoIds: P.slice(0, 4),
                cover: { photoId: P[0], focalPoint: { x: 0.5, y: 0.5 } },
                openingPhotoId: P[1],
                chapters: [
                    { id: 'ch_one', title: 'Fixture chapter one', startPhotoId: P[0] },
                    { id: 'ch_two', title: 'Fixture chapter two', startPhotoId: P[2] },
                ],
            },
            { id: S2, photoIds: [P[4], P[5]] },
        ],
    });
});

afterEach(async () => {
    await catalog.cleanup();
});

const run = (command: SequenceCommand, waitMs?: number) => runSequenceCommand({ dataRoot: catalog.root, waitMs }, command);

async function order(seriesId = S1): Promise<string[]> {
    return (await readAuthoredRecord(catalog.root, 'series', seriesId))?.photoIds ?? [];
}

describe('sequence show', () => {
    it('prints the numbered sequence with chapters, the cover, and the opening photo', async () => {
        const { exitCode, output } = await run({ command: 'show', seriesId: S1 });
        expect(exitCode).toBe(0);
        expect(output).toBe([
            `${S1}, version 1, 4 photographs`,
            '  Chapter ch_one: Fixture chapter one',
            `  01  ${P[0]}  cover`,
            `  02  ${P[1]}  opening`,
            '  Chapter ch_two: Fixture chapter two',
            `  03  ${P[2]}`,
            `  04  ${P[3]}`,
            '',
        ].join('\n'));
    });

    it('marks members a publish would block for their description', async () => {
        const photo = (id: string) => readAuthoredRecord(catalog.root, 'photo', id);
        const undescribed = await photo(P[1]);
        const suggested = await photo(P[2]);
        if (!undescribed || !suggested) throw new Error('fixture records missing');
        await writeAuthoredRecord({ ...undescribed, alt: null }, { expectedVersion: undescribed.version, root: catalog.root });
        await writeAuthoredRecord({ ...suggested, alt: { kind: 'described', text: 'A fixture suggestion.', reviewed: false } }, { expectedVersion: suggested.version, root: catalog.root });
        fs.rmSync(authoredRecordDir(catalog.root, 'photo', P[3]), { recursive: true });
        const { output } = await run({ command: 'show', seriesId: S1 });
        expect(output).toContain(`02  ${P[1]}  opening, no description`);
        expect(output).toContain(`03  ${P[2]}  description not reviewed`);
        expect(output).toContain(`04  ${P[3]}  no photo record`);
    });

    it('exits 1 for a series that does not exist', async () => {
        expect(await run({ command: 'show', seriesId: 'ser_fixture-09' })).toEqual({ exitCode: 1, output: expect.stringContaining('unknown-series') });
    });
});

describe('--to N', () => {
    it.each([
        [1, [P[6], ...P.slice(0, 4)]],
        [3, [P[0], P[1], P[6], P[2], P[3]]],
        [5, [...P.slice(0, 4), P[6]]],
    ])('inserts a new photo so it ends up at position %i', async (to, expected) => {
        expect((await run({ command: 'insert', seriesId: S1, photoId: P[6], at: { to } })).exitCode).toBe(0);
        expect(await order()).toEqual(expected);
    });

    it.each([
        [1, [P[3], P[0], P[1], P[2]]],
        [2, [P[0], P[3], P[1], P[2]]],
        [4, P.slice(0, 4)],
    ])('moves a member so it ends up at position %i', async (to, expected) => {
        expect((await run({ command: 'move', seriesId: S1, photoId: P[3], at: { to } })).exitCode).toBe(0);
        expect(await order()).toEqual(expected);
    });

    it.each([
        ['insert', P[6], 6],
        ['move', P[3], 5],
    ] as const)('%s exits 1 with position-out-of-range past the end of the result', async (command, photoId, to) => {
        const before = await order();
        const result = await run({ command, seriesId: S1, photoId, at: { to } });
        expect(result).toEqual({ exitCode: 1, output: expect.stringContaining('position-out-of-range') });
        expect(await order()).toEqual(before);
    });

    it.each([0, -1, 1.5])('exits 2 for a position of %s, which is not a position', async (to) => {
        expect((await run({ command: 'insert', seriesId: S1, photoId: P[6], at: { to } })).exitCode).toBe(2);
    });
});

describe('the other commands', () => {
    it('print the sequence after a change, with each consequence', async () => {
        const { exitCode, output } = await run({ command: 'remove', seriesId: S1, photoId: P[0] });
        expect(exitCode).toBe(0);
        expect(output).toContain(`Cover cleared: it was ${P[0]}. Set a new cover before publishing.`);
        expect(output).toContain(`Focal point dropped with the cover ${P[0]}.`);
        expect(output).toContain(`Chapter ch_one now starts on ${P[1]} instead of ${P[0]}.`);
        expect(output).toContain(`${S1}, version 2, 3 photographs`);
        expect(output).toContain(`  01  ${P[1]}  opening`);
    });

    it('say when nothing changed', async () => {
        const { exitCode, output } = await run({ command: 'move', seriesId: S1, photoId: P[3], at: 'end' });
        expect(exitCode).toBe(0);
        expect(output).toMatch(/^No change\./);
        expect(output).toContain(`${S1}, version 1, 4 photographs`);
    });

    it('set a sequence, a cover and its focal point, and the opening photo', async () => {
        expect((await run({ command: 'set', seriesId: S1, photoIds: [P[0], P[1], P[2], P[3], P[6]] })).exitCode).toBe(0);
        expect((await run({ command: 'cover', seriesId: S1, photoId: P[6], focal: { x: 0.2, y: 0.4 } })).output).toContain(`Focal point dropped with the cover ${P[0]}.`);
        expect((await run({ command: 'cover', seriesId: S1, photoId: P[6], focal: 'clear' })).exitCode).toBe(0);
        expect((await run({ command: 'opening', seriesId: S1, photoId: null })).exitCode).toBe(0);
        const series = await readAuthoredRecord(catalog.root, 'series', S1);
        expect(series).toMatchObject({ photoIds: [P[0], P[1], P[2], P[3], P[6]], cover: { photoId: P[6] } });
        expect(series?.cover).not.toHaveProperty('focalPoint');
        expect(series?.openingPhotoId).toBeUndefined();
    });

    it('add, move, and remove chapters', async () => {
        const added = await run({ command: 'chapter-add', seriesId: S1, title: 'Fixture chapter three', startPhotoId: P[3] });
        expect(added.exitCode).toBe(0);
        expect(added.output).toMatch(/Chapter ch_[0-9a-f-]{36}: Fixture chapter three/);
        expect((await run({ command: 'chapter-move', seriesId: S1, chapterId: 'ch_two', startPhotoId: P[1] })).exitCode).toBe(0);
        expect((await run({ command: 'chapter-remove', seriesId: S1, chapterId: 'ch_two' })).exitCode).toBe(0);
        expect(await run({ command: 'chapter-remove', seriesId: S1, chapterId: 'ch_two' })).toEqual({ exitCode: 1, output: expect.stringContaining('anchor-not-found') });
    });

    it('set the Work order and the featured series', async () => {
        const result = await run({ command: 'series-order', seriesIds: [S2, S1] });
        expect(result).toEqual({ exitCode: 0, output: expect.stringContaining(`Work order, version 2\n  01  ${S2}\n  02  ${S1}\n`) });
        expect((await run({ command: 'series-featured', seriesIds: [S2] })).output).toContain(`Featured series, version 3\n  01  ${S2}\n`);
        expect(await run({ command: 'series-order', seriesIds: [S1, 'ser_fixture-09'] })).toEqual({ exitCode: 1, output: expect.stringContaining('unknown-series') });
    });
});

describe('exit codes', () => {
    it('exit 1 for an operation the sequence rules refuse', async () => {
        expect(await run({ command: 'remove', seriesId: S1, photoId: P[6] })).toEqual({ exitCode: 1, output: expect.stringContaining('not-a-member') });
    });

    it('exit 3 for a stale --expect-version, and default it to the current version', async () => {
        expect(await run({ command: 'remove', seriesId: S1, photoId: P[3], expectVersion: 7 })).toEqual({ exitCode: 3, output: expect.stringContaining('version-conflict') });
        expect((await run({ command: 'remove', seriesId: S1, photoId: P[3] })).exitCode).toBe(0);
        expect((await run({ command: 'remove', seriesId: S1, photoId: P[1], expectVersion: 2 })).exitCode).toBe(0);
    });

    it('exit 3 while another writer holds the authored lock', async () => {
        await withLock('authored', { root: catalog.root, leaseMs: 10_000 }, async () => {
            expect(await run({ command: 'remove', seriesId: S1, photoId: P[3] }, 100)).toEqual({ exitCode: 3, output: expect.stringContaining('authored-locked') });
        });
    });

    it('exit 4 when the data root can\'t be used', async () => {
        fs.rmSync(path.join(catalog.root, 'data-root.json'));
        expect(await run({ command: 'remove', seriesId: S1, photoId: P[3] })).toEqual({ exitCode: 4, output: expect.stringContaining('data root') });
    });

    it.each([
        ['an empty chapter title', { command: 'chapter-add', seriesId: S1, title: ' ', startPhotoId: P[3] }],
        ['a focal point outside 0 to 1', { command: 'cover', seriesId: S1, photoId: P[0], focal: { x: 1.5, y: 0 } }],
        ['a negative --expect-version', { command: 'remove', seriesId: S1, photoId: P[3], expectVersion: -1 }],
    ] as const)('exit 2 for %s, and write nothing', async (_label, command) => {
        const before = folderBytes(authoredRecordDir(catalog.root, 'series', S1));
        expect((await run(command as SequenceCommand)).exitCode).toBe(2);
        expect(folderBytes(authoredRecordDir(catalog.root, 'series', S1))).toEqual(before);
    });
});
