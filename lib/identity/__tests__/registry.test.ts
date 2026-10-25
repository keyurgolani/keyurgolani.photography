// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordDirectorySyncs } from '../../../test/helpers/directorySyncs';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { emptyStatCache, identityPaths, readRegistry, writeRegistry, writeStatCache } from '../registry';
import { CorruptDocumentError } from '../../storage/document';
import { identityStatus } from '../status';
import { emptyRegistry } from '../types';

let data: TempDataRoot | undefined;

afterEach(async () => {
    vi.restoreAllMocks();
    await data?.cleanup();
    data = undefined;
});

describe('writeRegistry', () => {
    it('fsyncs every folder its first version needs up to the data root, though the stat cache made identity/ first', async () => {
        data = createTempDataRoot({ state: 'ready' });
        const paths = identityPaths(data.root);
        await writeStatCache(data.root, emptyStatCache());
        const synced = recordDirectorySyncs();
        await writeRegistry(data.root, emptyRegistry(), 0);
        expect(synced).toEqual([data.root, paths.registry, paths.dir]);
        expect((await readRegistry(data.root)).version).toBe(1);
    });
});

describe('readRegistry', () => {
    it('refuses a registry.json in the old layout, naming it, rather than read an empty registry and mint new IDs', async () => {
        data = createTempDataRoot({ state: 'ready' });
        const paths = identityPaths(data.root);
        fs.mkdirSync(paths.dir);
        const old = path.join(paths.dir, 'registry.json');
        fs.writeFileSync(old, JSON.stringify({ ...emptyRegistry(), version: 3 }));
        const error = await readRegistry(data.root).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(CorruptDocumentError);
        expect(error).toMatchObject({ file: old, message: expect.stringContaining('layout changed') });
        expect((await identityStatus()).registryError).toContain('identity/registry.json');

        // Beside the new folder too, since nothing says which one is current.
        await writeRegistry(data.root, emptyRegistry(), 0);
        await expect(readRegistry(data.root)).rejects.toMatchObject({ file: old });
        fs.rmSync(old);
        expect((await readRegistry(data.root)).version).toBe(1);
    });
});
