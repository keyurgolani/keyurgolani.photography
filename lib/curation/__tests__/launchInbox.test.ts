// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runTsx, type TsxRun } from '../../../test/helpers/runTsx';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { STABILITY_MS } from '../../identity/reconcile';

/**
 * The launch path as the owner runs it, migrate, the watcher's pass,
 * `draft:init`, `sequence set`, and publish, then what the inbox says: the
 * new items for photos `sequence set` placed need no judgment, and the one
 * photo left out still does. Then the rehearsal's rollback: approve that
 * photo, publish it, roll back, and the approval reads as no longer placed
 * until it is reopened and approved again.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SERIES = 'ser_launch-inbox';

interface Listed {
    needsJudgment: number;
    placed: number;
    unplaced: number;
    total: number;
    events: { id: string; version: number; type: string; status: string; photoId: string | null; sourcePath: string; placed: string | null; unplaced: string | null }[];
}

describe('the inbox after the launch path', () => {
    it('settles the new items for photos sequence set placed, keeps the unplaced one open, and marks an approval a rollback undid', { timeout: 300_000 }, async () => {
        const lib: TempLibrary = await createTempLibrary({ fixtures: 'basic' });
        cleanups.push(() => lib.cleanup());
        const data: TempDataRoot = createTempDataRoot({ state: 'uninitialized' });
        cleanups.push(() => data.cleanup());
        const env = { PHOTOGRAPHY_LIBRARY_DIR: lib.root, PHOTOGRAPHY_DATA_DIR: data.root, PHOTOS_ACTOR: undefined };
        const photos = (...args: string[]): Promise<TsxRun> => runTsx('scripts/photos.ts', args, { env });
        const ok = (run: TsxRun) => {
            expect(run.code, `${run.stdout}\n${run.stderr}`).toBe(0);
            return run.stdout;
        };
        const inbox = async (...args: string[]) => JSON.parse(ok(await photos('curation', 'list', '--json', ...args))) as Listed;
        await sleep(STABILITY_MS + 500);

        const plan = /^Plan: (.+)$/m.exec(ok(await photos('migrate', '--dry-run')))?.[1];
        ok(await photos('migrate', '--apply', '--plan', plan ?? ''));
        const watcher = await runTsx('scripts/imageWatcher.ts', ['--once'], { env });
        expect(watcher.code, watcher.stderr).toBe(0);
        expect(await inbox()).toMatchObject({ needsJudgment: 3, placed: 0, total: 3 });

        ok(await photos('draft:init'));
        const listed = JSON.parse(ok(await photos('list', '--json'))) as { photoId: string; source: string }[];
        const id = (source: string) => listed.find((row) => row.source === source)?.photoId as string;
        const [landscape, portrait, square] = [id('landscape.jpg'), id('portrait.png'), id('square.webp')];

        fs.mkdirSync(data.file('authored', 'series', SERIES), { recursive: true, mode: 0o700 });
        fs.writeFileSync(data.file('authored', 'series', SERIES, 'v1.json'), `${JSON.stringify({
            schemaVersion: 1,
            version: 1,
            baseRevisionId: null,
            kind: 'series',
            id: SERIES,
            slug: 'launch-inbox',
            title: 'Launch inbox fixture series',
            statement: 'A fixture statement for the launch inbox test. Not real copy.',
            shortStatement: 'A fixture short statement.',
            visibility: 'published',
        }, null, 2)}\n`);
        ok(await photos('sequence', 'set', SERIES, landscape, portrait));

        // Placed in the draft: settled before any publish.
        const drafted = await inbox();
        expect(drafted).toMatchObject({ needsJudgment: 1, placed: 2, total: 3 });
        expect(drafted.events.map((event) => event.photoId)).toEqual([square]);
        const text = ok(await photos('curation', 'list'));
        expect(text).toMatch(/^Curation inbox: 1 item requires judgment, 2 already placed, 3 in all\.\n/);

        ok(await photos('sequence', 'cover', SERIES, portrait));
        ok(await photos('series', 'order', SERIES));
        ok(await photos('series', 'featured', SERIES));
        const csv = path.join(path.dirname(data.root), 'descriptions.csv');
        fs.writeFileSync(csv, ['photoId,alt', `${landscape},A warm fixture gradient.`, `${portrait},A green fixture gradient.`, ''].join('\n'));
        ok(await photos('describe', '--import', csv));
        const unconfirmed = await photos('publish', '--actor', 'launch-inbox');
        const candidate = /--confirm-launch --expect (rev_[0-9a-f]{64})\./.exec(unconfirmed.stderr)?.[1];
        expect(candidate, `${unconfirmed.stdout}\n${unconfirmed.stderr}`).toBeDefined();
        ok(await photos('publish', '--actor', 'launch-inbox', '--confirm-launch', '--expect', candidate ?? ''));

        // Published: still settled, by the series and the active revision, and the unplaced photo still needs judgment.
        const published = await inbox('--all');
        expect(published).toMatchObject({ needsJudgment: 1, placed: 2, total: 3 });
        const byPhoto = new Map(published.events.map((event) => [event.photoId, event]));
        expect(byPhoto.get(landscape)).toMatchObject({ type: 'new', status: 'open', placed: `its photo is in the active revision ${candidate} and the series ${SERIES}` });
        expect(byPhoto.get(portrait)?.placed).not.toBeNull();
        expect(byPhoto.get(square)).toMatchObject({ type: 'new', status: 'open', placed: null });
        expect((await inbox()).events.map((event) => event.photoId)).toEqual([square]);

        // The rehearsal's rollback: approve the third photo into the series, publish it as revision 2, and roll back to 1.
        const item = byPhoto.get(square) as Listed['events'][number];
        ok(await photos('curation', 'approve', item.id, '--version', String(item.version), '--series', SERIES, '--description', 'A purple fixture checkerboard.', '--base', candidate ?? ''));
        const second = /PUBLISHED: Published (rev_[0-9a-f]{64}) as revision 2\./.exec(ok(await photos('publish', '--actor', 'launch-inbox')))?.[1];
        expect(second).toBeDefined();
        expect(await inbox()).toMatchObject({ needsJudgment: 0, placed: 2, unplaced: 0, events: [] });
        ok(await photos('rollback', '--to', '1', '--reason', 'launch inbox test', '--actor', 'launch-inbox', '--yes', '--expect-active', second ?? ''));
        const unlisted = JSON.parse(ok(await photos('list', '--unassigned', '--json'))) as { photoId: string }[];
        expect(unlisted.map((row) => row.photoId)).toEqual([square]);

        // Still approved, as stored, and the default list, --all, show, and the summary line all say its photo left the draft.
        const rolledBack = await inbox();
        expect(rolledBack).toMatchObject({ needsJudgment: 0, placed: 2, unplaced: 1, total: 3 });
        expect(rolledBack.events).toEqual([expect.objectContaining({ id: item.id, status: 'approved', unplaced: SERIES })]);
        expect((await inbox('--all')).events.find((event) => event.id === item.id)).toMatchObject({ status: 'approved', unplaced: SERIES });
        const summary = ok(await photos('curation', 'list'));
        expect(summary).toMatch(/^Curation inbox: 0 items require judgment, 2 already placed, 1 approved but no longer placed, 3 in all\.\n/);
        expect(summary).toContain(`  approved  ${square.slice(0, 11)}  square.webp  unplaced: approved into ${SERIES}, but no series or the live revision holds its photo now`);
        const shown = ok(await photos('curation', 'show', item.id));
        expect(shown).toContain(`No longer placed: it was approved into ${SERIES}, but no series or the live revision holds its photo now, as after a rollback. To place it again, reopen it, then approve it.`);
        const version = Number(/^evt_[0-9a-f]{24}, version (\d+):/.exec(shown)?.[1]);

        // Reopened, it needs judgment again; approved again, it is placed and leaves the default list.
        ok(await photos('curation', 'reopen', item.id, '--version', String(version), '--base', candidate ?? ''));
        expect(await inbox()).toMatchObject({ needsJudgment: 1, placed: 2, unplaced: 0 });
        ok(await photos('curation', 'approve', item.id, '--version', String(version + 1), '--series', SERIES, '--base', candidate ?? ''));
        expect(await inbox()).toMatchObject({ needsJudgment: 0, placed: 2, unplaced: 0, events: [] });
        expect(ok(await photos('curation', 'show', item.id))).not.toContain('No longer placed');
    });
});
