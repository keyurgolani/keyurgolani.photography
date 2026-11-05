// @vitest-environment node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { folderBytes } from '../../../test/helpers/folderBytes';
import { runTsx, type TsxRun } from '../../../test/helpers/runTsx';
import { readRegistry } from '../../identity/registry';
import { mediaFilePath } from '../../media/path';
import { verifyDirectory } from '../../storage/publish';
import { blockingIssues, publish, validateStored } from '../publish';
import { listActivations, readRevisionFile, revisionFilePath, writeActivation, writeActivePointer } from '../repository';
import { loadActiveCatalog } from '../public-reader';
import { registerRule } from '../rules';
import { createTestCatalog, type TestCatalog } from '../testing';
import type { Activation } from '../types';
import { runVerifyCommand, verifyArgs, writeVerifyRecord, type VerifyArgs } from '../verify-cli';
import { lastKnownGood, MAX_RECORD_BYTES, readVerifyRecord, rollbackReadiness, verifyCatalog, verifyRecordPath, VERIFY_EXIT_CODES, type VerifyOptions } from '../verify';
import { catalogPaths, readActivePointer, readWorkingLayer } from '../working-layer';
import { writeAuthoredRecord } from '../working-layer-writer';
import { rollback } from '../rollback';
import { VARIANT_BYTES } from './catalogFixtures';

/**
 * #117's `photos verify` and lastKnownGood(): every revision file, its
 * rules and its derivative sets' digests, and the pointer chain, read
 * without a lock; the record a full run writes; and the read-only gate the
 * Publish screen's rollback-ready line reads. Test values only.
 */

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    editorialErrorOn = null;
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The revision test.verify-editorial reports an editorial error on while it's set. */
let editorialErrorOn: string | null = null;
registerRule({
    id: 'test.verify-editorial',
    version: 1,
    severity: 'error',
    gate: 'publish',
    rollbackClass: 'editorial',
    check: (ctx) => (editorialErrorOn !== null && ctx.authored === null && ctx.active?.revisionId === editorialErrorOn
        ? [{ record: { kind: 'site', id: 'site' }, field: 'featuredSeriesIds', message: 'A test editorial error.' }]
        : []),
});

const quiet = { log: () => undefined };

interface Two {
    catalog: TestCatalog;
    root: string;
    one: string;
    two: string;
}

/** Revision 1, then revision 2 with one caption changed, so the two share every derivative set. Revision 2 is live. */
async function twoRevisions(seed = 117): Promise<Two> {
    const catalog = await createTestCatalog({ seed, photos: 3, series: 1, variantBytes: VARIANT_BYTES });
    cleanups.push(() => catalog.cleanup());
    const root = catalog.root;
    const first = await publish({ dataRoot: root, actor: 'test', confirmLaunch: true, logger: quiet });
    const photo = (await readWorkingLayer(root)).photos[0];
    await writeAuthoredRecord({ ...photo, caption: 'A caption revision 2 publishes.' }, { expectedVersion: photo.version, root });
    const second = await publish({ dataRoot: root, actor: 'test', logger: quiet });
    if (first.outcome !== 'PUBLISHED' || second.outcome !== 'PUBLISHED') throw new Error(`Publishing ended ${first.outcome} and ${second.outcome}.`);
    return { catalog, root, one: first.revisionId ?? '', two: second.revisionId ?? '' };
}

/** The first photo of `revisionId`, and the path of its w800 WebP. */
async function variantOf(root: string, revisionId: string, index = 0): Promise<{ photoId: string; file: string }> {
    const revision = await readRevisionFile(root, revisionId);
    const photo = revision?.content.photos[index];
    if (!photo) throw new Error(`${revisionId} has no photo ${index}`);
    return { photoId: photo.id, file: mediaFilePath({ photoId: photo.id, assetRevision: photo.assetRevision, profileId: photo.profileId }, 'w800', 'webp', root) };
}

