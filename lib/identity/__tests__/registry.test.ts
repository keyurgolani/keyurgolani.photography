// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordDirectorySyncs } from '../../../test/helpers/directorySyncs';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { emptyStatCache, identityPaths, readRegistry, writeRegistry, writeStatCache } from '../registry';
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
