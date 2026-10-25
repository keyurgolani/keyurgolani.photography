// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, setLibraryDir, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { withLock } from '../../storage/lock';
import { createDecision, decisionFileName, writeDecision, type DecisionInput } from '../decisions';
import { runReconcilePass, type PassOptions } from '../pass';
import { STABILITY_MS } from '../reconcile';
import { identityPaths, readRegistry } from '../registry';
import { sequentialIds } from './reconcileFixtures';

const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const isRoot = process.getuid?.() === 0;
let images: Record<'A' | 'B' | 'Z', Buffer>;
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
    const make = (r: number) => sharp({ create: { width: 64, height: 48, channels: 3, background: { r, g: 90, b: 200 - r } } }).jpeg().toBuffer();
    images = { A: await make(30), B: await make(120), Z: await make(210) };
});

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Setup {
    lib: TempLibrary;
    data: TempDataRoot;
    /** A pass that sees every file as settled, unless `clock` says otherwise. */
    pass(options?: Partial<PassOptions>): ReturnType<typeof runReconcilePass>;
    photoAt(file: string): Promise<string>;
    decide(input: Omit<DecisionInput, 'actor'>): Promise<{ name: string; decisionId: string; photoId?: string }>;
    pending(): string[];
    filed(folder: 'applied' | 'rejected'): string[];
}

/** A library of `files` and a data root reconciled once. A library made earlier can stand in, so its files are already settled. */
async function setup(files: Record<string, keyof typeof images> | TempLibrary): Promise<Setup> {
    let lib: TempLibrary;
    if (typeof files.root === 'string' && typeof files.cleanup === 'function') {
        lib = files as TempLibrary;
        const restore = setLibraryDir(lib.root);
        cleanups.push(async () => restore());
    } else {
        lib = await createTempLibrary();
        cleanups.push(() => lib.cleanup());
        for (const [file, name] of Object.entries(files as Record<string, keyof typeof images>)) fs.writeFileSync(lib.file(file), images[name]);
    }
    const data = createTempDataRoot();
    cleanups.push(() => data.cleanup());
    const ids = sequentialIds();
    const decisionIds = sequentialIds(5_000);
    const pass = (options: Partial<PassOptions> = {}) => runReconcilePass({ clock: () => Date.now() + 3_600_000, idGen: ids, logger: quiet, ...options });
    const first = await pass();
    if (first.status !== 'committed') throw new Error(JSON.stringify(first));
    const dir = identityPaths(data.root).decisions;
    const list = (folder: string) => (fs.existsSync(folder) ? fs.readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name).sort() : []);
    return {
        lib,
        data,
        pass,
        async photoAt(file) {
            const photo = Object.values((await readRegistry(data.root)).photos).find((candidate) => candidate.source.path === file && candidate.source.present);
            if (!photo) throw new Error(`No photo at ${file}`);
            return photo.photoId;
        },
        async decide(input) {
            const decision = createDecision({ actor: 'test', ...input }, { idGen: decisionIds });
            await writeDecision(data.root, decision);
            return { name: decisionFileName(decision), decisionId: decision.decisionId, photoId: decision.photoId };
        },
        pending: () => list(dir),
        filed: (folder) => list(path.join(dir, folder)),
    };
}

