// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDataRoot } from '../../../test/helpers/tempDataRoot';
import { stagingLockName } from '../../identity/derivatives';
import { versionFile, versionText } from '../../storage/document';
import { withLock } from '../../storage/lock';
import { references } from '../references';
import { CATALOG_LOCK } from '../repository';
import { GC_EXIT_CODES, GC_GRACE_MS, runGc, type GcOptions, type GcResult } from '../retention';
import { gcArgs, runGcCommand } from '../retention-cli';
import { UsageError } from '../owner-cli';
import { revisionIdOf } from '../schema';
import { createTestCatalog, type TestCatalog } from '../testing';
import type { CandidateContent } from '../types';
import { AUTHORED_LOCK } from '../working-layer-writer';
import { catalogPaths } from '../working-layer';

/** The scan's "now", on a whole second, so mtimes set from it compare exactly. */
const NOW = Date.parse('2026-10-20T00:00:00.000Z');
const CUTOFF = NOW - GC_GRACE_MS;
const OLD = CUTOFF - 60_000;
const FRESH = NOW - 60_000;
const clock = () => NOW;

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(): Promise<TestCatalog> {
    const catalog = await createTestCatalog({ seed: 15 });
    cleanups.push(() => catalog.cleanup());
    return catalog;
}

/** A folder outside the data root, for the symlink cases. */
function outsideDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photography-outside-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}

const setTime = (file: string, ms: number) => fs.utimesSync(file, ms / 1000, ms / 1000);

/** `staging/<id>/` as a killed build leaves it: some variants, no manifest, every mtime at `ms`. */
function stage(root: string, id: string, ms: number, files: Record<string, string> = { 'w400.webp': 'partial', 'w800.webp': 'partial too' }): string {
    const dir = path.join(root, 'staging', id);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) {
        fs.writeFileSync(path.join(dir, name), text);
        setTime(path.join(dir, name), ms);
    }
    setTime(dir, ms);
    return dir;
}

/** `content` with photo `index` at another asset revision, so it compiles to another ID. */
function variant(content: CandidateContent, index: number): CandidateContent {
    const copy = structuredClone(content);
    copy.photos[0].assetRevision = `sha256-${index.toString(16).padStart(64, '0')}`;
    return copy;
}

function storedFile(content: CandidateContent, compiledAt: string) {
    return { revisionId: revisionIdOf(content), schemaVersion: 1, baseRevisionId: null, compiledAt, content };
}

