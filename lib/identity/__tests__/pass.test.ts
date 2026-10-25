// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fixtureFiles, withExifOrientation } from '../../../test/fixtures/makeLibrary';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { EditedInPlaceError, StaleVersionError } from '../../storage/document';
import { withLock } from '../../storage/lock';
import { PHOTO_ID_RE, sha256, type Hasher } from '../ids';
import { inspectEntry } from '../inspect';
import type { DecisionFile, IdentityDecision } from '../decisions';
import { jsonLogSink, replayDecisions, runReconcilePass, type PassOptions, type PassOutcome } from '../pass';
import { identityPaths, readRegistry, writeRegistry } from '../registry';
import { scanLibrary } from '../scan';
import { identityStatus } from '../status';
import type { IdentityFact, RecordedDecision, Registry } from '../types';
import { sequentialIds } from './reconcileFixtures';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const isRoot = process.getuid?.() === 0;

let fixtures: Map<string, Buffer>;
let lib: TempLibrary;
let data: TempDataRoot;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    fixtures = await fixtureFiles({ extras: true });
});

afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function setup({ files = ['landscape.jpg', 'portrait.png', 'square.webp'], state = 'ready' as const }: { files?: string[]; state?: 'ready' | 'uninitialized' | 'missing' } = {}) {
    lib = await createTempLibrary();
    cleanups.push(() => lib.cleanup());
    data = createTempDataRoot({ state });
    cleanups.push(() => data.cleanup());
    for (const name of files) put(name, name);
}

function put(target: string, fixtureName: string): void {
    const bytes = fixtures.get(fixtureName);
    if (!bytes) throw new Error(`No fixture ${fixtureName}`);
    fs.mkdirSync(lib.file(target, '..'), { recursive: true });
    fs.writeFileSync(lib.file(target), bytes);
}

/** A recording sink, and the deterministic clock and IDs every pass here uses. */
function harness() {
    const seen: IdentityFact[][] = [];
    const ids = sequentialIds();
    const options = (extra: PassOptions = {}): PassOptions => ({
        // Files written just now would be too fresh to read, so the pass runs a minute later.
        clock: () => Date.now() + 60_000,
        idGen: ids,
        logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
        sinks: [(facts) => { seen.push([...facts]); }],
        ...extra,
    });
    return { seen, options };
}

function committed(outcome: PassOutcome) {
    if (outcome.status !== 'committed') throw new Error(`Expected a committed pass, got ${JSON.stringify(outcome)}`);
    return outcome;
}

