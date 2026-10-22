// @vitest-environment node
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import {
    checkSchemaVersion,
    CorruptDocumentError,
    readJsonFile,
    StaleVersionError,
    UnsupportedSchemaError,
    VERSION_CLAIM_STALE_MS,
    versionClaimPath,
    writeVersionedDocument,
} from '../document';
import { MAX_LEASE_MS } from '../lock';

interface Counter {
    schemaVersion: number;
    version: number;
    count: number;
}

let data: TempDataRoot;

beforeEach(() => {
    data = createTempDataRoot({ state: 'uninitialized' });
});

afterEach(async () => {
    vi.restoreAllMocks();
    await data.cleanup();
});

describe('checkSchemaVersion', () => {
    it('accepts the current and previous versions and says which', () => {
        expect(checkSchemaVersion('doc.json', { schemaVersion: 3 }, 3)).toBe('current');
        expect(checkSchemaVersion('doc.json', { schemaVersion: 2 }, 3)).toBe('previous');
    });

    it('rejects a future version as unsupported, flagged future', () => {
        let error: unknown;
        try {
            checkSchemaVersion('doc.json', { schemaVersion: 4 }, 3);
        } catch (caught) {
            error = caught;
        }
        expect(error).toBeInstanceOf(UnsupportedSchemaError);
        expect(error).toMatchObject({ found: 4, current: 3, future: true });
    });

    it('rejects an older version than the previous one, and malformed ones', () => {
        expect(() => checkSchemaVersion('doc.json', { schemaVersion: 1 }, 3)).toThrow(UnsupportedSchemaError);
        expect(() => checkSchemaVersion('doc.json', { schemaVersion: '1' }, 1)).toThrow(CorruptDocumentError);
        expect(() => checkSchemaVersion('doc.json', [], 1)).toThrow(CorruptDocumentError);
        expect(() => checkSchemaVersion('doc.json', null, 1)).toThrow(CorruptDocumentError);
    });
});

describe('readJsonFile', () => {
    it('returns null for a missing file and throws for one that is not JSON', async () => {
        expect(await readJsonFile(data.file('missing.json'))).toBeNull();
        fs.writeFileSync(data.file('bad.json'), '{"truncated": ');
        await expect(readJsonFile(data.file('bad.json'))).rejects.toThrow(CorruptDocumentError);
    });
});