/** A candidate compiled at `ms`, its file last written at `mtimeMs`. Returns its ID. */
function candidate(root: string, content: CandidateContent, ms: number, mtimeMs = ms): string {
    const stored = storedFile(content, new Date(ms).toISOString());
    const file = path.join(catalogPaths(root).candidatesDir, `${stored.revisionId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
    setTime(file, mtimeMs);
    return stored.revisionId;
}

function revision(root: string, content: CandidateContent): string {
    const stored = storedFile(content, new Date(OLD).toISOString());
    const file = path.join(catalogPaths(root).revisionsDir, `${stored.revisionId}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`);
    return stored.revisionId;
}

const candidatePath = (id: string) => `catalog/candidates/${id}.json`;

/** Every path under the root, by lstat, with its size and mtime, so a change to anything shows. Leaves out locks/, which every command writes. */
function snapshot(root: string): Map<string, string> {
    const found = new Map<string, string>();
    const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const relative = path.relative(root, full).split(path.sep).join('/');
            if (relative === 'locks') continue;
            const stat = fs.lstatSync(full);
            found.set(relative, entry.isDirectory() ? 'dir' : `${entry.isSymbolicLink() ? 'link' : 'file'} ${stat.size} ${stat.mtimeMs}`);
            if (entry.isDirectory()) walk(full);
        }
    };
    walk(root);
    return found;
}

/** The snapshot without `paths` and everything under them. */
function without(before: Map<string, string>, paths: readonly string[]): Map<string, string> {
    return new Map([...before].filter(([file]) => !paths.some((gone) => file === gone || file.startsWith(`${gone}/`))));
}

function gc(root: string, options: Partial<GcOptions> = {}): Promise<GcResult> {
    return runGc({ dataRoot: root, clock, logger: { log: () => undefined }, waitMs: 200, ...options });
}

async function command(root: string, args: string[], options: Partial<GcOptions> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const exitCode = await runGcCommand(root, gcArgs(args), { out: (line) => out.push(line), err: (line) => err.push(line) }, { clock, logger: { log: () => undefined }, waitMs: 200, ...options });
    return { exitCode, out, err };
}

/** A root with one of each kind GC deletes, one of each it keeps, and a published revision. */
async function mixedRoot() {
    const catalog = await fixture();
    const { root } = catalog;
    const published = revision(root, catalog.content);
    candidate(root, catalog.content, OLD);
    const ids = {
        published,
        orphan: candidate(root, variant(catalog.content, 1), OLD),
        young: candidate(root, variant(catalog.content, 2), FRESH),
    };
    stage(root, 'killed-build', OLD);
    stage(root, 'recent-build', FRESH);
    fs.writeFileSync(path.join(root, 'staging', 'notes.txt'), 'not a build');
    setTime(path.join(root, 'staging', 'notes.txt'), OLD);
    return { catalog, root, ids };
}

describe('photos gc, the dry run', () => {
    it('lists every path it would delete with its class, rule, and size, prints a digest, and deletes nothing', async () => {
        const { root, ids } = await mixedRoot();
        const before = snapshot(root);
        const { exitCode, out, err } = await command(root, []);

        expect({ exitCode, err }).toEqual({ exitCode: 0, err: [] });
        expect(snapshot(root)).toEqual(before);
        expect(out[0]).toBe('[photos] PLANNED: 2 paths can go. Nothing was deleted.');
        expect(out).toContainEqual(expect.stringMatching(new RegExp(`^Delete staging/killed-build: abandoned-staging, 18 bytes\\. gc\\.staging\\.unlocked-past-grace: no build holds its lock, and nothing in it changed since ${new Date(OLD).toISOString()}, more than 7 days ago\\.$`)));
        const size = fs.statSync(path.join(root, candidatePath(ids.orphan))).size;
        expect(out).toContainEqual(`Delete ${candidatePath(ids.orphan)}: orphan-candidate, ${size} bytes. gc.candidate.unpublished-past-grace: no revision, activation, active pointer, or last publish names it, and it was last written ${new Date(OLD).toISOString()}, more than 7 days ago.`);
        const keptCandidates = [`${candidatePath(ids.published)} (a revision of the same ID exists)`, `${candidatePath(ids.young)} (changed within the last 7 days)`].sort();
        expect(out).toContainEqual(`Kept 3: staging/recent-build (changed within the last 7 days), ${keptCandidates.join(', ')}.`);
        expect(out.find((line) => line.startsWith('Plan digest: '))).toMatch(/^Plan digest: gc_[0-9a-f]{64}$/);
        expect(out.at(-1)).toMatch(/^Run photos gc --apply gc_[0-9a-f]{64} to delete exactly these\.$/);
        expect(out.join('\n')).not.toContain('notes.txt');
    });

    it('gives the same digest for the same data root, and says when there is nothing to delete', async () => {
        const { root } = await mixedRoot();
        const first = await gc(root);
        const second = await gc(root);
        expect(second.plan?.digest).toBe(first.plan?.digest);

        const empty = await fixture();
        const { exitCode, out } = await command(empty.root, []);
        expect(exitCode).toBe(0);
        expect(out[0]).toBe('[photos] PLANNED: Nothing is old enough and unreferenced to delete. Nothing was deleted.');
        expect(out.join('\n')).not.toContain('--apply');
    });

    it('keeps a candidate the last publish names', async () => {
        const catalog = await fixture();
        const id = candidate(catalog.root, variant(catalog.content, 3), OLD);
        const summary = { schemaVersion: 1, outcome: 'DRY_RUN_OK', at: new Date(OLD).toISOString(), actor: 'test', candidateId: id, revisionId: null, revisionNumber: null, errors: 0, warnings: 0, message: 'ok' };
        fs.mkdirSync(catalogPaths(catalog.root).diagnosticsDir, { recursive: true });
        fs.writeFileSync(path.join(catalogPaths(catalog.root).diagnosticsDir, 'last-publish.json'), JSON.stringify(summary));
        const result = await gc(catalog.root);
        expect(result.plan?.delete).toEqual([]);
        expect(result.plan?.kept).toEqual([{ class: 'orphan-candidate', path: candidatePath(id), reason: 'named-by-last-publish' }]);
    });
});

describe('photos gc --apply', () => {
    it('deletes exactly the plan, logs each path, and leaves everything else', async () => {
        const { root, ids } = await mixedRoot();
        const planned = await gc(root);
        const before = snapshot(root);
        const events: Record<string, unknown>[] = [];
        const result = await gc(root, { apply: planned.plan?.digest, logger: { log: (line) => events.push(JSON.parse(line) as Record<string, unknown>) } });

        expect(result).toMatchObject({ outcome: 'APPLIED', message: 'Deleted 2 paths.', deleted: ['staging/killed-build', candidatePath(ids.orphan)] });
        expect(snapshot(root)).toEqual(without(before, result.deleted));
        expect(events.filter((event) => event.event === 'catalog.gc.deleted').map((event) => event.path)).toEqual(result.deleted);
        expect(events.at(-1)).toMatchObject({ event: 'catalog.gc.applied', deleted: 2 });
    });

    it('deletes nothing for an empty plan', async () => {
        const catalog = await fixture();
        const planned = await gc(catalog.root);
        const { exitCode, out } = await command(catalog.root, ['--apply', planned.plan?.digest ?? '']);
        expect(exitCode).toBe(0);
        expect(out).toEqual(['[photos] APPLIED: The plan was empty, so nothing was deleted.']);
    });

    describe('stops, deleting nothing, when the plan drifted since the dry run', () => {
        it.each([
            ['a path was added', (root: string) => {
                setTime(path.join(root, 'staging', 'recent-build', 'w400.webp'), OLD);
                setTime(path.join(root, 'staging', 'recent-build', 'w800.webp'), OLD);
                setTime(path.join(root, 'staging', 'recent-build'), OLD);
            }],
            ['a path was removed', (root: string) => fs.rmSync(path.join(root, 'staging', 'killed-build'), { recursive: true })],
            ['a path changed', (root: string) => fs.writeFileSync(path.join(root, 'staging', 'killed-build', 'w400.webp'), 'more partial bytes')],
        ])('%s', async (_label, drift) => {
            const { root } = await mixedRoot();
            const planned = await gc(root);
            drift(root);
            const before = snapshot(root);
            const { exitCode, err } = await command(root, ['--apply', planned.plan?.digest ?? '']);

            expect(exitCode).toBe(GC_EXIT_CODES.PLAN_CHANGED);
            expect(err[0]).toMatch(/^\[photos\] PLAN_CHANGED: The plan is gc_[0-9a-f]{64} now, not gc_[0-9a-f]{64}: .* Nothing was deleted\./);
            expect(err.find((line) => line.startsWith('Plan digest: '))).not.toBe(`Plan digest: ${planned.plan?.digest}`);
            expect(snapshot(root)).toEqual(before);
        });

        it('a candidate became protected: its revision was published', async () => {
            const { root, catalog, ids } = await mixedRoot();
            const planned = await gc(root);
            expect(planned.plan?.delete.map((entry) => entry.path)).toContain(candidatePath(ids.orphan));
            revision(root, variant(catalog.content, 1));
            const before = snapshot(root);
            const { exitCode, err } = await command(root, ['--apply', planned.plan?.digest ?? '']);

            expect(exitCode).toBe(3);
            expect(err).toContainEqual(expect.stringContaining(`${candidatePath(ids.orphan)} (a revision of the same ID exists)`));
            expect(snapshot(root)).toEqual(before);
        });
    });

    it('stops at a path that changes after the plan, keeping it and everything after it', async () => {
        const { root, ids } = await mixedRoot();
        const planned = await gc(root);
        const result = await gc(root, {
            apply: planned.plan?.digest,
            hooks: {
                beforeDelete(entry) {
                    if (entry.class === 'orphan-candidate') setTime(path.join(root, entry.path), FRESH);
                },
            },
        });
        expect(result.outcome).toBe('PLAN_CHANGED');
        expect(result.message).toBe(`${candidatePath(ids.orphan)} changed since the plan. GC stopped there. It had deleted 1 of the plan's 2 paths, and deleted nothing else. Run the dry run again.`);
        expect(result.deleted).toEqual(['staging/killed-build']);
        expect(fs.existsSync(path.join(root, candidatePath(ids.orphan)))).toBe(true);
    });

    it('refuses a digest that is not one', () => {
        expect(() => gcArgs(['--apply', 'gc_123'])).toThrow(UsageError);
        expect(() => gcArgs(['--apply'])).toThrow();
        expect(() => gcArgs(['--apply', `gc_${'a'.repeat(64)}`, '--apply', `gc_${'b'.repeat(64)}`])).toThrow(UsageError);
        expect(gcArgs([])).toEqual({});
    });
});

