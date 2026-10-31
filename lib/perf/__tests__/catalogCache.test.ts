// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { catalogKey, perfCatalog, type CatalogSpec } from '../catalogCache';
import { BUDGET_VARIANT_BYTES } from '../fixture';
import { isReadOnly, makeRunTemp, removeRunTemp } from '../runFiles';

// The perf run's catalog cache (catalogCache.ts), on a 3-photo catalog: built once, then served in place, read-only.

const work = makeRunTemp('catalog-cache-test-');
const cache = path.join(work, 'cache');
const spec: CatalogSpec = { photos: 3, seed: 6, variantBytes: BUDGET_VARIANT_BYTES, code: 'tree-a' };
const files = (root: string): string[] =>
    fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name))).sort();

// The test's own temp folder, read-only cache entry and all, removed in place.
afterAll(() => removeRunTemp(work));

describe('catalogKey', () => {
    it('changes with every input, and is null when the code version is unknown', () => {
        const key = catalogKey(spec);
        expect(key).toMatch(/^catalog-3-[0-9a-f]{16}$/);
        expect(catalogKey({ ...spec })).toBe(key);
        for (const other of [{ ...spec, photos: 4 }, { ...spec, seed: 7 }, { ...spec, code: 'tree-b' }, { ...spec, variantBytes: { ...spec.variantBytes, w400: { avif: 1, webp: 1 } } }]) {
            expect(catalogKey(other)).not.toBe(key);
        }
        expect(catalogKey({ ...spec, code: null })).toBeNull();
    });
});

describe('perfCatalog', () => {
    it('builds the catalog once, then serves the same cache entry, read-only and uncopied, to every run', async () => {
        const first = await perfCatalog(spec, cache, path.join(work, 'scratch-1'));
        expect(first.from).toBe('built');
        const second = await perfCatalog(spec, cache, path.join(work, 'scratch-2'));
        expect(second.from).toBe('cache');
        expect(second.slug).toBe(first.slug);
        // Both serve the cache entry itself: nothing was copied, and no scratch folder was made.
        expect(second.root).toBe(path.join(cache, catalogKey(spec)!, 'data'));
        expect(first.root).toBe(second.root);
        expect(fs.existsSync(path.join(work, 'scratch-1')) || fs.existsSync(path.join(work, 'scratch-2'))).toBe(false);
        expect(files(first.root).some((file) => file.startsWith(`catalog${path.sep}active`))).toBe(true);
        // One entry under the key, with nothing half built beside it.
        expect(fs.readdirSync(cache)).toEqual([catalogKey(spec)]);
        // Read-only, so a server that writes to its data root fails instead of changing the cache.
        expect(isReadOnly(second.root)).toBe(true);
        expect(() => fs.writeFileSync(path.join(second.root, 'written-by-a-run'), 'x')).toThrow(/EACCES|EPERM/);
        for (const file of files(second.root)) expect(fs.statSync(path.join(second.root, file)).mode & 0o222).toBe(0);
    }, 60_000);

    it('marks an entry filed before the cache was read-only', async () => {
        const data = path.join(cache, catalogKey(spec)!, 'data');
        fs.chmodSync(data, 0o755);
        expect(isReadOnly(data)).toBe(false);
        expect((await perfCatalog(spec, cache, path.join(work, 'scratch-3'))).from).toBe('cache');
        expect(isReadOnly(data)).toBe(true);
    }, 60_000);

    it("builds into the run's scratch folder, and keeps nothing, when the code version is unknown", async () => {
        const run = await perfCatalog({ ...spec, code: null }, path.join(work, 'unused-cache'), path.join(work, 'scratch-uncached'));
        expect(run.from).toBe('uncached');
        expect(run.root).toBe(path.join(work, 'scratch-uncached'));
        expect(fs.existsSync(path.join(work, 'unused-cache'))).toBe(false);
        expect(fs.existsSync(path.join(run.root, 'catalog', 'active'))).toBe(true);
    }, 60_000);
});
