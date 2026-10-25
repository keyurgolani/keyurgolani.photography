// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { runTsx, type TsxRun } from '../../../test/helpers/runTsx';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { STABILITY_MS } from '../../identity/reconcile';
import { readRevisionFile } from '../repository';
import { readActivePointer } from '../working-layer';

/**
 * #13 slice D's walkthrough on temp roots: the owner's commands, run as the
 * CLI, take a migrated fixture library to a launch revision. Every step is a
 * `photos` command but the one series record, which no command creates yet,
 * so it is written by hand as the README says.
 */

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const SERIES = 'ser_walkthrough';

describe('the owner walkthrough', () => {
    it('goes from a migrated library to a launch revision, with validate failing first on a missing description', { timeout: 300_000 }, async () => {
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
        // The scan skips files written within the last few seconds as still changing.
        await sleep(STABILITY_MS + 500);

        // 1. The migration, as docs/data-root.md runs it, and one watcher pass to build every set.
        const plan = /^Plan: (.+)$/m.exec(ok(await photos('migrate', '--dry-run')))?.[1];
        expect(plan).toBeDefined();
        ok(await photos('migrate', '--apply', '--plan', plan ?? ''));
        const watcher = await runTsx('scripts/imageWatcher.ts', ['--once'], { env });
        expect(watcher.code, watcher.stderr).toBe(0);
        expect(ok(await photos('status'))).toContain('Working layer: no site.json, 0 series records (published 0, draft 0, hidden 0), 0 photo records');

        // 2. A record for each photo, and the IDs list prints.
        expect(ok(await photos('draft:init'))).toContain('Created site.json. Created 3 photo records, and 0 photos already had one.');
        const listed = JSON.parse(ok(await photos('list', '--json'))) as { photoId: string; source: string; alt: string; w400: string | null }[];
        expect(listed.map((row) => [row.source, row.alt])).toEqual([['landscape.jpg', 'none'], ['portrait.png', 'none'], ['square.webp', 'none']]);
        expect(listed.every((row) => row.w400 !== null && fs.existsSync(path.join(data.root, row.w400)))).toBe(true);
        const [landscape, portrait, square] = listed.map((row) => row.photoId);

        // 3. The series record, by hand, then its sequence, cover, a chapter, and the site's order through the commands.
        fs.mkdirSync(data.file('authored', 'series', SERIES), { recursive: true, mode: 0o700 });
        fs.writeFileSync(data.file('authored', 'series', SERIES, 'v1.json'), `${JSON.stringify({
            schemaVersion: 1,
            version: 1,
            baseRevisionId: null,
            kind: 'series',
            id: SERIES,
            slug: 'walkthrough',
            title: 'Walkthrough fixture series',
            statement: 'A fixture statement for the walkthrough. Not real copy.',
            shortStatement: 'A fixture short statement.',
            visibility: 'published',
        }, null, 2)}\n`);
        expect(ok(await photos('sequence', 'set', SERIES, landscape, portrait, square))).toContain(`${SERIES}, version 2, 3 photographs`);
        ok(await photos('sequence', 'cover', SERIES, portrait, '--focal', '0.5,0.4'));
        ok(await photos('sequence', 'chapter', 'add', SERIES, '--start', square, '--', '-Fixture chapter'));
        ok(await photos('series', 'order', SERIES));
        expect(ok(await photos('series', 'featured', SERIES))).toContain(`Featured series, version 3\n  01  ${SERIES}`);

        // 4. Descriptions for two of the three, from CSV, so validate fails on the third.
        const csv = path.join(path.dirname(data.root), 'descriptions.csv');
        fs.writeFileSync(csv, [
            'photoId,alt,title,caption',
            `${landscape},A warm fixture gradient from red to orange.,Fixture landscape,"Fixture caption,\nover two lines."`,
            `${portrait},A green fixture gradient in portrait.,,`,
            '',
        ].join('\r\n'));
        expect(ok(await photos('describe', '--import', csv, '--dry-run'))).toContain('Would update 2 photo records');
        expect(ok(await photos('describe', '--import', csv))).toContain('Updated 2 photo records, and 0 rows change nothing.');
        const failing = await photos('validate');
        expect(failing.code).toBe(1);
        expect(failing.stderr).toMatch(new RegExp(`^error photo ${square} alt: .+ \\(description\\.[a-z-]+\\)$`, 'm'));

        // 5. The third, from JSON, and validate passes.
        const json = path.join(path.dirname(data.root), 'descriptions.json');
        fs.writeFileSync(json, JSON.stringify([{ photoId: square, alt: 'A purple and lilac fixture checkerboard.' }]));
        ok(await photos('describe', '--import', json));
        expect(ok(await photos('validate'))).toMatch(/^\[photos\] VALID: /m);

        // 6. The first publish stops for the launch, with the checklist and the exact command, then publishes.
        const unconfirmed = await photos('publish', '--actor', 'walkthrough');
        expect(unconfirmed.code).toBe(3);
        expect(unconfirmed.stderr).toContain('Launch: this revision replaces the legacy Home and Gallery with 3 photographs. Every photograph the legacy site lists is in it.');
        expect(unconfirmed.stderr).toContain('Launch checklist');
        const candidate = /--confirm-launch --expect (rev_[0-9a-f]{64})\./.exec(unconfirmed.stderr)?.[1];
        expect(candidate).toBeDefined();
        const published = ok(await photos('publish', '--actor', 'walkthrough', '--confirm-launch', '--expect', candidate ?? ''));
        expect(published).toContain(`[photos] PUBLISHED: Published ${candidate} as revision 1.`);
        expect(published).not.toContain('checklist');

        // 7. status names it, and the revision holds the imported copy.
        expect(ok(await photos('status'))).toContain(`Catalog: catalog mode, revision 1 (${candidate}) active since `);
        expect((await readActivePointer(data.root))?.revisionId).toBe(candidate);
        const revision = await readRevisionFile(data.root, candidate ?? '');
        expect(revision?.content.series.map((series) => [series.id, series.photoIds, series.cover?.photoId, series.chapters.map((chapter) => chapter.title)]))
            .toEqual([[SERIES, [landscape, portrait, square], portrait, ['-Fixture chapter']]]);
        const byId = new Map(revision?.content.photos.map((photo) => [photo.id, photo]));
        expect(byId.get(landscape)).toMatchObject({ alt: { kind: 'described', text: 'A warm fixture gradient from red to orange.' }, title: 'Fixture landscape', caption: 'Fixture caption,\nover two lines.' });
        expect(byId.get(square)?.alt).toEqual({ kind: 'described', text: 'A purple and lilac fixture checkerboard.' });
        expect(JSON.stringify(revision)).not.toContain(lib.root);
        expect(JSON.stringify(revision)).not.toContain(data.root);
    });
});