describe('a pass with decision files', () => {
    it('applies a decision and moves its file to applied/ unchanged', async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        fs.rmSync(s.lib.file('a.jpg'));
        fs.writeFileSync(s.lib.file('z.jpg'), images.Z);
        const { name } = await s.decide({ type: 'bind', path: 'z.jpg', photoId: x });
        const bytes = fs.readFileSync(path.join(identityPaths(s.data.root).decisions, name));
        const outcome = await s.pass();
        if (outcome.status !== 'committed') throw new Error(JSON.stringify(outcome));
        expect(outcome.decisions).toEqual([{ name, decisionId: expect.any(String), status: 'applied', detail: `bound z.jpg to ${x}` }]);
        expect(outcome.facts).toMatchObject([{ type: 'replaced', photoId: x, path: 'z.jpg', fromPath: 'a.jpg' }]);
        expect(await s.photoAt('z.jpg')).toBe(x);
        expect(Object.keys((await readRegistry(s.data.root)).photos)).toEqual([x]);
        expect(s.pending()).toEqual([]);
        expect(s.filed('applied')).toEqual([name]);
        expect(fs.readFileSync(path.join(identityPaths(s.data.root).decisions, 'applied', name)).equals(bytes)).toBe(true);
    }, 60_000);

    it('records a refused decision and an invalid file in rejected/ with the reason', async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        const { name } = await s.decide({ type: 'archive', photoId: x });
        fs.writeFileSync(path.join(identityPaths(s.data.root).decisions, 'zz-broken.json'), '{ nope');
        const outcome = await s.pass();
        if (outcome.status !== 'committed') throw new Error(JSON.stringify(outcome));
        expect(outcome.decisions.map((decision) => decision.status)).toEqual(['rejected', 'rejected']);
        expect(s.pending()).toEqual([]);
        expect(s.filed('rejected')).toEqual([name, 'zz-broken.json']);
        const record = JSON.parse(fs.readFileSync(path.join(identityPaths(s.data.root).decisions, 'rejected', name), 'utf8'));
        expect(record).toMatchObject({ reason: `${x} is present at a.jpg, and archive is for a photo whose file is gone`, decision: { type: 'archive', photoId: x } });
        expect((await readRegistry(s.data.root)).photos[x].sourceHealth).toBe('present');
    }, 60_000);

    it('leaves a decision about a file still being written for the next pass', async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        fs.rmSync(s.lib.file('a.jpg'));
        fs.writeFileSync(s.lib.file('z.jpg'), images.Z);
        const { name } = await s.decide({ type: 'bind', path: 'z.jpg', photoId: x });
        const now = await s.pass({ clock: () => Date.now() });
        if (now.status !== 'committed') throw new Error(JSON.stringify(now));
        expect(now.decisions).toMatchObject([{ name, status: 'deferred', reason: 'z.jpg is still changing' }]);
        expect(s.pending()).toEqual([name]);
        const later = await s.pass();
        if (later.status !== 'committed') throw new Error(JSON.stringify(later));
        expect(later.decisions).toMatchObject([{ name, status: 'applied' }]);
        expect(await s.photoAt('z.jpg')).toBe(x);
    }, 60_000);

    it('logs one line per decision', async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        const { name } = await s.decide({ type: 'reprofile', photoId: x });
        const lines: string[] = [];
        await s.pass({ logger: { ...quiet, log: (line: string) => { lines.push(line); } } });
        expect(lines.map((line) => JSON.parse(line))).toEqual([
            { event: 'identity-decision', name, decisionId: expect.any(String), status: 'applied', detail: 'queued the current profile for 0 revisions' },
        ]);
    }, 60_000);

    it.skipIf(isRoot)("commits without decisions when their folder can't be read, and applies them once it can", async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        fs.rmSync(s.lib.file('a.jpg'));
        const { name } = await s.decide({ type: 'archive', photoId: x });
        const dir = identityPaths(s.data.root).decisions;
        const warnings: string[] = [];
        fs.chmodSync(dir, 0o000);
        try {
            const blocked = await s.pass({ logger: { ...quiet, warn: (line: string) => { warnings.push(line); } } });
            expect(blocked).toMatchObject({ status: 'committed', decisions: [] });
        } finally {
            fs.chmodSync(dir, 0o700);
        }
        expect(warnings).toEqual([expect.stringContaining("Could not read identity/decisions/")]);
        expect((await readRegistry(s.data.root)).photos[x].sourceHealth).toBe('missing');
        const later = await s.pass();
        expect(later).toMatchObject({ status: 'committed', decisions: [{ name, status: 'applied' }] });
        expect((await readRegistry(s.data.root)).photos[x].sourceHealth).toBe('archived');
    }, 60_000);

    it.skipIf(isRoot)("leaves a decision file it can't read where it is, and applies it once it can", async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        fs.rmSync(s.lib.file('a.jpg'));
        const { name } = await s.decide({ type: 'archive', photoId: x });
        const file = path.join(identityPaths(s.data.root).decisions, name);
        fs.chmodSync(file, 0o000);
        try {
            const blocked = await s.pass();
            expect(blocked).toMatchObject({ status: 'committed', decisions: [{ name, status: 'deferred', reason: expect.stringContaining("it can't be read") }] });
        } finally {
            fs.chmodSync(file, 0o600);
        }
        expect(s.pending()).toEqual([name]);
        expect(s.filed('rejected')).toEqual([]);
        const later = await s.pass();
        expect(later).toMatchObject({ status: 'committed', decisions: [{ name, status: 'applied', detail: `archived ${x}` }] });
    }, 60_000);

    it.skipIf(isRoot)("keeps the registry change and warns when the decision can't be filed, and files it next time", async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        fs.rmSync(s.lib.file('a.jpg'));
        const { name, decisionId } = await s.decide({ type: 'archive', photoId: x });
        const dir = identityPaths(s.data.root).decisions;
        const warnings: string[] = [];
        fs.chmodSync(dir, 0o500);
        try {
            const outcome = await s.pass({ logger: { ...quiet, warn: (line: string) => { warnings.push(line); } } });
            expect(outcome).toMatchObject({ status: 'committed', decisions: [{ name, status: 'applied' }] });
        } finally {
            fs.chmodSync(dir, 0o700);
        }
        expect(warnings).toEqual([expect.stringContaining('Could not file the applied and rejected decisions')]);
        expect((await readRegistry(s.data.root)).photos[x].sourceHealth).toBe('archived');
        expect(s.pending()).toEqual([name]);
        const again = await s.pass();
        expect(again).toMatchObject({ status: 'committed', decisions: [{ name, status: 'applied', detail: `archived ${x}` }] });
        expect(s.filed('applied')).toEqual([name]);
        // Recorded until a pass finds its file gone
        expect((await readRegistry(s.data.root)).decided).toEqual({ [decisionId]: { status: 'applied', detail: `archived ${x}` } });
        await s.pass();
        expect((await readRegistry(s.data.root)).decided).toBeUndefined();
    }, 60_000);

    it('files a decision as it went after a crash between the registry write and the move, applying nothing again', async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        fs.rmSync(s.lib.file('a.jpg'));
        fs.writeFileSync(s.lib.file('z.jpg'), images.Z);
        const { name } = await s.decide({ type: 'bind', path: 'z.jpg', photoId: x });
        await expect(s.pass({ faults: { beforeSettle: () => { throw new Error('the process died'); } } })).rejects.toThrow('the process died');
        expect(await s.photoAt('z.jpg')).toBe(x);
        expect(s.pending()).toEqual([name]);
        const version = (await readRegistry(s.data.root)).version;

        const again = await s.pass();
        if (again.status !== 'committed') throw new Error(JSON.stringify(again));
        expect(again.decisions).toMatchObject([{ name, status: 'applied', detail: `bound z.jpg to ${x}` }]);
        expect(again.facts).toEqual([]);
        expect(s.pending()).toEqual([]);
        expect(s.filed('applied')).toEqual([name]);
        expect((await readRegistry(s.data.root)).version).toBe(version + 1);
    }, 60_000);

    it('replays a batch after a crash as it went, though its second decision changed what the first found', async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        fs.rmSync(s.lib.file('a.jpg'));
        fs.writeFileSync(s.lib.file('z.jpg'), images.Z);
        // Bind z.jpg to x, then change course: z.jpg is a photo of its own after all.
        const bind = await s.decide({ type: 'bind', path: 'z.jpg', photoId: x });
        const made = await s.decide({ type: 'new', path: 'z.jpg' });
        const n = made.photoId as string;
        await expect(s.pass({ faults: { beforeSettle: () => { throw new Error('the process died'); } } })).rejects.toThrow('the process died');
        expect(await s.photoAt('z.jpg')).toBe(n);
        expect(s.pending()).toEqual([bind.name, made.name]);

        const again = await s.pass();
        if (again.status !== 'committed') throw new Error(JSON.stringify(again));
        expect(again.decisions).toEqual([
            { name: bind.name, decisionId: bind.decisionId, status: 'applied', detail: `bound z.jpg to ${x}` },
            { name: made.name, decisionId: made.decisionId, status: 'applied', detail: `gave z.jpg its own photo ${n}` },
        ]);
        expect(again.facts).toEqual([]);
        expect(s.pending()).toEqual([]);
        expect(s.filed('applied')).toEqual([bind.name, made.name]);
        expect(s.filed('rejected')).toEqual([]);
        const registry = await readRegistry(s.data.root);
        expect(Object.keys(registry.photos).sort()).toEqual([x, n].sort());
        expect(registry.photos[n]).toMatchObject({ sourceHealth: 'present', source: { path: 'z.jpg' } });
        expect(registry.photos[x].sourceHealth).toBe('missing');
    }, 60_000);
});