describe('runReconcilePass', () => {
    it.each(['missing', 'uninitialized'] as const)('does nothing against a %s data root', async (state) => {
        await setup({ state });
        const { seen, options } = harness();
        const outcome = await runReconcilePass(options());
        expect(outcome).toMatchObject({ status: 'skipped', reason: 'data-root', state: state === 'missing' ? 'unavailable' : 'uninitialized' });
        expect(data.files()).toEqual([]);
        expect(fs.existsSync(data.root)).toBe(state !== 'missing');
        expect(seen).toEqual([]);
    });

    it('does nothing when PHOTOGRAPHY_DATA_DIR is unset in production', async () => {
        await setup();
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        vi.stubEnv('NODE_ENV', 'production');
        expect(await runReconcilePass(harness().options())).toMatchObject({ status: 'skipped', state: 'unset' });
    });

    it.skipIf(isRoot)('does nothing against an unwritable data root', async () => {
        await setup();
        fs.chmodSync(data.root, 0o555);
        expect(await runReconcilePass(harness().options())).toMatchObject({ status: 'skipped', state: 'unwritable' });
    });

    it("does nothing, and writes nothing, against a data root whose filesystem can't hold hard links", async () => {
        await setup();
        // As on exFAT, where every link() fails
        const unsupported = (): never => {
            throw Object.assign(new Error('ENOTSUP: operation not supported, link'), { code: 'ENOTSUP' });
        };
        vi.spyOn(fs, 'linkSync').mockImplementation(unsupported);
        vi.spyOn(fs.promises, 'link').mockImplementation(async () => unsupported());
        const { seen, options } = harness();
        expect(await runReconcilePass(options())).toMatchObject({
            status: 'skipped',
            reason: 'data-root',
            state: 'unwritable',
            detail: expect.stringContaining("can't hold hard links"),
        });
        expect(data.files()).toEqual(['data-root.json']);
        expect(seen).toEqual([]);
    });

    it('does nothing and writes nothing when the registry comes from a newer build', async () => {
        await setup();
        const newest = path.join(identityPaths(data.root).registry, 'v9.json');
        fs.mkdirSync(identityPaths(data.root).registry, { recursive: true });
        fs.writeFileSync(newest, JSON.stringify({ schemaVersion: 2, version: 9 }));
        const before = fs.readFileSync(newest);
        const outcome = await runReconcilePass(harness().options());
        expect(outcome).toMatchObject({ status: 'skipped', reason: 'data-root', state: 'unavailable' });
        expect(fs.readFileSync(newest).equals(before)).toBe(true);
        expect(data.files()).toEqual(['data-root.json', 'identity/registry/v9.json']);
    });

    it('refuses a registry edited in place, writes nothing, and takes the copy the refusal names as the next version', async () => {
        await setup();
        const { options } = harness();
        committed(await runReconcilePass(options()));
        const dir = identityPaths(data.root).registry;
        const file = path.join(dir, 'v1.json');
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"updatedAt": "', '"updatedAt": "edited '));

        const refused = await runReconcilePass(options()).catch((caught: unknown) => caught);
        expect(refused).toBeInstanceOf(EditedInPlaceError);
        expect((refused as Error).message).toContain('cp -n v1.json v2.json');
        expect((await identityStatus()).registryError).toContain('edited in place');
        expect(fs.readdirSync(dir)).toEqual(['v1.json']);

        // The documented hand edit: the edited file, copied to the next number, is a hand-made version 2.
        fs.copyFileSync(file, path.join(dir, 'v2.json'), fs.constants.COPYFILE_EXCL);
        expect((await readRegistry(data.root)).version).toBe(2);
        const pass = committed(await runReconcilePass(options()));
        expect(pass.registry.version).toBe(3);
        expect(JSON.parse(fs.readFileSync(path.join(dir, 'v3.json'), 'utf8'))).toMatchObject({ stamp: { version: 3 } });
        expect((await identityStatus()).registryError).toBeUndefined();
    });

    it('skips, without waiting, when another holder has the registry lock and the pass asks for waitMs 0', async () => {
        await setup();
        const outcome = await withLock('registry', { root: data.root }, () => runReconcilePass(harness().options({ lock: { waitMs: 0 } })));
        expect(outcome).toMatchObject({ status: 'skipped', reason: 'locked', holder: { pid: process.pid } });
        expect(fs.existsSync(identityPaths(data.root).registry)).toBe(false);
    });

    it('commits new photos, delivers their facts, and with clearDelivered leaves nothing pending', async () => {
        await setup();
        const { seen, options } = harness();
        const pass = committed(await runReconcilePass(options({ clearDelivered: true })));

        expect(pass.facts.map((fact) => `${fact.type} ${fact.path}`)).toEqual(['new landscape.jpg', 'new portrait.png', 'new square.webp']);
        for (const fact of pass.facts) expect(fact.factId).toMatch(UUID);
        expect(seen).toEqual([pass.facts]);
        expect(pass.jobs).toHaveLength(3);
        const registry = await readRegistry(data.root);
        expect(registry.version).toBe(2);
        expect(registry.pendingFacts).toEqual([]);
        expect(Object.keys(registry.photos).every((id) => PHOTO_ID_RE.test(id))).toBe(true);
        // Committed twice, as versions 1 and 2: the second pass cleared what the first delivered.
        expect(data.files()).toEqual(['data-root.json', 'identity/registry/v1.json', 'identity/registry/v2.json', 'identity/stat-cache.json']);
        const landscape = Object.values(registry.photos).find((photo) => photo.source.path === 'landscape.jpg');
        expect(landscape?.revisions[landscape.source.observedRevision]).toMatchObject({ width: 960, height: 640, sourceFormat: 'jpeg', orientation: null });

        // The registry and stat cache hold curator-only metadata, so only their owner can read them.
        const mode = (file: string) => fs.statSync(file).mode & 0o777;
        const paths = identityPaths(data.root);
        expect([mode(paths.dir), mode(paths.registry), mode(path.join(paths.registry, 'v2.json')), mode(paths.statCache), mode(data.file('locks'))])
            .toEqual([0o700, 0o700, 0o600, 0o600, 0o700]);
    });

    it('re-delivers facts committed before a crash, leftovers first, so each factId is seen once', async () => {
        await setup();
        const { seen, options } = harness();
        await expect(runReconcilePass(options({ clearDelivered: true, faults: { beforeDelivery() { throw new Error('crash before delivery'); } } })))
            .rejects.toThrow('crash before delivery');
        expect(seen).toEqual([]);
        const pending = (await readRegistry(data.root)).pendingFacts;
        expect(pending).toHaveLength(3);

        put('extra.jpg', 'landscape-edited.jpg');
        const second = committed(await runReconcilePass(options({ clearDelivered: true })));
        expect(second.delivered.map((fact) => fact.factId)).toEqual([...pending.map((fact) => fact.factId), second.facts[0].factId]);
        expect(second.facts.map((fact) => fact.path)).toEqual(['extra.jpg']);

        committed(await runReconcilePass(options({ clearDelivered: true })));
        const delivered = seen.flat().map((fact) => fact.factId);
        expect(delivered).toHaveLength(4);
        expect(new Set(delivered).size).toBe(4);
        expect((await readRegistry(data.root)).pendingFacts).toEqual([]);
    });

    it('leaves delivered facts pending without clearDelivered, as CLI passes do, for the watcher to deliver', async () => {
        await setup();
        const lines: string[] = [];
        const { options } = harness();
        const cli = committed(await runReconcilePass(options({ sinks: [jsonLogSink({ log: (line: string) => lines.push(line) })] })));
        expect(lines.map((line) => JSON.parse(line))).toEqual(cli.facts.map((fact) => ({ event: 'identity-fact', ...fact })));
        expect((await readRegistry(data.root)).pendingFacts).toEqual(cli.facts);

        const watcher = committed(await runReconcilePass(options({ clearDelivered: true })));
        expect(watcher.delivered).toEqual(cli.facts);
        expect((await readRegistry(data.root)).pendingFacts).toEqual([]);
    });

    it('keeps facts pending when a sink fails', async () => {
        await setup();
        const { options } = harness();
        committed(await runReconcilePass(options({ clearDelivered: true, sinks: [() => { throw new Error('ledger offline'); }] })));
        expect((await readRegistry(data.root)).pendingFacts).toHaveLength(3);
    });

    it('fails a registry write whose version went stale and leaves the newer registry alone', async () => {
        await setup();
        const { seen, options } = harness();
        committed(await runReconcilePass(options({ clearDelivered: true })));
        let foreign: Registry | undefined;
        put('extra.jpg', 'landscape-edited.jpg');
        // A writer that lost the lock, or never took it, commits the next version between this pass's read and its write.
        const beforeRegistryWrite = async () => {
            const current = await readRegistry(data.root);
            foreign = await writeRegistry(data.root, { ...current, updatedAt: '2030-01-01T00:00:00.000Z' }, current.version);
        };
        await expect(runReconcilePass(options({ faults: { beforeRegistryWrite } }))).rejects.toBeInstanceOf(StaleVersionError);
        expect(await readRegistry(data.root)).toEqual(foreign);
        expect(seen).toHaveLength(1);
    });

    it('reads only changed files, and reports an unsupported file once per version', async () => {
        await setup();
        fs.writeFileSync(lib.file('raw.heic'), 'not really heic');
        let reads = 0;
        const counting: Hasher = (chunks) => {
            if (chunks.length === 1) reads++;
            return sha256(chunks);
        };
        const { options } = harness();
        const first = committed(await runReconcilePass(options({ hasher: counting })));
        expect(reads).toBe(4);
        expect(first.facts.filter((fact) => fact.type === 'processing-failed')).toMatchObject([{ path: 'raw.heic', reason: 'unsupported-format', photoId: null }]);

        reads = 0;
        const second = committed(await runReconcilePass(options({ hasher: counting })));
        expect(reads).toBe(0);
        expect(second.facts).toEqual([]);

        fs.writeFileSync(lib.file('raw.heic'), 'a new version of the raw file');
        const third = committed(await runReconcilePass(options({ hasher: counting })));
        expect(reads).toBe(1);
        expect(third.facts).toMatchObject([{ type: 'processing-failed', path: 'raw.heic' }]);
    });

    it.each([
        ['a crash between the registry and stat cache writes', 'crash'],
        ['a stat cache that cannot be written', 'unwritable'],
    ] as const)('gives an unsupported-file report repeated after %s the same factId, so sinks see one', async (_label, loss) => {
        await setup({ files: ['landscape.jpg'] });
        fs.writeFileSync(lib.file('raw.heic'), 'not really heic');
        const { seen, options } = harness();
        if (loss === 'crash') {
            const crash = { registryWrite: { afterLink() { throw new Error('crash after the registry write'); } } };
            await expect(runReconcilePass(options({ clearDelivered: true, faults: crash }))).rejects.toThrow('crash after the registry write');
        } else {
            fs.mkdirSync(identityPaths(data.root).statCache, { recursive: true });
            committed(await runReconcilePass(options({ clearDelivered: true })));
        }

        // The stat cache never recorded the report, so this pass makes it again.
        const second = committed(await runReconcilePass(options({ clearDelivered: true })));
        expect(second.facts.filter((fact) => fact.reason === 'unsupported-format')).toHaveLength(1);

        const reports = seen.flat().filter((fact) => fact.reason === 'unsupported-format');
        expect(new Set(reports.map((fact) => fact.factId)).size).toBe(1);
        if (loss === 'crash') expect(reports).toHaveLength(1);
        expect((await readRegistry(data.root)).pendingFacts).toEqual([]);
    });

    it('gives a digest-collision report repeated after a crash the same factId', async () => {
        await setup({ files: ['landscape.jpg'] });
        const real = (name: string) => sha256([fixtures.get(name) as Buffer]);
        const colliding: Hasher = (chunks) => {
            const digest = sha256(chunks);
            return chunks.length === 1 && digest === real('portrait.png') ? real('landscape.jpg') : digest;
        };
        const { seen, options } = harness();
        committed(await runReconcilePass(options({ hasher: colliding, clearDelivered: true })));
        put('portrait.png', 'portrait.png');
        const crash = { registryWrite: { afterLink() { throw new Error('crash after the registry write'); } } };
        await expect(runReconcilePass(options({ hasher: colliding, clearDelivered: true, faults: crash }))).rejects.toThrow('crash after the registry write');

        committed(await runReconcilePass(options({ hasher: colliding, clearDelivered: true })));

        const reports = seen.flat().filter((fact) => fact.reason === 'digest-collision');
        expect(reports).toHaveLength(1);
        expect((await readRegistry(data.root)).pendingFacts).toEqual([]);
    });

    it('reads a file again after an in-place edit that kept its size, inode, and mtime', async () => {
        await setup({ files: [] });
        const landscape = fixtures.get('landscape.jpg') as Buffer;
        const original = withExifOrientation(landscape, 1);
        const edited = withExifOrientation(landscape, 3);
        expect(edited.length).toBe(original.length);
        fs.writeFileSync(lib.file('a.jpg'), original);
        fs.utimesSync(lib.file('a.jpg'), 1_700_000_000, 1_700_000_000);
        const before = fs.statSync(lib.file('a.jpg'));
        const { options } = harness();
        committed(await runReconcilePass(options()));

        // Like an editor that rewrites in place and preserves the modification time.
        const handle = fs.openSync(lib.file('a.jpg'), 'r+');
        fs.writeSync(handle, edited, 0, edited.length, 0);
        fs.closeSync(handle);
        fs.utimesSync(lib.file('a.jpg'), 1_700_000_000, 1_700_000_000);
        const after = fs.statSync(lib.file('a.jpg'));
        expect([after.size, after.ino, after.mtimeMs]).toEqual([before.size, before.ino, before.mtimeMs]);

        const second = committed(await runReconcilePass(options()));
        expect(second.facts).toMatchObject([{ type: 'replaced', path: 'a.jpg' }]);
    });

    it('skips a file whose injected digest collides with a revision of another size until its bytes change', async () => {
        await setup({ files: ['landscape.jpg'] });
        const real = (name: string) => sha256([fixtures.get(name) as Buffer]);
        const colliding: Hasher = (chunks) => {
            const digest = sha256(chunks);
            return chunks.length === 1 && digest === real('portrait.png') ? real('landscape.jpg') : digest;
        };
        const { options } = harness();
        committed(await runReconcilePass(options({ hasher: colliding })));

        put('portrait.png', 'portrait.png');
        const collision = committed(await runReconcilePass(options({ hasher: colliding })));
        expect(collision.facts).toMatchObject([{ type: 'processing-failed', reason: 'digest-collision', path: 'portrait.png' }]);
        expect(Object.keys(collision.registry.photos)).toHaveLength(1);
        expect(committed(await runReconcilePass(options({ hasher: colliding }))).facts).toEqual([]);

        put('portrait.png', 'square.webp');
        const changed = committed(await runReconcilePass(options({ hasher: colliding })));
        expect(changed.facts.map((fact) => `${fact.type} ${fact.path}`)).toEqual(['new portrait.png']);
    });

    it('tells a rename, a copy, a metadata edit, a rotation, and a replacement apart on real files', async () => {
        await setup({ files: ['landscape.jpg', 'portrait.png', 'square.webp'] });
        const { options } = harness();
        const first = committed(await runReconcilePass(options()));
        const idOf = (path: string) => first.registry.photos[Object.keys(first.registry.photos).find((id) => first.registry.photos[id].source.path === path) as string].photoId;
        const [landscape, portrait, square] = [idOf('landscape.jpg'), idOf('portrait.png'), idOf('square.webp')];

        fs.renameSync(lib.file('portrait.png'), lib.file('renamed.png'));
        fs.copyFileSync(lib.file('square.webp'), lib.file('square-copy.webp'));
        fs.writeFileSync(lib.file('landscape.jpg'), withExifOrientation(fixtures.get('landscape.jpg') as Buffer, 1));
        const second = committed(await runReconcilePass(options()));
        expect(second.facts.map((fact) => [fact.type, fact.path, fact.photoId === null ? null : fact.photoId === landscape ? 'landscape' : fact.photoId === portrait ? 'portrait' : fact.photoId === square ? 'square' : 'other'])).toEqual([
            ['metadata-changed', 'landscape.jpg', 'landscape'],
            ['renamed', 'renamed.png', 'portrait'],
            ['new', 'square-copy.webp', 'other'],
        ]);
        expect(second.facts[2].duplicateOf).toBe(square);

        // Orientation 6 turns the same stored pixels upright another way, so it is a visual change.
        fs.writeFileSync(lib.file('landscape.jpg'), fixtures.get('landscape-rot6.jpg') as Buffer);
        const third = committed(await runReconcilePass(options()));
        expect(third.facts).toMatchObject([{ type: 'replaced', path: 'landscape.jpg', photoId: landscape }]);
        const rotated = third.registry.photos[landscape].revisions[third.registry.photos[landscape].source.observedRevision];
        expect(rotated).toMatchObject({ width: 640, height: 960, orientation: 6 });

        fs.writeFileSync(lib.file('landscape.jpg'), fixtures.get('landscape-edited.jpg') as Buffer);
        const fourth = committed(await runReconcilePass(options()));
        expect(fourth.facts).toMatchObject([{ type: 'replaced', path: 'landscape.jpg', photoId: landscape }]);
        expect(Object.keys(fourth.registry.photos[landscape].revisions)).toHaveLength(4);
    });

    it.skipIf(isRoot)('skips and logs a file it cannot read', async () => {
        await setup({ files: ['landscape.jpg'] });
        put('locked.jpg', 'portrait.png');
        fs.chmodSync(lib.file('locked.jpg'), 0o000);
        const warnings: string[] = [];
        const pass = committed(await runReconcilePass(harness().options({ logger: { log: () => undefined, warn: (line: string) => warnings.push(line), error: () => undefined } })));
        expect(pass.facts.map((fact) => fact.path)).toEqual(['landscape.jpg']);
        expect(pass.report.unreadable).toEqual(['locked.jpg']);
        expect(warnings).toEqual(["[identity] Skipped locked.jpg: it can't be read."]);
        fs.chmodSync(lib.file('locked.jpg'), 0o644);
    });

    it.skipIf(isRoot)('skips and logs a folder it cannot list, and keeps the photos bound under it', async () => {
        await setup({ files: ['landscape.jpg'] });
        put('series/a.jpg', 'portrait.png');
        const { options } = harness();
        const first = committed(await runReconcilePass(options()));
        expect(first.facts.map((fact) => `${fact.type} ${fact.path}`)).toEqual(['new landscape.jpg', 'new series/a.jpg']);

        fs.chmodSync(lib.file('series'), 0o000);
        const warnings: string[] = [];
        try {
            const second = committed(await runReconcilePass(options({ logger: { log: () => undefined, warn: (line: string) => warnings.push(line), error: () => undefined } })));
            expect(second.facts).toEqual([]);
            expect(Object.values(second.registry.photos).map((photo) => photo.sourceHealth)).toEqual(['present', 'present']);
        } finally {
            fs.chmodSync(lib.file('series'), 0o755);
        }
        expect(warnings).toEqual(["[identity] Skipped folder series: it can't be listed."]);
    });

    it('records an undecodable file by its bytes, with a failed profile', async () => {
        await setup({ files: ['corrupt.jpg'] });
        const pass = committed(await runReconcilePass(harness().options()));
        expect(pass.facts.map((fact) => `${fact.type} ${fact.reason ?? ''}`.trim())).toEqual(['new', 'processing-failed undecodable']);
        const [photo] = Object.values(pass.registry.photos);
        expect(photo.revisions[photo.source.observedRevision]).toMatchObject({ pixelDigest: null, width: null, height: null, orientation: null });
        expect(pass.jobs).toEqual([]);
    });
});

