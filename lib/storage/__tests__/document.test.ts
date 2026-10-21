// @vitest-environment node
import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

    it('waits out a claim left by a writer that died before its rename, then breaks it once it is stale', async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        const left = versionClaimPath(file, 2);
        fs.writeFileSync(left, '');

        await expect(writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version)).rejects.toMatchObject({ name: 'StaleVersionError', expected: 1, found: 2 });

        const old = new Date(Date.now() - VERSION_CLAIM_STALE_MS - 1_000);
        fs.utimesSync(left, old, old);
        expect(await writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version)).toMatchObject({ version: 2, count: 10 });
        expect(claims()).toEqual([]);
    });

    it("puts back a fresh claim that took a stale one's place between its look and its break", async () => {
        const file = data.file('counter.json');
        const base = await writeVersionedDocument<Counter>(file, { schemaVersion: 1, version: 0, count: 0 }, 0);
        const left = versionClaimPath(file, 2);
        fs.writeFileSync(left, '');
        const old = new Date(Date.now() - VERSION_CLAIM_STALE_MS - 1_000);
        fs.utimesSync(left, old, old);

        const error = await writeVersionedDocument<Counter>(file, { ...base, count: 10 }, base.version, {
            hooks: {
                beforeBreak(claimPath) {
                    // Another writer broke the stale claim first and holds a fresh one now.
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
});

/** The claim files beside the documents, by name. */
function claims(): string[] {
    return fs.readdirSync(data.root).filter((name) => name.includes('.claim-')).sort();
}