/** Flip the first byte of `file` in place, keeping its size. Flipping it again puts it back. */
function flipByte(file: string): void {
    const fd = fs.openSync(file, 'r+');
    try {
        const byte = Buffer.alloc(1);
        fs.readSync(fd, byte, 0, 1, 0);
        byte[0] ^= 0xff;
        fs.writeSync(fd, byte, 0, 1, 0);
    } finally {
        fs.closeSync(fd);
    }
}

function io(): { out: (line: string) => void; err: (line: string) => void; lines: string[]; errors: string[]; all: () => string } {
    const lines: string[] = [];
    const errors: string[] = [];
    return { lines, errors, out: (line) => lines.push(line), err: (line) => errors.push(line), all: () => [...lines, ...errors].join('\n') };
}

async function run(root: string, args: Partial<VerifyArgs> = {}, options: Partial<VerifyOptions> = {}) {
    const output = io();
    const code = await runVerifyCommand(root, { json: false, ...args }, output, options);
    return { code, ...output };
}

const recordOf = (root: string) => JSON.parse(fs.readFileSync(verifyRecordPath(root), 'utf8')) as Record<string, unknown> & { revisions: { revisionId: string; ok: boolean; problems: string[] }[] };

/** Assert that nothing in `text` names an absolute path: not the data root, not the temp folder. */
function expectNoAbsolutePath(text: string, root: string): void {
    expect(text).not.toContain(root);
    expect(text).not.toContain(fs.realpathSync(root));
    expect(text).not.toContain(os.tmpdir());
    expect(text).not.toMatch(/(?:^|[\s(:'"])\/(?:private|var|tmp|Users|home|data)\//m);
}

describe('photos verify', { timeout: 60_000 }, () => {
    it('passes a clean data root, exits 0, and records the run', async () => {
        const { root, one, two } = await twoRevisions();
        const result = await run(root);
        expect(result.code).toBe(0);
        expect(result.errors).toEqual([]);
        expect(result.lines[0]).toMatch(/^\[photos\] Checked 2 revisions and 3 derivative sets/);
        expect(result.lines.at(-1)).toMatch(/^\[photos\] VERIFIED: /);
        expect(result.lines.join('\n')).toContain(`revision 2, ${two}: LIVE, passes`);
        expect(result.lines.join('\n')).toContain(`revision 1, ${one}: passes. A rollback can return to it.`);

        const record = recordOf(root);
        expect(record).toMatchObject({
            schemaVersion: 1,
            checkedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
            durationMs: expect.any(Number),
            pointer: { revisionId: two, activationId: expect.stringMatching(/^act_/), version: expect.any(Number) },
            chain: { ok: true, problems: [], warnings: [] },
            sets: { checked: 3, failed: 0 },
        });
        expect(record.revisions).toEqual(expect.arrayContaining([
            expect.objectContaining({ revisionId: two, revisionNumber: 2, live: true, eligible: true, ok: true, problems: [], problemCount: 0 }),
            expect.objectContaining({ revisionId: one, revisionNumber: 1, live: false, eligible: true, ok: true, problems: [] }),
        ]));
        // Written atomically: no temp file stays beside it.
        expect(fs.readdirSync(path.dirname(verifyRecordPath(root))).filter((name) => name.startsWith('.'))).toEqual([]);
    });

    it('fails a set whose byte flipped with its size kept, which the rules alone pass: the digest path', async () => {
        const { root, two } = await twoRevisions();
        const { photoId, file } = await variantOf(root, two);
        flipByte(file);
        // The rules check sizes and manifests, not digests, so they see nothing wrong.
        const revision = await readRevisionFile(root, two);
        expect(blockingIssues(validateStored(root, revision!, await readRegistry(root)).issues)).toEqual([]);

        const result = await run(root);
        expect(result.code).toBe(1);
        const text = result.all();
        expect(text).toContain(`revision 2, ${two}: LIVE, FAILS`);
        expect(text).toContain(`${photoId}: w800.webp does not match its sha256`);
        // A set is never rebuilt in place, and photos identity retry requeues failed builds only, so the set comes back from the archive.
        expect(text).toMatch(new RegExp(`Fix: Put assets/${photoId}/sha256-[0-9a-f]{64}/[^/\\s]+/ back from your backup\\. Or roll back to a revision that passes\\.`));
        expect(text).not.toContain('identity retry');
        expect(result.errors.at(-1)).toMatch(/^\[photos\] VERIFY_FAILED: Revision 2, the live one, fails/);
        const record = recordOf(root);
        expect(record.revisions.find((entry) => entry.revisionId === two)).toMatchObject({ ok: false, problems: [expect.stringContaining('does not match its sha256')] });
        expect(record).toMatchObject({ sets: { checked: 3, failed: 1 } });
        expectNoAbsolutePath(text, root);
    });

    it('fails a missing variant', async () => {
        const { root, two } = await twoRevisions();
        const { photoId, file } = await variantOf(root, two, 1);
        fs.rmSync(file);
        const result = await run(root);
        expect(result.code).toBe(1);
        expect(result.all()).toContain(`${photoId}: w800.webp is missing`);
    });

    it('fails a revision file edited in place, since it no longer hashes to its name', async () => {
        const { root, two } = await twoRevisions();
        const file = revisionFilePath(root, two);
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('A caption revision 2 publishes.', 'A caption edited by hand.'));
        const result = await run(root);
        expect(result.code).toBe(1);
        expect(result.all()).toContain(`catalog/revisions/${two}.json doesn't hash to its name`);
        expectNoAbsolutePath(result.all(), root);
    });

    it('fails the chain when the pointer names a record that does not exist', async () => {
        const { root, two } = await twoRevisions();
        const pointer = await readActivePointer(root);
        await writeActivePointer(root, { revisionId: two, activationId: 'act_00000000-0000-4000-8000-000000000000' }, pointer?.version ?? 0);
        const result = await run(root);
        expect(result.code).toBe(1);
        expect(result.all()).toContain('The active pointer names act_00000000-0000-4000-8000-000000000000, which no activation record holds.');
        expect(recordOf(root)).toMatchObject({ chain: { ok: false } });
    });

    it('fails the chain on a dangling previousActivationId', async () => {
        const { root } = await twoRevisions();
        const [, second] = await listActivations(root);
        await writeActivation(root, { ...second, previousActivationId: 'act_00000000-0000-4000-8000-0000000000aa' } as Activation);
        const result = await run(root);
        expect(result.code).toBe(1);
        expect(result.all()).toContain(`#${second.sequence} names act_00000000-0000-4000-8000-0000000000aa as the activation before it, which no record holds.`);
    });

    it('fails committed records with no active pointer, since the site answers 503 then', async () => {
        const { root } = await twoRevisions();
        fs.rmSync(catalogPaths(root).active, { recursive: true });
        const result = await run(root);
        expect(result.code).toBe(1);
        expect(result.all()).toContain('2 activations are committed, but there is no active pointer, so the site serves nothing.');
    });

    it('warns of a pending activation the pointer names, which the next publish records', async () => {
        const { root } = await twoRevisions();
        const activations = await listActivations(root);
        const live = activations.at(-1) as Activation;
        const { committedAt: _committedAt, ...pending } = live;
        void _committedAt;
        await writeActivation(root, { ...pending, status: 'pending' });
        const result = await run(root);
        expect(result.code).toBe(0);
        expect(result.all()).toContain(`The active pointer names #${live.sequence}, which is still pending. The next publish or rollback records it as committed.`);
    });

    it('exits 0 with a warning when only an older revision fails', async () => {
        const { root, one } = await twoRevisions();
        const file = revisionFilePath(root, one);
        fs.writeFileSync(file, `${fs.readFileSync(file, 'utf8').trimEnd()}x`);
        const result = await run(root);
        expect(result.code).toBe(0);
        expect(result.all()).toContain(`revision 1, ${one}: FAILS`);
        expect(result.lines.at(-1)).toMatch(/^\[photos\] VERIFIED: Revision 2 and the activation chain pass\. 1 older revision fails/);
        expect(recordOf(root).revisions.find((entry) => entry.revisionId === one)).toMatchObject({ ok: false });
    });

    it('warns of an editorial error on the live revision, which a rollback can accept', async () => {
        const { root, two } = await twoRevisions();
        editorialErrorOn = two;
        const result = await run(root);
        expect(result.code).toBe(0);
        expect(result.all()).toContain('test.verify-editorial');
        expect(recordOf(root).revisions.find((entry) => entry.revisionId === two)).toMatchObject({ ok: true, warnings: [expect.stringContaining('test.verify-editorial')] });
    });

    it("runs no route rule across a rename, since which revision is live isn't the revision's own fault (#5)", async () => {
        const { root } = await twoRevisions(118);
        const series = (await readWorkingLayer(root)).series[0];
        await writeAuthoredRecord({ ...series, slug: 'fixture-renamed', slugAliases: [series.slug] }, { expectedVersion: series.version, root });
        const third = await publish({ dataRoot: root, actor: 'test', logger: quiet });
        expect(third.outcome).toBe('PUBLISHED');
        // Revisions 1 and 2 drop /work/fixture-renamed against the live revision 3, which a rollback would flag. Verify doesn't.
        const result = await run(root);
        expect(result.code).toBe(0);
        expect(result.all()).not.toContain('route.');
        for (const entry of recordOf(root).revisions) expect(JSON.stringify(entry)).not.toContain('route.');
    });

    it('checks one revision with --revision and writes nothing, so it never replaces a recorded failure', async () => {
        const { root, one, two } = await twoRevisions();
        const { file } = await variantOf(root, two);
        flipByte(file);
        expect((await run(root)).code).toBe(1);
        const recorded = fs.readFileSync(verifyRecordPath(root), 'utf8');
        flipByte(file);

        const single = await run(root, { revisionId: one });
        expect(single.code).toBe(0);
        expect(single.lines[0]).toMatch(/^\[photos\] Checked 1 revision and 3 derivative sets/);
        expect(single.all()).not.toContain(two);
        expect(fs.readFileSync(verifyRecordPath(root), 'utf8')).toBe(recorded);

        const fresh = await twoRevisions(118);
        expect((await run(fresh.root, { revisionId: fresh.two })).code).toBe(0);
        expect(fs.existsSync(verifyRecordPath(fresh.root))).toBe(false);
    });

    it('hashes each set once per run, however many revisions share it', async () => {
        const { root } = await twoRevisions();
        const checked: string[] = [];
        const checkSet: typeof verifyDirectory = async (dir, identity) => {
            checked.push(`${identity.photoId}/${identity.assetRevision}/${identity.profileId}`);
            return verifyDirectory(dir, identity);
        };
        const report = await verifyCatalog({ dataRoot: root, checkSet });
        expect(report.outcome).toBe('VERIFIED');
        expect(checked).toHaveLength(3);
        expect(new Set(checked).size).toBe(3);
    });

    it('exits 3 when the data root is not ready, and 4 when the registry or an activation record cannot be read', async () => {
        const notReady = await twoRevisions();
        fs.rmSync(path.join(notReady.root, 'data-root.json'));
        const three = await run(notReady.root);
        expect(three.code).toBe(3);
        expect(three.errors[0]).toMatch(/^\[photos\] DATA_ROOT_NOT_READY: /);
        expect(fs.existsSync(verifyRecordPath(notReady.root))).toBe(false);

        const registry = await twoRevisions(119);
        const dir = path.join(registry.root, 'identity', 'registry');
        const newest = fs.readdirSync(dir).filter((name) => /^v\d+\.json$/.test(name)).sort((a, b) => Number(b.slice(1, -5)) - Number(a.slice(1, -5)))[0];
        fs.writeFileSync(path.join(dir, newest), '{"not": "a registry"');
        const four = await run(registry.root);
        expect(four.code).toBe(4);
        expect(four.errors.at(-1)).toMatch(/^\[photos\] (?:INTEGRITY_MISMATCH|STORAGE_ERROR): /);
        expectNoAbsolutePath(four.all(), registry.root);

        const records = await twoRevisions(120);
        fs.writeFileSync(path.join(catalogPaths(records.root).activationsDir, '000099-junk.json'), '{}');
        const damaged = await run(records.root);
        expect(damaged.code).toBe(4);
        expect(damaged.errors.at(-1)).toMatch(/^\[photos\] INTEGRITY_MISMATCH: catalog\/activations\/000099-junk\.json/);
        expect(VERIFY_EXIT_CODES).toEqual({ VERIFIED: 0, VERIFY_FAILED: 1, DATA_ROOT_NOT_READY: 3, INTEGRITY_MISMATCH: 4, STORAGE_ERROR: 4 });
    });

    it('fails a damaged pointer with exit 1, as the chain', async () => {
        const { root } = await twoRevisions();
        const dir = catalogPaths(root).active;
        const newest = fs.readdirSync(dir).filter((name) => /^v\d+\.json$/.test(name)).sort().at(-1) as string;
        fs.writeFileSync(path.join(dir, newest), '{');
        const result = await run(root);
        expect(result.code).toBe(1);
        expect(result.all()).toContain("The active pointer can't be read");
        expectNoAbsolutePath(result.all(), root);
    });

    it('refuses a bad --revision or an unknown flag as a usage error', () => {
        expect(verifyArgs([])).toEqual({ json: false });
        expect(verifyArgs(['--json', '--revision', `rev_${'a'.repeat(64)}`])).toEqual({ json: true, revisionId: `rev_${'a'.repeat(64)}` });
        expect(() => verifyArgs(['--revision', '3'])).toThrow('--revision takes a revision ID, rev_ plus 64 hex, not 3.');
        expect(() => verifyArgs(['--deep'])).toThrow();
        expect(() => verifyArgs(['--json', '--json'])).toThrow('--json is given more than once');
    });

    it('prints JSON with --json, and names no absolute path in it, even for a manifest it cannot read', async () => {
        const { root, two } = await twoRevisions();
        const { file } = await variantOf(root, two);
        fs.writeFileSync(path.join(path.dirname(file), 'manifest.json'), '{"photoId": ');
        const result = await run(root, { json: true });
        expect(result.code).toBe(1);
        const printed = JSON.parse([...result.lines, ...result.errors].join('\n')) as Record<string, unknown>;
        expect(printed).toMatchObject({ outcome: 'VERIFY_FAILED', exitCode: 1, recorded: true, record: { schemaVersion: 1, chain: { ok: true } } });
        expectNoAbsolutePath(JSON.stringify(printed), root);
        expectNoAbsolutePath(fs.readFileSync(verifyRecordPath(root), 'utf8'), root);
    });

    it('notes a record it cannot write, and keeps its exit code', async () => {
        const { root } = await twoRevisions();
        // A file where status/ goes: nothing can be written under it, root or not.
        fs.rmSync(path.join(root, 'status'), { recursive: true, force: true });
        fs.writeFileSync(path.join(root, 'status'), '');
        const result = await run(root);
        expect(result.code).toBe(0);
        expect(result.all()).toMatch(/status\/verify\.json couldn't be written \([A-Z]+\)/);
        expectNoAbsolutePath(result.all(), root);
    });

    // Review: verify refuses what /media refuses, so a symlinked file or set folder fails instead of being hashed through its target.
    it('fails a symlinked variant, which /media refuses, even one pointing at the same bytes', async () => {
        const { root, two } = await twoRevisions();
        const { photoId, file } = await variantOf(root, two);
        const elsewhere = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-link-')), 'w800.webp');
        cleanups.push(() => fs.rmSync(path.dirname(elsewhere), { recursive: true, force: true }));
        fs.copyFileSync(file, elsewhere);
        fs.rmSync(file);
        fs.symlinkSync(elsewhere, file);
        const result = await run(root);
        expect(result.code).toBe(1);
        expect(result.all()).toContain(`${photoId}: w800.webp is a symlink, which /media refuses`);
        expectNoAbsolutePath(result.all(), root);
        expect(result.all()).not.toContain(path.dirname(elsewhere));
    });

    it('fails a symlinked set folder without reading or hashing through it', async () => {
        const { root, two } = await twoRevisions();
        const { photoId, file } = await variantOf(root, two);
        const dir = path.dirname(file);
        const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-set-')), 'set');
        cleanups.push(() => fs.rmSync(path.dirname(outside), { recursive: true, force: true }));
        fs.renameSync(dir, outside);
        fs.symlinkSync(outside, dir);
        const checked: string[] = [];
        const checkSet: typeof verifyDirectory = async (folder, identity) => {
            checked.push(identity.photoId);
            return verifyDirectory(folder, identity);
        };
        const report = await verifyCatalog({ dataRoot: root, checkSet });
        expect(report.outcome).toBe('VERIFY_FAILED');
        expect(checked).not.toContain(photoId);
        const live = report.record?.revisions.find((entry) => entry.revisionId === two);
        expect(live?.problems).toContain(`${photoId}: the set's folder is a symlink, or resolves outside assets/, so /media serves none of it`);
        expectNoAbsolutePath(JSON.stringify(report), root);
        expect(JSON.stringify(report)).not.toContain(outside);
    });

    it('restore drill: a copy of the data root in an empty folder verifies, and the public reader serves its live revision', async () => {
        const { root, two } = await twoRevisions();
        const copy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'verify-restore-')), 'data');
        cleanups.push(() => fs.rmSync(path.dirname(copy), { recursive: true, force: true }));
        fs.cpSync(root, copy, { recursive: true });
        const result = await run(copy);
        expect(result.code).toBe(0);
        const served = await loadActiveCatalog(copy);
        expect(served).toMatchObject({ state: 'ok', active: { revisionId: two, revisionNumber: 2 } });
    });

    it('runs as a command: photos verify exits 0 and records, photos verify --json prints JSON, and a bad flag exits 2', async () => {
        const { root } = await twoRevisions(121);
        const photos = (args: string[]): Promise<TsxRun> => runTsx('scripts/photos.ts', args, { env: { PHOTOGRAPHY_DATA_DIR: root } });
        const plain = await photos(['verify']);
        expect(plain.code).toBe(0);
        expect(plain.stdout).toMatch(/\[photos\] VERIFIED: /);
        expect(fs.existsSync(verifyRecordPath(root))).toBe(true);
        const json = await photos(['verify', '--json']);
        expect(json.code).toBe(0);
        expect(JSON.parse(json.stdout)).toMatchObject({ outcome: 'VERIFIED', exitCode: 0 });
        const usage = await photos(['verify', '--revision', 'nope']);
        expect(usage.code).toBe(2);
        expect(usage.stderr).toContain('photos.ts verify [--revision <revisionId>] [--json]');
    }, 120_000);
});

describe('lastKnownGood()', { timeout: 60_000 }, () => {
    it("gives the live revision's number on a clean root that verify never ran on", async () => {
        const { root, two } = await twoRevisions();
        expect(await lastKnownGood(root)).toBe(2);
        expect(await rollbackReadiness(root)).toEqual({ state: 'live-ok', revisionId: two, revisionNumber: 2 });
        expect((await run(root)).code).toBe(0);
        expect(await rollbackReadiness(root)).toEqual({ state: 'verified', revisionId: two, revisionNumber: 2 });
    });

    it('is null when a live variant is gone and nothing is recorded: the live check', async () => {
        const { root, two } = await twoRevisions();
        fs.rmSync((await variantOf(root, two)).file);
        expect(await lastKnownGood(root)).toBeNull();
        expect(await rollbackReadiness(root)).toMatchObject({ state: 'failed', reason: 'live-check', revisionNumber: 2 });
    });

    it('is null when the record failed the live revision, though the live check passes', async () => {
        const { root, two } = await twoRevisions();
        const { file } = await variantOf(root, two);
        flipByte(file);
        expect(await lastKnownGood(root)).toBe(2);
        expect((await run(root)).code).toBe(1);
        expect(await lastKnownGood(root)).toBeNull();
        expect(await rollbackReadiness(root)).toMatchObject({ state: 'failed', reason: 'last-verify', revisionNumber: 2 });
    });

    it('is null after a restore to a revision a verify failed while another one was live', async () => {
        const { root, one, two } = await twoRevisions();
        // Revision 1's file alone breaks, then comes back, as a restore from an archive would put it back byte for byte.
        const file = revisionFilePath(root, one);
        const bytes = fs.readFileSync(file);
        fs.writeFileSync(file, `${bytes.toString('utf8').trimEnd()}x`);
        expect((await run(root)).code).toBe(0);
        fs.writeFileSync(file, bytes);
        const back = await rollback({ dataRoot: root, revisionId: one, expectedActiveRevisionId: two, actor: 'test', reason: 'restore', logger: quiet });
        expect(back.outcome).toBe('ROLLED_BACK');
        expect(await lastKnownGood(root)).toBeNull();
        expect(await rollbackReadiness(root)).toMatchObject({ state: 'failed', reason: 'last-verify', revisionNumber: 1 });
    });

    it('is null for a damaged record', async () => {
        const { root } = await twoRevisions();
        expect((await run(root)).code).toBe(0);
        fs.writeFileSync(verifyRecordPath(root), '{"schemaVersion": 1, "revisions": ');
        expect(await lastKnownGood(root)).toBeNull();
        expect(await rollbackReadiness(root)).toMatchObject({ state: 'failed', reason: 'record-damaged' });
        fs.writeFileSync(verifyRecordPath(root), JSON.stringify({ schemaVersion: 99, revisions: [] }));
        expect((await readVerifyRecord(root)).state).toBe('damaged');
        expect(await lastKnownGood(root)).toBeNull();
    });

    // Review: a record that isn't a small regular file is damaged, and reading it never blocks or reads without bound.
    it('calls a FIFO, a symlink, or an oversized record damaged, without blocking on the FIFO', async () => {
        const { root } = await twoRevisions();
        expect((await run(root)).code).toBe(0);
        const file = verifyRecordPath(root);
        const good = fs.readFileSync(file);

        fs.rmSync(file);
        execFileSync('mkfifo', [file]);
        const started = Date.now();
        expect(await readVerifyRecord(root)).toEqual({ state: 'damaged' });
        expect(Date.now() - started).toBeLessThan(2_000);
        expect(await rollbackReadiness(root)).toMatchObject({ state: 'failed', reason: 'record-damaged' });

        fs.rmSync(file);
        const elsewhere = path.join(path.dirname(root), 'verify-elsewhere.json');
        fs.writeFileSync(elsewhere, good);
        fs.symlinkSync(elsewhere, file);
        expect(await readVerifyRecord(root)).toEqual({ state: 'damaged' });

        fs.rmSync(file);
        const record = JSON.parse(good.toString('utf8')) as Record<string, unknown>;
        fs.writeFileSync(file, JSON.stringify({ ...record, padding: 'x'.repeat(MAX_RECORD_BYTES) }));
        expect(await readVerifyRecord(root)).toEqual({ state: 'damaged' });

        fs.writeFileSync(file, good);
        expect((await readVerifyRecord(root)).state).toBe('ok');
    });

    it('keeps a record with many long problems under the reader\'s cap, so a big catalog never reads as damaged', async () => {
        const { root, two } = await twoRevisions();
        const problems = Array.from({ length: 20 }, (_, index) => `problem ${index} ${'y'.repeat(400)}`);
        const revisions = Array.from({ length: 400 }, () => ({ revisionId: two, revisionNumber: 2, live: false, eligible: true, ok: false, problems, problemCount: 20, warnings: problems, failedSets: [], fix: null }));
        await writeVerifyRecord(root, { schemaVersion: 1, checkedAt: new Date().toISOString(), durationMs: 1, pointer: null, chain: { ok: true, problems: [], warnings: [] }, revisions, sets: { checked: 0, failed: 0 } });
        expect(fs.statSync(verifyRecordPath(root)).size).toBeLessThanOrEqual(MAX_RECORD_BYTES);
        const read = await readVerifyRecord(root);
        expect(read.state).toBe('ok');
        expect(read.state === 'ok' && read.record.revisions.every((entry) => entry.ok === false)).toBe(true);
    });

    it("gives the record the data root's owner when it runs as root, so the curator can read it", async () => {
        const { root } = await twoRevisions();
        const owner = fs.statSync(root);
        const chowned: [string, number, number][] = [];
        const record = { schemaVersion: 1 as const, checkedAt: new Date().toISOString(), durationMs: 1, pointer: null, chain: { ok: true, problems: [], warnings: [] }, revisions: [], sets: { checked: 0, failed: 0 } };
        await writeVerifyRecord(root, record, { uid: 0, chown: async (file, uid, gid) => void chowned.push([path.relative(root, file), uid, gid]) });
        expect(chowned).toEqual([['status', owner.uid, owner.gid], ['status/verify.json', owner.uid, owner.gid]]);
        expect(fs.statSync(verifyRecordPath(root)).mode & 0o777).toBe(0o600);
        const plain: string[] = [];
        await writeVerifyRecord(root, record, { uid: owner.uid, chown: async (file) => void plain.push(file) });
        expect(plain).toEqual([]);
    });

    // Review: a pointer chain that shows nothing went live properly is evidence too, so the warning shows, never just a gap.
    it('fails on the chain when the pointer names a missing or set-aside activation', async () => {
        const { root, two } = await twoRevisions();
        const pointer = await readActivePointer(root);
        await writeActivePointer(root, { revisionId: two, activationId: 'act_00000000-0000-4000-8000-000000000000' }, pointer?.version ?? 0);
        expect(await lastKnownGood(root)).toBeNull();
        expect(await rollbackReadiness(root)).toEqual({ state: 'failed', reason: 'chain', revisionId: two, revisionNumber: 2 });

        const other = await twoRevisions(123);
        const live = (await listActivations(other.root)).at(-1) as Activation;
        await writeActivation(other.root, { ...live, status: 'abandoned' });
        expect(await lastKnownGood(other.root)).toBeNull();
        expect(await rollbackReadiness(other.root)).toMatchObject({ state: 'failed', reason: 'chain', revisionId: other.two });
    });

    it('is null with no pointer', async () => {
        const catalog = await createTestCatalog({ seed: 122, photos: 2, series: 1, variantBytes: VARIANT_BYTES });
        cleanups.push(() => catalog.cleanup());
        expect(await lastKnownGood(catalog.root)).toBeNull();
        expect(await rollbackReadiness(catalog.root)).toEqual({ state: 'none' });
    });

    it('runs on a read-only data root and writes nothing', async () => {
        const { root } = await twoRevisions();
        expect((await run(root)).code).toBe(0);
        const before = folderBytes(root);
        const modes = (dir: string): [string, number][] => fs.readdirSync(dir, { recursive: true, encoding: 'utf8' }).map((name) => [name, fs.statSync(path.join(dir, name)).mode]);
        const saved = modes(root);
        cleanups.push(() => {
            for (const [name, mode] of saved) fs.chmodSync(path.join(root, name), mode);
            fs.chmodSync(root, 0o700);
        });
        for (const [name, mode] of saved) fs.chmodSync(path.join(root, name), mode & ~0o222);
        fs.chmodSync(root, 0o500);
        expect(await lastKnownGood(root)).toBe(2);
        fs.chmodSync(root, 0o700);
        for (const [name, mode] of saved) fs.chmodSync(path.join(root, name), mode);
        expect(folderBytes(root)).toEqual(before);
    });
});