describe('photos gc and staging', () => {
    it("skips a folder whose build holds its lock, in the plan and at the delete, and takes it once the lock is free", async () => {
        const catalog = await fixture();
        const { root } = catalog;
        stage(root, 'live-build', OLD);

        const whileHeld = await withLock(stagingLockName('live-build'), { root }, () => gc(root));
        expect(whileHeld.plan?.delete).toEqual([]);
        expect(whileHeld.plan?.kept).toEqual([{ class: 'abandoned-staging', path: 'staging/live-build', reason: 'build-lock-held' }]);

        const planned = await gc(root);
        expect(planned.plan?.delete.map((entry) => entry.path)).toEqual(['staging/live-build']);

        // A build takes the lock again between the plan and the delete.
        let release = () => undefined as void;
        let holding: Promise<void> | null = null;
        const result = await gc(root, {
            apply: planned.plan?.digest,
            hooks: {
                async beforeDelete() {
                    await new Promise<void>((taken) => {
                        holding = withLock(stagingLockName('live-build'), { root }, () => new Promise<void>((done) => {
                            release = done;
                            taken();
                        }));
                    });
                },
            },
        });
        release();
        await holding;
        expect(result).toMatchObject({ outcome: 'PLAN_CHANGED', deleted: [] });
        expect(result.message).toMatch(/^A build holds build-live-build now\. GC stopped there\. Nothing was deleted\./);
        expect(fs.existsSync(path.join(root, 'staging', 'live-build'))).toBe(true);

        const applied = await gc(root, { apply: planned.plan?.digest });
        expect(applied).toMatchObject({ outcome: 'APPLIED', deleted: ['staging/live-build'] });
    });

    it('counts the newest change anywhere in the folder', async () => {
        const catalog = await fixture();
        const dir = stage(catalog.root, 'still-writing', OLD);
        fs.mkdirSync(path.join(dir, 'nested'));
        fs.writeFileSync(path.join(dir, 'nested', 'late.webp'), 'x');
        setTime(path.join(dir, 'nested'), OLD);
        setTime(dir, OLD);
        const result = await gc(catalog.root);
        expect(result.plan?.kept).toEqual([{ class: 'abandoned-staging', path: 'staging/still-writing', reason: 'within-grace' }]);
    });
});