describe('photos identity decisions', { timeout: 120_000 }, () => {
    const cli = (s: Setup, args: string[], env: Record<string, string | undefined> = {}) =>
        runTsx('scripts/photos.ts', ['identity', ...args], { env: { PHOTOGRAPHY_LIBRARY_DIR: s.lib.root, PHOTOGRAPHY_DATA_DIR: s.data.root, ...env } });

    // The command's pass runs on the real clock and reads only files that have settled for the
    // stability window, so the libraries its passes act on are made up front and left to settle.
    const settled = {} as Record<'bind' | 'new', TempLibrary>;
    beforeAll(async () => {
        const layouts: Record<'bind' | 'new', Record<string, keyof typeof images>> = { bind: { 'a.jpg': 'A', 'z.jpg': 'Z' }, new: { 'a.jpg': 'A' } };
        for (const name of ['bind', 'new'] as const) {
            const lib = await createTempLibrary();
            for (const [file, image] of Object.entries(layouts[name])) fs.writeFileSync(lib.file(file), images[image]);
            settled[name] = lib;
        }
        await new Promise((resolve) => setTimeout(resolve, STABILITY_MS + 500));
    }, 30_000);
    afterAll(async () => {
        await settled.new?.cleanup();
        await settled.bind?.cleanup();
    });

    it('binds a path, merging the photo --merge names, prints what it did, and files the decision as applied', async () => {
        const s = await setup(settled.bind);
        const [x, n] = [await s.photoAt('a.jpg'), await s.photoAt('z.jpg')];
        fs.rmSync(s.lib.file('a.jpg'));
        const refused = await cli(s, ['bind', 'z.jpg', x]);
        expect(refused.code).toBe(1);
        expect(refused.stderr).toContain(`Rejected: z.jpg is bound to ${n}. To merge ${n} into ${x}, name it with --merge.`);
        expect(await s.photoAt('z.jpg')).toBe(n);

        const run = await cli(s, ['bind', 'z.jpg', x, '--merge', n, '--reason', 'same photo, new edit']);
        expect(run.stderr).toBe('');
        expect(run.code).toBe(0);
        expect(run.stdout).toContain(`Applied: bound z.jpg to ${x} and merged ${n} into it.`);
        expect(await s.photoAt('z.jpg')).toBe(x);
        const [filed] = s.filed('applied');
        expect(JSON.parse(fs.readFileSync(path.join(identityPaths(s.data.root).decisions, 'applied', filed), 'utf8'))).toMatchObject({
            type: 'bind', path: 'z.jpg', photoId: x, merge: n, actor: 'cli', reason: 'same photo, new edit',
        });
    });

    it('gives a bound path, named by its absolute path, its own photo, and prints the new photo ID', async () => {
        const s = await setup(settled.new);
        const x = await s.photoAt('a.jpg');
        const run = await cli(s, ['new', s.lib.file('a.jpg')]);
        expect(run.code).toBe(0);
        const minted = /Photo ID: (ph_[0-9a-f-]+)/.exec(run.stdout)?.[1];
        expect(minted).toBeDefined();
        expect(await s.photoAt('a.jpg')).toBe(minted);
        expect((await readRegistry(s.data.root)).photos[x].sourceHealth).toBe('missing');
    });

    it('exits 1 with the reason when the decision is refused', async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        const run = await cli(s, ['archive', x]);
        expect(run.code).toBe(1);
        expect(run.stderr).toContain(`Rejected: ${x} is present at a.jpg, and archive is for a photo whose file is gone.`);
        expect(s.filed('rejected')).toHaveLength(1);
    });

    it("says the decision is saved when its pass can't read the library, so it isn't made twice", async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        const missing = path.join(s.lib.root, 'unmounted');
        const run = await cli(s, ['archive', x], { PHOTOGRAPHY_LIBRARY_DIR: missing });
        expect(run.code).toBe(1);
        const [saved] = s.pending();
        expect(saved).toBeDefined();
        expect(run.stderr).toContain(`Check the mount or PHOTOGRAPHY_LIBRARY_DIR. The decision is saved in ${path.join(identityPaths(s.data.root).decisions, saved)}, and the next pass that runs applies it. Don't run the command again.`);
        expect(run.stderr).not.toContain('Nothing was written');
    });

    it('saves the decision for the watcher when the registry is busy', async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        const run = await withLock('registry', { root: s.data.root }, () => cli(s, ['reprofile', x]));
        expect(run.code).toBe(0);
        expect(run.stdout).toContain('The registry is busy, so the watcher applies it on its next pass.');
        expect(s.pending()).toHaveLength(1);
        expect(s.filed('applied')).toEqual([]);
    });

    it('writes nothing when the data root is not ready', async () => {
        const s = await setup({ 'a.jpg': 'A' });
        const x = await s.photoAt('a.jpg');
        const other = createTempDataRoot({ state: 'uninitialized' });
        cleanups.push(() => other.cleanup());
        const run = await cli(s, ['retry', x], { PHOTOGRAPHY_DATA_DIR: other.root });
        expect(run.code).toBe(1);
        expect(run.stderr).toContain('The data root is uninitialized');
        expect(fs.readdirSync(other.root)).toEqual([]);
    });

    it.each([
        [['bind', 'a.jpg'], 'identity bind needs a path and a photo ID.'],
        [['bind', 'a.jpg', 'ph_1'], 'ph_1 is not a photo ID.'],
        [['bind', '../outside.jpg', 'ph_00000000-0000-4000-8000-000000000001'], '../outside.jpg is not inside the library.'],
        [['retry', 'ph_00000000-0000-4000-8000-000000000001', 'sha256-x'], 'sha256-x is not an asset revision.'],
        [['reprofile'], 'identity reprofile needs a photo ID or --all.'],
        [['reprofile', 'ph_00000000-0000-4000-8000-000000000001', '--all'], 'identity reprofile takes a photo ID or --all, not both.'],
        [['merge', 'x'], 'Unknown identity command: merge'],
        // Flags parse strictly, as the other photos commands' do
        [['archive', 'ph_00000000-0000-4000-8000-000000000001', '--force'], "Unknown option '--force'"],
        [['archive', 'ph_00000000-0000-4000-8000-000000000001', '--reason'], "Option '--reason <value>' argument missing"],
        [['new', 'a.jpg', '--all'], '--all goes with identity reprofile.'],
        [['archive', 'ph_00000000-0000-4000-8000-000000000001', '--merge', 'ph_00000000-0000-4000-8000-000000000002'], '--merge goes with identity bind.'],
        [['bind', 'a.jpg', 'ph_00000000-0000-4000-8000-000000000001', '--merge', 'ph_1'], 'ph_1 is not a photo ID.'],
        [['bind', 'a.jpg', 'ph_00000000-0000-4000-8000-000000000001', '--merge', 'ph_00000000-0000-4000-8000-000000000001'], '--merge must name a photo other than ph_00000000-0000-4000-8000-000000000001.'],
    ])('exits 2 on %j', async (args, message) => {
        const s = await setup({ 'a.jpg': 'A' });
        const run = await cli(s, args);
        expect(run.code).toBe(2);
        expect(run.stderr).toContain(message);
        expect(s.pending()).toEqual([]);
    });
});