describe('inspectEntry', () => {
    it('reports a file rewritten in place after the scan as changed, even with its size, inode, and mtime kept', async () => {
        await setup({ files: [] });
        const landscape = fixtures.get('landscape.jpg') as Buffer;
        fs.writeFileSync(lib.file('a.jpg'), withExifOrientation(landscape, 1));
        fs.utimesSync(lib.file('a.jpg'), 1_700_000_000, 1_700_000_000);
        const [entry] = (await scanLibrary(lib.root)).entries;
        expect((await inspectEntry(lib.root, entry, { hasher: sha256 })).kind).toBe('image');

        // Like an editor that rewrites in place and preserves the modification time, while the read runs.
        const handle = fs.openSync(lib.file('a.jpg'), 'r+');
        fs.writeSync(handle, withExifOrientation(landscape, 3), 0, entry.size, 0);
        fs.closeSync(handle);
        fs.utimesSync(lib.file('a.jpg'), 1_700_000_000, 1_700_000_000);
        const after = fs.statSync(lib.file('a.jpg'));
        expect([after.size, after.ino, after.mtimeMs]).toEqual([entry.size, entry.ino, entry.mtimeMs]);

        expect(await inspectEntry(lib.root, entry, { hasher: sha256 })).toEqual({ kind: 'changed' });
    });
});

describe('replayDecisions', () => {
    const decisionId = '00000000-0000-4000-8000-0000000000d1';
    const other = '00000000-0000-4000-8000-0000000000d2';
    const decision = { schemaVersion: 1, decisionId, type: 'archive', photoId: 'ph_00000000-0000-4000-8000-0000000000e1', actor: 'cli', reason: '', createdAt: '2026-06-01T12:00:00.000Z' } as IdentityDecision;
    const file: DecisionFile = { name: `20260601T120000000Z-${decisionId}.json`, decision, raw: JSON.stringify(decision) };

    it("files a recorded decision under its listed name and the entry's own fields, whatever else the entry holds", () => {
        const tampered = { status: 'rejected', reason: 'no', name: '../../victim.txt', decisionId: other, detail: 'x' } as unknown as RecordedDecision;
        const replay = replayDecisions([file], { [decisionId]: tampered });
        expect(replay.fresh).toEqual([]);
        expect(replay.settle([])).toEqual({
            outcomes: [{ name: file.name, decisionId, status: 'rejected', reason: 'no' }],
            decided: { [decisionId]: { status: 'rejected', reason: 'no' } },
        });
    });
});