describe('photos gc and the 7-day grace period', () => {
    it('keeps a path changed exactly 7 days ago and deletes one changed a millisecond before', async () => {
        const catalog = await fixture();
        const { root } = catalog;
        stage(root, 'exactly-seven-days', CUTOFF);
        stage(root, 'just-past', CUTOFF - 1);
        const atCutoff = candidate(root, variant(catalog.content, 4), CUTOFF);
        const justPast = candidate(root, variant(catalog.content, 5), CUTOFF - 1);

        const result = await gc(root);
        expect(result.plan?.cutoff).toBe(new Date(CUTOFF).toISOString());
        expect(result.plan?.delete.map((entry) => entry.path).sort()).toEqual([candidatePath(justPast), 'staging/just-past'].sort());
        expect(result.plan?.kept.map((kept) => [kept.path, kept.reason]).sort()).toEqual([[candidatePath(atCutoff), 'within-grace'], ['staging/exactly-seven-days', 'within-grace']].sort());
    });

    it("keeps a candidate whose file is old but whose compiledAt isn't", async () => {
        const catalog = await fixture();
        const id = candidate(catalog.root, variant(catalog.content, 6), FRESH, OLD);
        const result = await gc(catalog.root);
        expect(result.plan?.kept).toEqual([{ class: 'orphan-candidate', path: candidatePath(id), reason: 'within-grace' }]);
    });
});

