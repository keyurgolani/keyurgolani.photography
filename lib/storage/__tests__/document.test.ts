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
});
