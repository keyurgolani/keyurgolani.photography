// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    BREAKWATER,
    createPublishFixture,
    editBehindThePage,
    LOW_TIDE,
    LOW_TIDE_IDS,
    PIER_LAMPS,
    reopenBreakwater,
    SALT_ROADS,
    type PublishFixture,
} from '../../../test/helpers/publishFixture';
import { runTsx } from '../../../test/helpers/runTsx';
import { changeId, type CatalogChange } from '../diff';
import { diffArgs, reviewArgs, runDiffCommand, runReviewCommand, type ReviewArgs } from '../ledger-cli';
import { UsageError } from '../owner-cli';
import { validateWorkingLayer } from '../publish';
import { hashValue } from '../review';
import { markFieldsReviewed, ReviewRefusedError } from '../review-write';
import { identityPaths } from '../../identity/registry';
import { readAuthoredRecord } from '../working-layer';
import { AuthoredWriteError, writeAuthoredRecord } from '../working-layer-writer';

/**
 * #16's `photos diff` and `photos review` on the Publish screen's fixture:
 * a stale order review, a suggested description nobody has reviewed, an
 * Inbox approval, and two published revisions. `photos review` writes stamps
 * through the same markFieldsReviewed() as the screen's "Still right, mark
 * reviewed", against the candidate and the live revision `photos diff`
 * printed, and refuses what only an edit or the Inbox can settle.
 */

let fixture: PublishFixture;

beforeEach(async () => {
    fixture = await createPublishFixture();
}, 60_000);

afterEach(async () => {
    await fixture.cleanup();
});

const MOVED = changeId({ kind: 'series', id: SALT_ROADS }, `photoIds[${PIER_LAMPS}]`, 'moved');
const ADDED = changeId({ kind: 'photo', id: BREAKWATER }, '', 'new');

async function candidateId(): Promise<string> {
    const result = await validateWorkingLayer({ dataRoot: fixture.root });
    if (!result.candidateId) throw new Error(`No candidate: ${result.outcome}: ${result.message}`);
    return result.candidateId;
}

type JsonRow = Pick<CatalogChange, 'id' | 'record' | 'field' | 'category' | 'summary'> & { review: { state: string }; reviewable: boolean; reason: string | null; sharedWith: string[] } & Record<string, unknown>;

async function json(): Promise<{ schemaVersion: number; candidateId: string; activeRevisionId: string | null; empty: boolean; rows: JsonRow[] }> {
    const result = await runDiffCommand(fixture.root, { json: true });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.output);
}

async function review(changeIds: string[], overrides: Partial<ReviewArgs> = {}, hooks?: Parameters<typeof runReviewCommand>[2]) {
    return runReviewCommand(fixture.root, { changeIds, expect: await candidateId(), expectActive: fixture.revisions[1], actor: 'keyur', ...overrides }, hooks);
}

/** Write a record through the tools, with `review` as the stamp's inputs. */
async function rewrite(kind: 'series' | 'photo', id: string, change: (record: never) => object, review?: Parameters<typeof writeAuthoredRecord>[1]['review']) {
    const record = await readAuthoredRecord(fixture.root, kind, id);
    if (record === null) throw new Error(`No ${kind} ${id}`);
    await writeAuthoredRecord(change(record as never) as never, { expectedVersion: record.version, root: fixture.root, ...(review ? { review } : {}) });
}

/** Both real paths of the fixture's data root, which a report must never print. */
const absolute = () => [fixture.root, fs.realpathSync(fixture.root)];

const versionOf = async (kind: 'series' | 'photo', id: string) => (await readAuthoredRecord(fixture.root, kind, id))?.version;