describe('what photos gc never deletes', () => {
    it('keeps every asset a revision, a candidate, or the working layer references', async () => {
        const { root, catalog, ids } = await mixedRoot();
        // The active revision, and a second published one, besides the candidates mixedRoot wrote.
        fs.mkdirSync(catalogPaths(root).active, { recursive: true });
        fs.writeFileSync(versionFile(catalogPaths(root).active, 1), versionText({ schemaVersion: 1, revisionId: ids.published, activationId: 'act_00000000-0000-4000-8000-000000000001' }, 1));
        revision(root, variant(catalog.content, 7));

        const before = await references(root);
        expect(new Set(before.map((reference) => reference.source))).toEqual(new Set(['active-revision', 'revision', 'candidate', 'working-layer-series', 'working-layer-photo']));
        for (const reference of before) {
            const dir = path.join(root, 'assets', reference.photoId, reference.assetRevision ?? 'any', reference.profileId ?? catalog.profileId);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(path.join(dir, 'manifest.json'), '{}');
            setTime(path.join(dir, 'manifest.json'), OLD);
        }
        const assets = [...snapshot(root)].filter(([file]) => file.startsWith('assets/'));

        const planned = await gc(root);
        expect(planned.plan?.references).toBe(before.length);
        const result = await gc(root, { apply: planned.plan?.digest });
        expect(result.deleted).toEqual(['staging/killed-build', candidatePath(ids.orphan)]);
        expect([...snapshot(root)].filter(([file]) => file.startsWith('assets/'))).toEqual(assets);
        // Only the deleted candidate's own references are gone. Its assets stay.
        const after = await references(root);
        expect(after).toEqual(before.filter((reference) => !(reference.source === 'candidate' && reference.holder === ids.orphan)));
    });

    it('leaves edits/ alone, whatever it holds', async () => {
        const { root, catalog } = await mixedRoot();
        const edits = path.join(root, 'edits');
        fs.mkdirSync(edits, { mode: 0o700 });
        fs.writeFileSync(path.join(edits, `${revisionIdOf(variant(catalog.content, 8))}.json`), '{}', { mode: 0o600 });
        fs.writeFileSync(path.join(edits, 'ph_kept-edit.json'), '{"alt":"kept"}', { mode: 0o600 });
        setTime(path.join(edits, 'ph_kept-edit.json'), OLD);
        stage(edits, 'old-build', OLD);
        setTime(path.join(edits, 'staging'), OLD);
        setTime(edits, OLD);
        const before = [...snapshot(root)].filter(([file]) => file.startsWith('edits'));

        const planned = await gc(root);
        expect([...planned.plan?.delete ?? [], ...planned.plan?.kept ?? []].filter((entry) => entry.path.startsWith('edits'))).toEqual([]);
        await gc(root, { apply: planned.plan?.digest });
        expect([...snapshot(root)].filter(([file]) => file.startsWith('edits'))).toEqual(before);
        expect(fs.statSync(edits).mode & 0o777).toBe(0o700);
    });

    it('deletes a symlink inside a staging folder, never what it points to', async () => {
        const catalog = await fixture();
        const outside = outsideDir();
        fs.writeFileSync(path.join(outside, 'precious.jpg'), 'outside the data root');
        const dir = stage(catalog.root, 'with-links', OLD);
        fs.symlinkSync(outside, path.join(dir, 'to-folder'));
        fs.symlinkSync(path.join(outside, 'precious.jpg'), path.join(dir, 'to-file'));
        for (const link of ['to-folder', 'to-file']) fs.lutimesSync(path.join(dir, link), OLD / 1000, OLD / 1000);
        setTime(dir, OLD);

        const planned = await gc(catalog.root);
        expect(planned.plan?.delete.map((entry) => entry.path)).toEqual(['staging/with-links']);
        const result = await gc(catalog.root, { apply: planned.plan?.digest });
        expect(result.outcome).toBe('APPLIED');
        expect(fs.existsSync(dir)).toBe(false);
        expect(fs.readFileSync(path.join(outside, 'precious.jpg'), 'utf8')).toBe('outside the data root');
    });

    it('keeps a staging entry or a candidate that is a symlink, and what it points to', async () => {
        const catalog = await fixture();
        const outside = outsideDir();
        stage(outside, 'folder', OLD);
        fs.mkdirSync(path.join(catalog.root, 'staging'));
        fs.symlinkSync(path.join(outside, 'staging', 'folder'), path.join(catalog.root, 'staging', 'linked-build'));
        const content = variant(catalog.content, 9);
        const stored = storedFile(content, new Date(OLD).toISOString());
        const outsideFile = path.join(outside, `${stored.revisionId}.json`);
        fs.writeFileSync(outsideFile, JSON.stringify(stored));
        setTime(outsideFile, OLD);
        fs.mkdirSync(catalogPaths(catalog.root).candidatesDir, { recursive: true });
        fs.symlinkSync(outsideFile, path.join(catalogPaths(catalog.root).candidatesDir, `${stored.revisionId}.json`));

        const planned = await gc(catalog.root);
        expect(planned.plan?.delete).toEqual([]);
        expect(planned.plan?.kept).toEqual([
            { class: 'abandoned-staging', path: 'staging/linked-build', reason: 'not-a-folder' },
            { class: 'orphan-candidate', path: candidatePath(stored.revisionId), reason: 'not-a-regular-file' },
        ]);
        expect(fs.existsSync(path.join(outside, 'staging', 'folder', 'w400.webp'))).toBe(true);
        expect(fs.existsSync(outsideFile)).toBe(true);
    });

    it.each([
        ['staging', (root: string, outside: string) => {
            stage(outside, 'old-build', OLD);
            fs.symlinkSync(path.join(outside, 'staging'), path.join(root, 'staging'));
            return path.join(outside, 'staging', 'old-build', 'w400.webp');
        }],
        ['catalog/candidates', (root: string, outside: string, catalog: TestCatalog) => {
            const id = candidate(outside, variant(catalog.content, 10), OLD);
            fs.mkdirSync(path.join(root, 'catalog'), { recursive: true });
            fs.symlinkSync(path.join(outside, 'catalog', 'candidates'), path.join(root, 'catalog', 'candidates'));
            return path.join(outside, 'catalog', 'candidates', `${id}.json`);
        }],
    ])('refuses to run when %s is a symlink out of the data root', async (folder, link) => {
        const catalog = await fixture();
        const outside = outsideDir();
        const victim = link(catalog.root, outside, catalog);
        const { exitCode, err } = await command(catalog.root, []);
        expect(exitCode).toBe(GC_EXIT_CODES.UNSAFE_PATH);
        expect(err[0]).toBe(`[photos] UNSAFE_PATH: ${folder} is a symlink, so GC can't be sure what it would delete. Nothing was deleted.`);
        expect(fs.existsSync(victim)).toBe(true);
    });
});