describe('writeVersionedDocument', () => {
    it('creates a missing document at version 1 and bumps the version on each write', async () => {
        const file = data.file('counter.json');
        const first = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 1 }, 0);
        expect(first.version).toBe(1);
        const second = await writeVersionedDocument<Counter>(file, { ...first, count: 2 }, first.version);
        expect(second.version).toBe(2);
        expect(await readJsonFile(file)).toEqual({ schemaVersion: 1, version: 2, count: 2 });
    });

    it('fails a write based on a stale version and leaves the newer document alone', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);

        // Two writers read version 1. The first one wins.
        const winner = await writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version);
        const before = fs.readFileSync(file);
        let error: unknown;
        try {
            await writeVersionedDocument<Counter>(file, { ...base, count: 20 }, base.version);
        } catch (caught) {
            error = caught;
        }

        expect(error).toBeInstanceOf(StaleVersionError);
        expect(error).toMatchObject({ expected: 1, found: 2 });
        expect(fs.readFileSync(file).equals(before)).toBe(true);
        expect(await readJsonFile(file)).toEqual(winner);
    });

    it('treats a missing document as version 0, so a writer expecting an existing one fails', async () => {
        await expect(writeVersionedDocument<Counter>(data.file('counter.json'), { schemaVersion: 1, version: 3, count: 0 }, 3))
            .rejects.toMatchObject({ name: 'StaleVersionError', expected: 3, found: 0 });
        expect(fs.existsSync(data.file('counter.json'))).toBe(false);
    });

    it('lets one of two overlapping writes at the same version through and refuses the other, so no update is lost', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);

        // The second writer reads version 1 while the first is between its check and its rename.
        let second: Promise<unknown> = Promise.resolve();
        await writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version, {
            faults: {
                async beforeRename() {
                    second = writeVersionedDocument<Counter>(file, { ...base, count: 20 }, base.version).catch((caught: unknown) => caught);
                    await second;
                },
            },
        });

        expect(await second).toBeInstanceOf(StaleVersionError);
        expect(await readJsonFile(file)).toEqual({ schemaVersion: 1, version: 2, count: 10 });
        expect(claims()).toEqual([]);
    });

    it('checks the version again once it holds the claim, so a writer that read before another moved the file on fails', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);

        // Another writer stores version 2 and lets its claim go between this writer's read and its claim.
        const error = await writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version, {
            hooks: { beforeClaim: () => writeVersionedDocument<Counter>(file, { ...base, count: 20 }, base.version).then(() => undefined) },
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(StaleVersionError);
        expect(error).toMatchObject({ expected: 1, found: 2 });
        expect(await readJsonFile(file)).toEqual({ schemaVersion: 1, version: 2, count: 20 });
        expect(claims()).toEqual([]);
    });

    it('keeps a writer paused between its claim and its rename the only one to store its version, so nothing goes back', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        // Past the 60 s a claim used to last, but well inside a lock's lease
        const soon = () => Date.now() + 61_000;
        const others: unknown[] = [];

        const first = await writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version, {
            faults: {
                async beforeRename() {
                    others.push(await writeVersionedDocument<Counter>(file, { ...base, count: 20 }, 1, { clock: soon }).catch((caught: unknown) => caught));
                    others.push(await writeVersionedDocument<Counter>(file, { ...base, version: 2, count: 30 }, 2, { clock: soon }).catch((caught: unknown) => caught));
                },
            },
        });

        expect(first).toMatchObject({ version: 2, count: 10 });
        expect(others).toEqual([
            expect.objectContaining({ name: 'StaleVersionError', expected: 1, found: 2 }),
            expect.objectContaining({ name: 'StaleVersionError', expected: 2, found: 1 }),
        ]);
        expect(await readJsonFile(file)).toEqual({ schemaVersion: 1, version: 2, count: 10 });
        expect(claims()).toEqual([]);
    });

    it('keeps the stale age of a claim above any lock lease, so a writer that still holds its lock is never taken for dead', () => {
        expect(VERSION_CLAIM_STALE_MS).toBeGreaterThan(MAX_LEASE_MS);
    });

    it('waits out a claim a writer that died before its rename left, then installs it once it is stale', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        // A claim holds its writer's whole document from the moment it is linked.
        fs.writeFileSync(versionClaimPath(file, 2), `${JSON.stringify({ schemaVersion: 1, version: 2, count: 7 }, null, 2)}\n`);

        await expect(writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version)).rejects.toMatchObject({ name: 'StaleVersionError', expected: 1, found: 2 });
        expect(await readJsonFile(file)).toEqual(base);

        const later = () => Date.now() + VERSION_CLAIM_STALE_MS + 1_000;
        await expect(writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version, { clock: later }))
            .rejects.toMatchObject({ name: 'StaleVersionError', expected: 1, found: 2 });
        expect(await readJsonFile(file)).toEqual({ schemaVersion: 1, version: 2, count: 7 });
        expect(claims()).toEqual([]);
        // From the version it installed, the next write goes through.
        expect(await writeVersionedDocument<Counter>(file, { ...base, count: 10 }, 2)).toMatchObject({ version: 3, count: 10 });
    });

    it('installs the claim of a writer paused past the stale age, which then reports its write done, though the file moved on', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        const later = () => Date.now() + VERSION_CLAIM_STALE_MS + 1_000;
        let third: Counter | undefined;

        const first = await writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version, {
            hooks: {
                async beforeInstall() {
                    // Taken for dead: the next writer installs this claim, and another stores version 3 on top of it.
                    await expect(writeVersionedDocument<Counter>(file, { ...base, count: 20 }, 1, { clock: later })).rejects.toMatchObject({ found: 2 });
                    expect(await readJsonFile(file)).toEqual({ schemaVersion: 1, version: 2, count: 10 });
                    third = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 2, count: 30 }, 2);
                },
            },
        });

        expect(first).toMatchObject({ version: 2, count: 10 });
        expect(third).toMatchObject({ version: 3, count: 30 });
        expect(await readJsonFile(file)).toEqual({ schemaVersion: 1, version: 3, count: 30 });
        expect(claims()).toEqual([]);
    });

    it('frees a stale claim that holds no document, and writes', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        fs.writeFileSync(versionClaimPath(file, 2), '');

        await expect(writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version)).rejects.toMatchObject({ name: 'StaleVersionError', found: 2 });
        const later = () => Date.now() + VERSION_CLAIM_STALE_MS + 1_000;
        expect(await writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version, { clock: later })).toMatchObject({ version: 2, count: 10 });
        expect(claims()).toEqual([]);
    });

    it("leaves a claim that took a stale one's place between its look and its settling", async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        const left = versionClaimPath(file, 2);
        fs.writeFileSync(left, '');
        const later = () => Date.now() + VERSION_CLAIM_STALE_MS + 1_000;

        const error = await writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version, {
            clock: later,
            hooks: {
                beforeRollForward(claimPath) {
                    // Another writer settled the stale claim first and holds a fresh one now.
                    fs.rmSync(claimPath);
                    fs.writeFileSync(claimPath, 'fresh');
                },
            },
        }).catch((caught: unknown) => caught);

        expect(error).toBeInstanceOf(StaleVersionError);
        expect(fs.readFileSync(left, 'utf8')).toBe('fresh');
        expect(await readJsonFile(file)).toEqual(base);
    });

    it('drops claims for older versions a crash left after its rename, and leaves none after a write that failed', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        fs.writeFileSync(versionClaimPath(file, 1), '');

        await expect(writeVersionedDocument<Counter>(file, { ...base, count: 5 }, base.version, { faults: { beforeRename() { throw new Error('disk full'); } } }))
            .rejects.toThrow('disk full');
        expect(claims()).toEqual(['counter.json.claim-1']);
        expect(await readJsonFile(file)).toEqual(base);

        await writeVersionedDocument<Counter>(file, { ...base, count: 5 }, base.version);
        expect(claims()).toEqual([]);
    });

    it('installs a claim once when two writers take it for dead together, so a version stored after it is never put back', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        const left = versionClaimPath(file, 2);
        fs.writeFileSync(left, `${JSON.stringify({ schemaVersion: 1, version: 2, count: 7 }, null, 2)}\n`);
        const { ino, ctimeMs } = fs.statSync(left);
        // Stale by less than the wait below, so a link made after the wait is fresh by the same clock.
        const later = () => ctimeMs + VERSION_CLAIM_STALE_MS + 200;
        await sleep(400);

        // The first of the two to install it stops right before it moves the claim over the file.
        const paused = gate();
        const resume = gate();
        const realRename = fs.promises.rename.bind(fs.promises);
        vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args: Parameters<typeof fs.promises.rename>) => {
            if (args[1] === file && !paused.opened && inoOf(args[0]) === ino) {
                paused.open();
                await resume.promise;
            }
            return realRename(...args);
        });
        // Both judge the claim stale before either installs it.
        const judged = gate();
        const settle = gate();
        const second = writeVersionedDocument<Counter>(file, { ...base, count: 20 }, base.version, {
            clock: later,
            hooks: {
                async beforeRollForward() {
                    judged.open();
                    await settle.promise;
                },
            },
        }).catch((caught: unknown) => caught);
        await judged.promise;
        const first = writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version, { clock: later }).catch((caught: unknown) => caught);
        await paused.promise;
        settle.open();
        expect(await second).toBeInstanceOf(StaleVersionError);

        // The file stays at 1 until the first installs the claim, so no write lands on top for it to put back.
        const third = await writeVersionedDocument<Counter>(file, { ...base, version: 2, count: 30 }, 2).catch((caught: unknown) => caught);
        resume.open();
        expect(await first).toBeInstanceOf(StaleVersionError);

        expect(third).toMatchObject({ name: 'StaleVersionError', expected: 2, found: 1 });
        expect(await readJsonFile(file)).toEqual({ schemaVersion: 1, version: 2, count: 7 });
        expect(claims()).toEqual([]);
        expect(await writeVersionedDocument<Counter>(file, { ...base, version: 2, count: 30 }, 2)).toMatchObject({ version: 3, count: 30 });
    });

    it('fails a writer as stale, not with ENOENT, when the claim it took for dead is installed and gone before it installs it', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        const left = versionClaimPath(file, 2);
        fs.writeFileSync(left, `${JSON.stringify({ schemaVersion: 1, version: 2, count: 7 }, null, 2)}\n`);
        const later = () => Date.now() + VERSION_CLAIM_STALE_MS + 1_000;

        // It stops right before it links the claim to install it.
        const paused = gate();
        const resume = gate();
        const realLink = fs.promises.link.bind(fs.promises);
        vi.spyOn(fs.promises, 'link').mockImplementation(async (...args: Parameters<typeof fs.promises.link>) => {
            if (args[0] === left && !paused.opened) {
                paused.open();
                await resume.promise;
            }
            return realLink(...args);
        });
        const first = writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version, { clock: later }).catch((caught: unknown) => caught);
        await paused.promise;

        // Another writer installs it meanwhile, and the claim goes once it is the file.
        await expect(writeVersionedDocument<Counter>(file, { ...base, count: 20 }, base.version, { clock: later }))
            .rejects.toMatchObject({ name: 'StaleVersionError', found: 2 });
        resume.open();

        expect(await first).toMatchObject({ name: 'StaleVersionError', expected: 1, found: 2 });
        expect(await readJsonFile(file)).toEqual({ schemaVersion: 1, version: 2, count: 7 });
        expect(claims()).toEqual([]);
    });

    it('reports its write done when its claim is installed while it is paused right after the link', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        const claimPath = versionClaimPath(file, 2);
        const later = () => Date.now() + VERSION_CLAIM_STALE_MS + 1_000;

        const paused = gate();
        const resume = gate();
        const realLink = fs.promises.link.bind(fs.promises);
        vi.spyOn(fs.promises, 'link').mockImplementation(async (...args: Parameters<typeof fs.promises.link>) => {
            await realLink(...args);
            if (args[1] === claimPath && !paused.opened) {
                paused.open();
                await resume.promise;
            }
        });
        const first = writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version).catch((caught: unknown) => caught);
        await paused.promise;

        // Taken for dead: the next writer installs its claim.
        await expect(writeVersionedDocument<Counter>(file, { ...base, count: 20 }, base.version, { clock: later }))
            .rejects.toMatchObject({ name: 'StaleVersionError', found: 2 });
        expect(await readJsonFile(file)).toEqual({ schemaVersion: 1, version: 2, count: 10 });
        resume.open();

        expect(await first).toEqual({ schemaVersion: 1, version: 2, count: 10 });
        expect(await readJsonFile(file)).toEqual({ schemaVersion: 1, version: 2, count: 10 });
        expect(claims()).toEqual([]);
    });

    it('leaves the install to the writer that took it for dead and holds the claim, so a version stored after it is never put back', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        const claimPath = versionClaimPath(file, 2);
        const later = () => Date.now() + VERSION_CLAIM_STALE_MS + 1_000;

        // The writer that takes it for dead stops right before it moves the claim over the file.
        let ino = -1;
        const paused = gate();
        const resume = gate();
        const realRename = fs.promises.rename.bind(fs.promises);
        vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args: Parameters<typeof fs.promises.rename>) => {
            if (args[1] === file && !paused.opened && inoOf(args[0]) === ino) {
                paused.open();
                await resume.promise;
            }
            return realRename(...args);
        });
        let settler: Promise<unknown> = Promise.resolve();
        const first = await writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version, {
            hooks: {
                async beforeInstall() {
                    ino = fs.statSync(claimPath).ino;
                    settler = writeVersionedDocument<Counter>(file, { ...base, count: 20 }, base.version, { clock: later }).catch((caught: unknown) => caught);
                    await paused.promise;
                },
            },
        });
        expect(first).toMatchObject({ version: 2, count: 10 });

        // The file stays at 1 until that writer installs the claim, so no write lands on top for it to put back.
        const third = await writeVersionedDocument<Counter>(file, { ...base, version: 2, count: 30 }, 2).catch((caught: unknown) => caught);
        resume.open();
        expect(await settler).toBeInstanceOf(StaleVersionError);

        expect(third).toMatchObject({ name: 'StaleVersionError', expected: 2, found: 1 });
        expect(await readJsonFile(file)).toEqual({ schemaVersion: 1, version: 2, count: 10 });
        expect(claims()).toEqual([]);
        expect(await writeVersionedDocument<Counter>(file, { ...base, version: 2, count: 30 }, 2)).toMatchObject({ version: 3, count: 30 });
    });

    it("leaves a stale claim it can't read alone, rather than taking it for one that holds no document", async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        const left = versionClaimPath(file, 2);
        fs.writeFileSync(left, `${JSON.stringify({ schemaVersion: 1, version: 2, count: 7 }, null, 2)}\n`);
        const later = () => Date.now() + VERSION_CLAIM_STALE_MS + 1_000;
        const realReadFile = fs.promises.readFile.bind(fs.promises);
        vi.spyOn(fs.promises, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.promises.readFile>) => {
            if (args[0] === left) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' });
            return realReadFile(...args);
        }) as typeof fs.promises.readFile);

        await expect(writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version, { clock: later })).rejects.toMatchObject({ code: 'EIO' });
        vi.restoreAllMocks();
        expect(await readJsonFile(left)).toEqual({ schemaVersion: 1, version: 2, count: 7 });
        expect(await readJsonFile(file)).toEqual(base);
    });
});

/** The claim files beside the documents, by name. */
function claims(): string[] {
    return fs.readdirSync(data.root).filter((name) => name.includes('.claim-')).sort();
}

/** A promise a test waits on, and what opens it. */
function gate(): { promise: Promise<void>; opened: boolean; open(): void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((done) => {
        resolve = done;
    });
    const result = {
        promise,
        opened: false,
        open() {
            result.opened = true;
            resolve();
        },
    };
    return result;
}

function inoOf(target: fs.PathLike): number {
    try {
        return fs.statSync(target).ino;
    } catch {
        return -1;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
