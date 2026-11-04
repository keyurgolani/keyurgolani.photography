// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    BREAKWATER,
    createPublishFixture,
    editBehindThePage,
    LOW_TIDE,
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
import { readAuthoredRecord } from '../working-layer';
import { AuthoredWriteError } from '../working-layer-writer';

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

async function json(): Promise<{ candidateId: string; activeRevisionId: string | null; empty: boolean; changes: CatalogChange[] }> {
    const result = await runDiffCommand(fixture.root, { json: true });
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.output);
}

async function review(changeIds: string[], overrides: Partial<ReviewArgs> = {}) {
    return runReviewCommand(fixture.root, { changeIds, expect: await candidateId(), expectActive: fixture.revisions[1], actor: 'keyur', ...overrides });
}

const versionOf = async (kind: 'series' | 'photo', id: string) => (await readAuthoredRecord(fixture.root, kind, id))?.version;

describe('photos diff', () => {
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
        expect([...listed].sort()).toEqual(data.changes.map((change) => change.id).sort());
        expect(data.changes.find((change) => change.id === MOVED)).toMatchObject({ category: 'moved', review: { state: 'stale' }, stale: true });
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
        expect((await json()).changes.find((change) => change.id === MOVED)?.review.state).toBe('reviewed');
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

    it('refuses a change ID the diff does not have', async () => {
        const result = await review(['0123456789abcdef']);
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain('0123456789abcdef');
        expect(result.output).toContain('photos diff');
    });

    it('needs change IDs, --expect, --expect-active and an actor, and has no --all', () => {
        const candidate = `rev_${'a'.repeat(64)}`;
        const ok = ['--expect', candidate, '--expect-active', candidate];
        expect(reviewArgs([MOVED, ADDED, MOVED, ...ok], { PHOTOS_ACTOR: 'keyur' })).toEqual({ changeIds: [MOVED, ADDED], expect: candidate, expectActive: candidate, actor: 'keyur' });
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
