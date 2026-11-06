// @vitest-environment node
import fs from 'node:fs';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetRef } from '../../media/url';
import { publish } from '../publish';
import { runPurge } from '../purge';
import { rollback } from '../rollback';
import { runSequenceCommand } from '../sequence-commands';
import { tombstoneFile } from '../tombstones';
import { readActivePointer } from '../working-layer';
import { cleanupPurgeTemplates, purgeFixture, quiet, type PurgeFixture } from './purgeFixtures';

vi.mock('next/server', async (importOriginal) => ({
    ...await importOriginal<Record<string, unknown>>(),
    // Outside Next there is no request scope, and the route only needs it to wait.
    connection: vi.fn(async () => undefined),
}));

const { GET } = await import('../../../app/media/[photoId]/[assetRevision]/[profileId]/[variant]/route');

/**
 * #15's purge (#181's A10), the A11 coordinator's ruling (a): a tombstone
 * that can't be read never lets its set be served or go live. `/media`
 * passes such a file over, so the set falls through to the live revision's
 * policy, which 404s it, never a 200 and never a throw; and
 * `assets.tombstoned` fails closed, so no publish or rollback that shows it
 * goes live. Each case reads the damaged folder fresh: its root is new to
 * the route's index.
 */

afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

afterAll(() => cleanupPurgeTemplates());

function get(ref: AssetRef): Promise<Response> {
    const segments = { ...ref, variant: 'w800.webp' };
    return GET(new Request(`http://localhost/media/${ref.photoId}/${ref.assetRevision}/${ref.profileId}/${segments.variant}`), { params: Promise.resolve(segments) });
}

/** D purged, while revision 3 is live and only revision 1 shows D. Returns the tombstone's file. */
async function purged(built: PurgeFixture): Promise<string> {
    const result = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'model release withdrawn', actor: 'owner', yes: true, logger: quiet });
    expect(result.outcome).toBe('PURGED');
    return tombstoneFile(built.root, result.tombstone?.tombstoneId ?? '');
}

/** Every read of <file>, async or sync, fails with EACCES, as a tombstone written by another uid as 0600 reads to web. */
function denyReads(file: string): void {
    const denied = () => Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' });
    const readFile = fs.promises.readFile.bind(fs.promises);
    const readFileSync = fs.readFileSync.bind(fs);
    vi.spyOn(fs.promises, 'readFile').mockImplementation((async (target: fs.PathLike, ...rest: unknown[]) => {
        if (String(target) === file) throw denied();
        return readFile(target, ...(rest as [BufferEncoding]));
    }) as typeof fs.promises.readFile);
    vi.spyOn(fs, 'readFileSync').mockImplementation(((target: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
        if (String(target) === file) throw denied();
        return readFileSync(target, ...(rest as [BufferEncoding]));
    }) as typeof fs.readFileSync);
}

const DAMAGES: { name: string; damage(file: string): void; detail: RegExp }[] = [
    { name: 'a tombstone that fails to read with EACCES', damage: denyReads, detail: /EACCES/ },
    { name: 'a malformed tombstone', damage: (file) => fs.writeFileSync(file, '{"tombstoneId": "tomb_'), detail: /not valid JSON/ },
];

describe('a purged set whose tombstone cannot be read (A11, ruling a)', { timeout: 60_000 }, () => {
    for (const { name, damage, detail } of DAMAGES) {
        it(`${name}: /media answers 404 no-store for the set, not 200, and logs what it passed over`, async () => {
            const built = await purgeFixture(411);
            vi.stubEnv('PHOTOGRAPHY_DATA_DIR', built.root);
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
            const file = await purged(built);
            damage(file);
            const d: AssetRef = { photoId: built.d, assetRevision: built.first[built.d], profileId: built.profileId };
            const a: AssetRef = { photoId: built.a, assetRevision: built.first[built.a], profileId: built.profileId };

            const answer = await get(d);
            expect(answer.status).toBe(404);
            expect(answer.headers.get('cache-control')).toBe('no-store');
            // The index did read the folder and passed the file over, rather than serving from an older read.
            expect(warn.mock.calls.flat().join(' ')).toMatch(detail);
            // The live revision's sets still serve.
            expect((await get(a)).status).toBe(200);
        });

        it(`${name}: a rollback to the revision that shows the set is refused, and so is a publish that shows it`, async () => {
            const built = await purgeFixture(411);
            const file = await purged(built);
            // D back in the draft series: the next publish would show it.
            const inserted = await runSequenceCommand({ dataRoot: built.root }, { command: 'insert', seriesId: built.seriesId, photoId: built.d, at: 'end' });
            expect(inserted.exitCode).toBe(0);
            damage(file);

            const back = await rollback({ dataRoot: built.root, revisionId: built.revisions[1], expectedActiveRevisionId: built.revisions[3], actor: 'test', reason: 'bring it back', logger: quiet });
            expect(back.outcome).toBe('VALIDATION_FAILED');
            expect(JSON.stringify(back)).toMatch(/assets\.tombstoned/);
            // The fail-closed finding itself, not a finding about D, since D's tombstone can't be read.
            expect(JSON.stringify(back)).toMatch(/catalog\/tombstones\/tomb_[0-9a-f-]+\.json can't be read as a takedown record: /);
            expect((await readActivePointer(built.root))?.revisionId).toBe(built.revisions[3]);

            const out = await publish({ dataRoot: built.root, actor: 'test', logger: quiet });
            expect(out.outcome).toBe('VALIDATION_FAILED');
            expect(out.errors).toBeGreaterThan(0);
            expect(JSON.stringify(out.issues)).toMatch(/assets\.tombstoned/);
            expect(JSON.stringify(out.issues)).toMatch(/catalog\/tombstones\/tomb_[0-9a-f-]+\.json can't be read as a takedown record: /);
            expect((await readActivePointer(built.root))?.revisionId).toBe(built.revisions[3]);
        });
    }
});
