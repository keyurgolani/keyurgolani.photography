// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockingReasons } from '../../curation/publish-history';
import { publish } from '../publish';
import { runPurge, runRevoke } from '../purge';
import { planRollback, rollback } from '../rollback';
import { runSequenceCommand } from '../sequence-commands';
import { createTombstoneIndex, readTombstones, readTombstonesSync, tombstonesDir } from '../tombstones';
import { runVerifyCommand } from '../verify-cli';
import { readActivePointer } from '../working-layer';
import { cleanupPurgeTemplates, purgeFixture, quiet, writeRevoke, writeTombstone, type PurgeFixture } from './purgeFixtures';

/**
 * #181's A10: reading tombstones, and what a standing one stops: a publish,
 * a rollback, and photos verify, through `assets.tombstoned`, with History's
 * plain words. Test values only.
 */

const cleanups: (() => void)[] = [];
let library = '';

beforeAll(() => {
    library = fs.mkdtempSync(path.join(os.tmpdir(), 'tombstones-test-library-'));
});

// No test here reaches a real library.
beforeEach(() => {
    vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', library);
});

afterEach(() => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

afterAll(() => {
    cleanupPurgeTemplates();
});

async function fixture(): Promise<PurgeFixture> {
    const built = await purgeFixture(117);
    cleanups.push(built.cleanup);
    return built;
}

async function purgeD(built: PurgeFixture): Promise<string> {
    const result = await runPurge({ dataRoot: built.root, photoId: built.d, reason: 'x', actor: 'owner', yes: true, logger: quiet });
    if (result.outcome !== 'PURGED' || !result.tombstone) throw new Error(result.message);
    return result.tombstone.tombstoneId;
}

describe('readTombstones()', { timeout: 120_000 }, () => {
    it('reads each tombstone with its revoke, and lists every file it cannot use, the same sync and async', async () => {
        const built = await fixture();
        const one = writeTombstone(built.root, { photoId: built.d, assetRevisions: [built.first[built.d]] }, 1);
        writeTombstone(built.root, { photoId: built.c, assetRevisions: [built.first[built.c]], createdAt: '2026-10-03T00:00:00.000Z' }, 2);
        writeRevoke(built.root, one.tombstoneId);
        const dir = tombstonesDir(built.root);
        fs.writeFileSync(path.join(dir, 'notes.txt'), 'not one');
        fs.writeFileSync(path.join(dir, 'tomb_00000000-0000-4000-8000-000000000009.revoked.json'), JSON.stringify({ tombstoneId: 'tomb_00000000-0000-4000-8000-000000000009', actor: 'a', reason: 'r', createdAt: '2026-10-01T00:00:00.000Z' }));
        fs.writeFileSync(path.join(dir, 'tomb_00000000-0000-4000-8000-000000000003.json'), JSON.stringify({ ...one, tombstoneId: 'tomb_00000000-0000-4000-8000-000000000004' }));
        fs.writeFileSync(path.join(dir, '.tomb_00000000-0000-4000-8000-000000000005.json.tmp'), 'a temp file');

        const read = await readTombstones(built.root);
        expect(readTombstonesSync(built.root)).toEqual(read);
        expect(read.tombstones.map((entry) => [entry.tombstoneId, entry.revoked !== null])).toEqual([[one.tombstoneId, true], ['tomb_00000000-0000-4000-8000-000000000002', false]]);
        expect(read.problems.map((problem) => [problem.file, problem.reason])).toEqual([
            ['catalog/tombstones/notes.txt', 'file-name'],
            ['catalog/tombstones/tomb_00000000-0000-4000-8000-000000000003.json', 'invalid'],
            ['catalog/tombstones/tomb_00000000-0000-4000-8000-000000000009.json', 'orphan'],
        ]);
    });

    it("reads a GC marker's paths only in the asset folder shape, and only folders its tombstone lists (N2)", async () => {
        const built = await fixture();
        const one = writeTombstone(built.root, { photoId: built.d, assetRevisions: [built.first[built.d]] }, 1);
        const digest = `gc_${'a'.repeat(64)}`;
        const marker = (paths: unknown[], prefix = digest.slice(3, 19)) => {
            const file = path.join(tombstonesDir(built.root), `${one.tombstoneId}.collected.${prefix}.json`);
            fs.writeFileSync(file, JSON.stringify({ tombstoneId: one.tombstoneId, planDigest: digest, startedAt: '2026-10-09T00:00:00.000Z', paths }));
            return path.relative(built.root, file).split(path.sep).join('/');
        };
        const good = { path: `assets/${built.d}/${built.first[built.d]}`, bytes: 10, newestMs: 1, files: [{ name: `${built.profileId}/manifest.json`, bytes: 300 }, { name: `${built.profileId}/w400.webp`, bytes: 10 }] };
        marker([good]);
        expect((await readTombstones(built.root)).tombstones[0].collected.map((each) => each.paths)).toEqual([[good]]);
        for (const bad of [
            [{ ...good, path: '../../identity' }],
            [{ ...good, path: 'identity/registry' }],
            [{ ...good, path: `assets/${built.d}/${built.first[built.d]}/${built.profileId}` }],
            [{ ...good, path: `assets/${built.c}/${built.first[built.c]}` }],
            [good.path],
            [{ ...good, files: [{ name: '../../identity/registry', bytes: 1 }] }],
            [{ ...good, files: [{ name: `${built.profileId}/w400.webp`, bytes: -1 }] }],
            [],
        ]) {
            const file = marker(bad);
            const read = await readTombstones(built.root);
            expect(read.problems, JSON.stringify(bad)).toEqual([expect.objectContaining({ file, reason: 'invalid' })]);
            expect(readTombstonesSync(built.root)).toEqual(read);
        }
        const misnamed = marker([good], 'b'.repeat(16));
        expect((await readTombstones(built.root)).problems).toContainEqual(expect.objectContaining({ file: misnamed, reason: 'invalid' }));
    });

    it("carries each tombstone file's ctime, the same sync and async", async () => {
        const built = await fixture();
        const one = writeTombstone(built.root, { photoId: built.d, assetRevisions: [built.first[built.d]] }, 1);
        const [entry] = (await readTombstones(built.root)).tombstones;
        expect(entry.ctimeMs).toBe(fs.lstatSync(path.join(tombstonesDir(built.root), `${one.tombstoneId}.json`)).ctimeMs);
        expect(readTombstonesSync(built.root).tombstones[0].ctimeMs).toBe(entry.ctimeMs);
    });

    it('reads a missing folder as no tombstones, and a symlinked one as a problem', async () => {
        const built = await fixture();
        expect(await readTombstones(built.root)).toEqual({ tombstones: [], problems: [] });
        const elsewhere = fs.mkdtempSync(path.join(path.dirname(built.root), 'elsewhere-'));
        fs.symlinkSync(elsewhere, tombstonesDir(built.root));
        expect((await readTombstones(built.root)).problems).toEqual([expect.objectContaining({ file: 'catalog/tombstones', reason: 'not-a-folder' })]);
    });
});

describe("isTombstoned(), /media's index", { timeout: 120_000 }, () => {
    it('sees a purge and a revoke written by another command on the next call, and ignores a revoked tombstone', async () => {
        const built = await fixture();
        let now = Date.now();
        const isTombstoned = createTombstoneIndex({ root: () => built.root, clock: () => now, logger: { warn: () => undefined } });
        const ref = { photoId: built.d, assetRevision: built.first[built.d] };
        expect(await isTombstoned(ref)).toBe(false);
        const id = await purgeD(built);
        expect(await isTombstoned(ref)).toBe(true);
        expect(await isTombstoned({ ...ref, assetRevision: `sha256-${'f'.repeat(64)}` })).toBe(false);
        expect(await isTombstoned({ ...ref, photoId: built.c })).toBe(false);
        // Long after the last change, it answers from what it kept, until the folder changes again.
        now += 60_000;
        expect(await isTombstoned(ref)).toBe(true);
        const revoked = await runRevoke({ dataRoot: built.root, tombstoneId: id, reason: 'x', actor: 'owner', yes: true, logger: quiet });
        expect(revoked.outcome).toBe('REVOKED');
        now = Date.now();
        expect(await isTombstoned(ref)).toBe(false);
    });

    it('passes over a file it cannot read, logging it once, and keeps the rest', async () => {
        const built = await fixture();
        await purgeD(built);
        fs.writeFileSync(path.join(tombstonesDir(built.root), 'tomb_00000000-0000-4000-8000-0000000000aa.json'), '{');
        const warnings: string[] = [];
        const isTombstoned = createTombstoneIndex({ root: () => built.root, logger: { warn: (line: string) => warnings.push(line) } });
        expect(await isTombstoned({ photoId: built.d, assetRevision: built.first[built.d] })).toBe(true);
        expect(await isTombstoned({ photoId: built.d, assetRevision: built.first[built.d] })).toBe(true);
        expect(warnings).toEqual([expect.stringMatching(/^\[media\] Passed over what can't be read in catalog\/tombstones: catalog\/tombstones\/tomb_00000000-0000-4000-8000-0000000000aa\.json: it is not valid JSON\.$/)]);
    });
});

describe('assets.tombstoned', { timeout: 120_000 }, () => {
    it('stops a publish that shows a taken-down asset', async () => {
        const built = await fixture();
        await purgeD(built);
        const put = await runSequenceCommand({ dataRoot: built.root }, { command: 'insert', seriesId: built.seriesId, photoId: built.d, at: 'end' });
        expect(put.exitCode).toBe(0);
        const result = await publish({ dataRoot: built.root, actor: 'test', logger: quiet });
        expect(result.outcome).toBe('VALIDATION_FAILED');
        expect(result.issues).toContainEqual(expect.objectContaining({ code: 'assets.tombstoned', record: { kind: 'photo', id: built.d }, field: 'assetRevision' }));
        expect((await readActivePointer(built.root))?.revisionId).toBe(built.revisions[3]);
    });

    it('stops a rollback to a revision that shows one, and History says why in plain words', async () => {
        const built = await fixture();
        await purgeD(built);
        const plan = await planRollback({ dataRoot: built.root, to: { revisionNumber: 1 } });
        expect(plan.outcome).toBe('VALIDATION_FAILED');
        expect(plan.blocking.map((issue) => issue.code)).toContain('assets.tombstoned');
        expect(blockingReasons(plan.blocking.filter((issue) => issue.code === 'assets.tombstoned'), () => 'Harbour wall')).toEqual(['1 of its photographs was taken down with photos purge: Harbour wall']);
        const result = await rollback({ dataRoot: built.root, revisionId: built.revisions[1], expectedActiveRevisionId: built.revisions[3], actor: 'test', reason: 'x', logger: quiet });
        expect(result.outcome).toBe('VALIDATION_FAILED');
        expect((await readActivePointer(built.root))?.revisionId).toBe(built.revisions[3]);
        // Revision 2 never showed D, so it still can.
        expect((await planRollback({ dataRoot: built.root, to: { revisionNumber: 2 } })).outcome).toBe('READY');
    });

    it('lets the rollback go ahead once the tombstone is revoked', async () => {
        const built = await fixture();
        const id = await purgeD(built);
        await runRevoke({ dataRoot: built.root, tombstoneId: id, reason: 'x', actor: 'owner', yes: true, logger: quiet });
        expect((await planRollback({ dataRoot: built.root, to: { revisionNumber: 1 } })).outcome).toBe('READY');
    });

    it('fails a revision that shows one in photos verify', async () => {
        const built = await fixture();
        await purgeD(built);
        const lines: string[] = [];
        const exitCode = await runVerifyCommand(built.root, { json: false }, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
        // The live revision and the chain pass, so verify exits 0, but revision 1 fails, naming the rule.
        expect(exitCode).toBe(0);
        const text = lines.join('\n');
        expect(text).toContain(built.revisions[1]);
        expect(text).toContain('assets.tombstoned');
    });

    it('says a damaged takedown record in plain words too', () => {
        expect(blockingReasons([{ code: 'assets.tombstoned', record: { kind: 'site', id: 'site' } }], (id) => id)).toEqual(["a takedown record in the data root can't be read, so nobody can tell what it takes down"]);
    });
});