describe('photos diff', () => {
    // A9's review (should-fix 5): the JSON carries a series' positions as the text does.
    it("carries a series' derived row's positions in --json", async () => {
        const data = await json();
        const derived = data.rows.find((row) => row.record.kind === 'series' && row.record.id === SALT_ROADS && row.field === 'derived');
        expect(derived?.positions).toEqual({ shifted: 5, by: 1 });
        expect(derived?.fields).toContain('positions');
    });

    it('prints the grouped ledger with the candidate, the live revision, and what each row waits on', async () => {
        const candidate = await candidateId();
        const result = await runDiffCommand(fixture.root, { json: false });
        expect(result.exitCode).toBe(0);
        const lines = result.output.split('\n');
        expect(lines[0]).toMatch(/^\[photos\] DIFF: \d+ changes for visitors against revision 2: \d+ authored, \d+ derived\. 2 need a review\.$/);
        expect(lines).toContain(`Candidate: ${candidate}`);
        expect(lines).toContain(`Live: ${fixture.revisions[1]} (revision 2)`);
        expect(lines.findIndex((line) => /^Authored \(\d+\)$/.test(line))).toBeLessThan(lines.findIndex((line) => /^Derived \(\d+\)$/.test(line)));
        const moved = lines.findIndex((line) => line.startsWith(`  ${MOVED}  moved  stale  `));
        expect(moved).toBeGreaterThan(0);
        expect(lines.slice(moved + 1, moved + 3).join('\n')).toContain(`Once it's checked: photos review ${MOVED} --expect ${candidate} --expect-active ${fixture.revisions[1]}`);
        const added = lines.findIndex((line) => line.startsWith(`  ${ADDED}  new  unreviewed  `));
        expect(added).toBeGreaterThan(0);
        expect(lines.slice(added + 1, added + 3).join('\n')).toMatch(/photos review can't clear it: .*photos edit/);
    });

    it('gives the same rows as JSON, in the same order', async () => {
        const text = (await runDiffCommand(fixture.root, { json: false })).output;
        const data = await json();
        expect(data.candidateId).toBe(await candidateId());
        expect(data.activeRevisionId).toBe(fixture.revisions[1]);
        expect(data.empty).toBe(false);
        const listed = [...text.matchAll(/^ {2}([0-9a-f]{16}) {2}/gm)].map((match) => match[1]);
        // The text lists the rows by group, the JSON in the diff's order; both have every row once.
        expect([...listed].sort()).toEqual(data.rows.map((row) => row.id).sort());
        expect(data.rows.find((row) => row.id === MOVED)).toMatchObject({ category: 'moved', review: { state: 'stale' }, stale: true });
    });

    it('gives JSON a versioned shape of its own, with whether photos review can mark each row and why not', async () => {
        const data = await json();
        expect(data.schemaVersion).toBe(1);
        expect(Object.keys(data).sort()).toEqual(['activeRevisionId', 'activeRevisionNumber', 'candidateId', 'empty', 'rows', 'schemaVersion']);
        const moved = data.rows.find((row) => row.id === MOVED);
        expect(Object.keys(moved ?? {}).sort()).toEqual(['after', 'before', 'category', 'field', 'group', 'id', 'provenance', 'reason', 'record', 'review', 'reviewable', 'sharedWith', 'stale', 'summary', 'surfaces', 'usePublished', 'visible']);
        expect(moved).toMatchObject({ group: 'authored', reviewable: true, reason: null, sharedWith: [] });
        expect(Object.keys((moved?.review as unknown as { fields: object[] }).fields[0]).sort()).toEqual(['detail', 'field', 'reason', 'record', 'state']);
        expect(data.rows.find((row) => row.id === ADDED)).toMatchObject({ reviewable: false, reason: expect.stringMatching(/photos edit/) });
        expect(data.rows.find((row) => row.category === 'derived')).toMatchObject({ group: 'derived', reviewable: false, reason: 'needs no review' });
    });

    it('shows the before and after of authored and route rows, cut at 200 characters, and no absolute path', async () => {
        const photoId = LOW_TIDE_IDS[0];
        await rewrite('photo', photoId, (photo: object) => ({ ...photo, caption: 'A'.repeat(450) }));
        const output = (await runDiffCommand(fixture.root, { json: false })).output;
        const lines = output.split('\n');
        const short = lines.findIndex((line) => line.startsWith(`  ${changeId({ kind: 'series', id: LOW_TIDE }, 'shortStatement', 'authored')}  authored  `));
        expect(lines.slice(short + 1, short + 3)).toEqual(['      Before: "Five mornings on the estuary before the water comes back."', '      After:  "Six mornings on the estuary before the water comes back."']);
        const caption = lines.findIndex((line) => line.startsWith(`  ${changeId({ kind: 'photo', id: photoId }, 'caption', 'authored')}  authored  `));
        expect(lines.slice(caption + 1, caption + 3)).toEqual(['      Before: (none)', `      After:  "${'A'.repeat(200)}…" (200 of 450 characters)`]);
        for (const root of absolute()) expect(output).not.toContain(root);
    });

    it('names a file it cannot read relative to the data root, never by its absolute path', async () => {
        // A damaged registry: the storage layer's error starts with the file's absolute path.
        const dir = identityPaths(fixture.root).registry;
        const newest = fs.readdirSync(dir).filter((name) => /^v\d+\.json$/.test(name)).sort((a, b) => Number(a.slice(1, -5)) - Number(b.slice(1, -5))).pop() as string;
        fs.writeFileSync(path.join(dir, newest), '{damaged');
        for (const result of [await runDiffCommand(fixture.root, { json: false }), await runReviewCommand(fixture.root, { changeIds: [MOVED], expect: `rev_${'a'.repeat(64)}`, expectActive: fixture.revisions[1], actor: 'keyur' })]) {
            expect(result.exitCode).toBe(4);
            expect(result.output).toMatch(/^\[photos\] STORAGE_ERROR: identity\/registry\/v\d+\.json is not a valid document/);
            for (const root of absolute()) expect(result.output).not.toContain(root);
        }
    });

    it('takes --json and nothing else', () => {
        expect(diffArgs([])).toEqual({ json: false });
        expect(diffArgs(['--json'])).toEqual({ json: true });
        expect(() => diffArgs(['--json', '--json'])).toThrow(UsageError);
        expect(() => diffArgs(['ph_x'])).toThrow(UsageError);
    });
});

describe('photos review', () => {
    it('marks the stale order reviewed against the live revision, as the Publish screen does, and the candidate stays the same', async () => {
        const candidate = await candidateId();
        const before = await versionOf('series', SALT_ROADS);
        const result = await review([MOVED]);
        expect(result.exitCode).toBe(0);
        expect(result.output).toMatch(/^\[photos\] REVIEWED: Marked 1 row reviewed against revision 2\. Nothing was published\./);
        expect(result.output).toContain(MOVED);
        const series = await readAuthoredRecord(fixture.root, 'series', SALT_ROADS);
        expect(series?.version).toBe((before ?? 0) + 1);
        expect(series?.review?.fields.photoIds).toMatchObject({ valueHash: hashValue(series?.photoIds), baseRevisionId: fixture.revisions[1], actor: 'keyur', origin: 'curator' });
        expect(await candidateId()).toBe(candidate);
        expect((await json()).rows.find((row) => row.id === MOVED)?.review.state).toBe('reviewed');
        // Again: nothing left to do, and nothing written.
        const again = await review([MOVED]);
        expect(again.exitCode).toBe(0);
        expect(again.output).toMatch(/^\[photos\] NOTHING_TO_REVIEW: /);
        expect(await versionOf('series', SALT_ROADS)).toBe((before ?? 0) + 1);
    });

    it("refuses a suggested description nobody has reviewed, which photos edit settles, and writes nothing for any row named with it", async () => {
        const series = await versionOf('series', SALT_ROADS);
        const photo = await versionOf('photo', BREAKWATER);
        const result = await review([MOVED, ADDED]);
        expect(result.exitCode).toBe(1);
        expect(result.output).toMatch(/^\[photos\] REFUSED: /);
        expect(result.output).toMatch(new RegExp(`${ADDED} .*photos edit ${BREAKWATER}`));
        expect(result.output).toContain('nothing was written');
        expect(await versionOf('series', SALT_ROADS)).toBe(series);
        expect(await versionOf('photo', BREAKWATER)).toBe(photo);
    });

    it('refuses a row whose Inbox item needs a decision again', async () => {
        await reopenBreakwater(fixture);
        const before = await versionOf('series', LOW_TIDE);
        const result = await review([ADDED]);
        expect(result.exitCode).toBe(1);
        expect(result.output).toMatch(/Decide it in the Inbox first: .*curation show /);
        expect(await versionOf('series', LOW_TIDE)).toBe(before);
    });

    it('refuses once the draft changed since photos diff printed it, and writes nothing', async () => {
        const printed = await candidateId();
        await editBehindThePage(fixture);
        const before = await versionOf('series', SALT_ROADS);
        const result = await review([MOVED], { expect: printed });
        expect(result.exitCode).toBe(3);
        expect(result.output).toMatch(/^\[photos\] CHANGED: The draft changed since photos diff printed it/);
        expect(await versionOf('series', SALT_ROADS)).toBe(before);
    });

    it('refuses once the live revision is not the one photos diff printed', async () => {
        const before = await versionOf('series', SALT_ROADS);
        const result = await review([MOVED], { expectActive: fixture.revisions[0] });
        expect(result.exitCode).toBe(3);
        expect(result.output).toMatch(/^\[photos\] CHANGED: The live revision is /);
        expect(await versionOf('series', SALT_ROADS)).toBe(before);
    });

    it('refuses a move until every row that shares its review is named, and names them', async () => {
        // A second move in Salt Roads, reviewed against revision 1 as the first was: both rows rest on one stamp of the order.
        await rewrite('series', SALT_ROADS, (series: { photoIds: string[] }) => ({ ...series, photoIds: [series.photoIds[series.photoIds.length - 1], ...series.photoIds.slice(0, -1)] }), { baseRevisionId: fixture.revisions[0], actor: 'keyur', reviewedAt: '2026-10-24T09:12:00.000Z' });
        const moves = (await json()).rows.filter((row) => row.category === 'moved' && row.record.id === SALT_ROADS);
        expect(moves.length).toBeGreaterThanOrEqual(2);
        const ids = moves.map((row) => row.id);
        expect(moves[0].sharedWith).toEqual(ids.slice(1));
        const text = (await runDiffCommand(fixture.root, { json: false })).output;
        expect(text).toContain(`Once it's checked: photos review ${ids.join(' ')} --expect `);
        const before = await versionOf('series', SALT_ROADS);
        const one = await review([ids[0]]);
        expect(one.exitCode).toBe(1);
        expect(one.output).toMatch(/^\[photos\] REFUSED: /);
        for (const id of ids.slice(1)) expect(one.output).toContain(id);
        expect(one.output).toContain('Name them too');
        expect(await versionOf('series', SALT_ROADS)).toBe(before);
        const all = await review(ids);
        expect(all.exitCode).toBe(0);
        expect(all.output).toMatch(new RegExp(`^\\[photos\\] REVIEWED: Marked ${ids.length} rows reviewed`));
    });

    it('checks every record under one hold before it writes any, so a record that moves writes nothing', async () => {
        // The Low Tide statement, written as a suggestion nobody reviewed: a row photos review may clear, in another record than the order.
        await rewrite('series', LOW_TIDE, (series: object) => ({ ...series, statement: 'Mornings on the estuary, an hour before the tide.' }), { baseRevisionId: fixture.revisions[1], origin: 'generated', actor: 'rules', reviewedAt: '2026-10-25T08:30:00.000Z' });
        const statement = changeId({ kind: 'series', id: LOW_TIDE }, 'statement', 'authored');
        expect((await json()).rows.find((row) => row.id === statement)).toMatchObject({ reviewable: true });
        const lowTide = await versionOf('series', LOW_TIDE);
        // Salt Roads moves after photos review read the draft and before it writes.
        const result = await review([statement, MOVED], {}, { afterRead: () => rewrite('series', SALT_ROADS, (series: object) => ({ ...series, title: 'Salt Roads, again' })) });
        expect(result.exitCode).toBe(3);
        expect(result.output).toContain('Nothing was written.');
        expect(await versionOf('series', LOW_TIDE)).toBe(lowTide);
    });

    it('refuses a change ID the diff does not have', async () => {
        const result = await review(['0123456789abcdef']);
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain('0123456789abcdef');
        expect(result.output).toContain('photos diff');
    });

    it('needs change IDs, --expect, --expect-active and an actor, and has no --all', () => {
        const candidate = `rev_${'a'.repeat(64)}`;
        const ok = ['--expect', candidate, '--expect-active', candidate];
        expect(reviewArgs([MOVED, ADDED, MOVED, ...ok], { PHOTOS_ACTOR: 'keyur' })).toEqual({ changeIds: [MOVED, ADDED], expect: candidate, expectActive: candidate, actor: 'keyur', usePublished: false });
        expect(reviewArgs([MOVED, '--expect', candidate, '--expect-active', 'none', '--actor', 'curator'], {})).toMatchObject({ expectActive: null, actor: 'curator' });
        expect(() => reviewArgs(ok, { PHOTOS_ACTOR: 'keyur' })).toThrow(/needs at least one change ID/);
        expect(() => reviewArgs(['MOVED', ...ok], { PHOTOS_ACTOR: 'keyur' })).toThrow(/is not a change ID/);
        expect(() => reviewArgs([MOVED, '--expect-active', candidate], { PHOTOS_ACTOR: 'keyur' })).toThrow(/--expect <candidateId>/);
        expect(() => reviewArgs([MOVED, '--expect', candidate], { PHOTOS_ACTOR: 'keyur' })).toThrow(/--expect-active <revisionId \| none>/);
        expect(() => reviewArgs([MOVED, ...ok], {})).toThrow(/--actor <name> or PHOTOS_ACTOR/);
        expect(() => reviewArgs(['--all', ...ok], { PHOTOS_ACTOR: 'keyur' })).toThrow(UsageError);
    });
});

describe("markFieldsReviewed(), the Publish screen's and photos review's one writer", () => {
    const target = async () => {
        const series = await readAuthoredRecord(fixture.root, 'series', SALT_ROADS);
        if (series === null) throw new Error('No Salt Roads');
        return { root: fixture.root, record: { kind: 'series' as const, id: SALT_ROADS }, version: series.version, hashes: { photoIds: hashValue(series.photoIds) }, baseRevisionId: fixture.revisions[1], actor: 'keyur' };
    };

    it('refuses a value or a version the caller did not see, under the authored write', async () => {
        const input = await target();
        await expect(markFieldsReviewed({ ...input, version: input.version - 1 })).rejects.toMatchObject({ constructor: AuthoredWriteError, code: 'VERSION_CONFLICT' });
        await expect(markFieldsReviewed({ ...input, hashes: { photoIds: hashValue([]) } })).rejects.toMatchObject({ constructor: AuthoredWriteError, code: 'VERSION_CONFLICT' });
        expect(await versionOf('series', SALT_ROADS)).toBe(input.version);
    });

    it('refuses once the live revision moved, and a field with nothing a review may clear', async () => {
        const input = await target();
        await expect(markFieldsReviewed({ ...input, baseRevisionId: fixture.revisions[0] })).rejects.toMatchObject({ constructor: ReviewRefusedError, code: 'active-moved' });
        const photo = await readAuthoredRecord(fixture.root, 'photo', BREAKWATER);
        if (photo === null || photo.kind !== 'photo') throw new Error('No Breakwater');
        await expect(markFieldsReviewed({ ...input, record: { kind: 'photo', id: BREAKWATER }, version: photo.version, hashes: { alt: hashValue(photo.alt) } })).rejects.toMatchObject({ constructor: ReviewRefusedError, code: 'not-clearable' });
        expect(await versionOf('photo', BREAKWATER)).toBe(photo.version);
    });

    it("refuses a field a restore's rebase left in conflict, which only an edit settles", async () => {
        await rewrite('series', SALT_ROADS, (series: object) => ({ ...series, conflicts: [{ field: 'photoIds', base: [], active: [] }] }));
        const input = await target();
        await expect(markFieldsReviewed(input)).rejects.toMatchObject({ constructor: ReviewRefusedError, code: 'conflict' });
        expect(await versionOf('series', SALT_ROADS)).toBe(input.version);
    });

    it('stamps what the caller saw', async () => {
        const input = await target();
        await markFieldsReviewed(input);
        expect((await readAuthoredRecord(fixture.root, 'series', SALT_ROADS))?.review?.fields.photoIds).toMatchObject({ baseRevisionId: fixture.revisions[1], actor: 'keyur' });
    });
});

describe('photos diff and photos review, as commands', { timeout: 120_000 }, () => {
    it('runs from scripts/photos.ts, and refuses --all as a usage error', async () => {
        const env = { PHOTOGRAPHY_DATA_DIR: fixture.root, PHOTOS_ACTOR: 'keyur' };
        const diff = await runTsx('scripts/photos.ts', ['diff', '--json'], { env });
        expect(diff.code).toBe(0);
        const candidate = JSON.parse(diff.stdout).candidateId as string;
        const all = await runTsx('scripts/photos.ts', ['review', '--all', '--expect', candidate, '--expect-active', fixture.revisions[1]], { env });
        expect(all.code).toBe(2);
        expect(all.stderr).toContain('photos.ts review <changeId>...');
        const done = await runTsx('scripts/photos.ts', ['review', MOVED, '--expect', candidate, '--expect-active', fixture.revisions[1]], { env });
        expect(done.code).toBe(0);
        expect(done.stdout).toContain('[photos] REVIEWED: ');
    });
});

describe('module boundaries', () => {
    it("keeps the Publish screen's view on the pure review reasons, away from the writer", () => {
        const source = (file: string) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
        const imports = (file: string) => [...source(file).matchAll(/^import (type )?[^;]*? from '([^']+)';$/gm)].map((match) => ({ type: Boolean(match[1]), from: match[2] }));
        expect(imports('curation/publish-view.ts').map((entry) => entry.from)).not.toContain('../catalog/review-write');
        expect(imports('curation/publish-view.ts').map((entry) => entry.from)).toContain('../catalog/review-reasons');
        // Types only: no fs, no lock, no writer.
        expect(imports('catalog/review-reasons.ts').every((entry) => entry.type)).toBe(true);
    });
});