describe('photos gc fails closed', () => {
    it('stops on a candidate references() cannot read, deleting nothing', async () => {
        const { root } = await mixedRoot();
        const broken = path.join(catalogPaths(root).candidatesDir, `rev_${'e'.repeat(64)}.json`);
        fs.writeFileSync(broken, '{"revisionId":');
        setTime(broken, OLD);
        const before = snapshot(root);
        const { exitCode, err } = await command(root, []);
        expect(exitCode).toBe(GC_EXIT_CODES.INTEGRITY_MISMATCH);
        expect(err[0]).toMatch(/^\[photos\] INTEGRITY_MISMATCH: Can't tell what catalog\/candidates\/rev_e{64}\.json references: the file is not valid JSON\. Nothing was deleted\.$/);
        expect(snapshot(root)).toEqual(before);
    });

    it('stops when the data root is not ready', async () => {
        const data = createTempDataRoot({ state: 'uninitialized' });
        cleanups.push(() => data.cleanup());
        stage(data.root, 'killed-build', OLD);
        const { exitCode, err } = await command(data.root, []);
        expect(exitCode).toBe(3);
        expect(err[0]).toMatch(/^\[photos\] DATA_ROOT_NOT_READY: The data root is uninitialized/);
        expect(fs.existsSync(path.join(data.root, 'staging', 'killed-build'))).toBe(true);
    });

    it.each([[CATALOG_LOCK, 'CATALOG_LOCKED'], [AUTHORED_LOCK, 'AUTHORED_LOCKED']] as const)('waits for the %s lock, then names its holder', async (lock, outcome) => {
        const { root } = await mixedRoot();
        const planned = await gc(root);
        const before = snapshot(root);
        const result = await withLock(lock, { root }, () => gc(root, { apply: planned.plan?.digest, waitMs: 50 }));
        expect(result.outcome).toBe(outcome);
        expect(result.message).toMatch(new RegExp(`^Another command holds the ${lock} lock: [0-9a-f-]+ \\(pid \\d+ on .+, since .+\\)\\. Nothing was deleted\\.$`));
        expect(snapshot(root)).toEqual(before);
    });
});
