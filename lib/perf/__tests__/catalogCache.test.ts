// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { catalogKey, perfCatalog, type CatalogSpec } from '../catalogCache';
import { BUDGET_VARIANT_BYTES } from '../fixture';

// The perf run's catalog cache (catalogCache.ts), on a 3-photo catalog: built once and copied per run.

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-catalog-cache-'));
const cache = path.join(work, 'cache');
const spec: CatalogSpec = { photos: 3, seed: 6, variantBytes: BUDGET_VARIANT_BYTES, code: 'tree-a' };
const files = (root: string): string[] =>
    fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name))).sort();

afterAll(() => {
    // Nothing is deleted on a machine with a Trash: the test's folder goes there. CI's runner is thrown away whole.
    const trash = path.join(os.homedir(), '.Trash');
    try {
        if (fs.existsSync(trash)) fs.renameSync(work, path.join(trash, `${path.basename(work)}-${Date.now()}`));
        else if (process.env.CI) fs.rmSync(work, { recursive: true, force: true });
    } catch {
        // On another volume than the Trash: it stays where it is.
    }
});

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
    it('builds the catalog once, then copies the same published root for every run', async () => {
        const first = await perfCatalog(spec, path.join(work, 'run-1'), cache);
        expect(first.from).toBe('built');
        const second = await perfCatalog(spec, path.join(work, 'run-2'), cache);
        expect(second.from).toBe('cache');
        expect(second.slug).toBe(first.slug);
        // The same files, with the same sizes: the published revision, its pointer and the sparse variants.
        expect(files(second.root)).toEqual(files(first.root));
        expect(files(first.root).some((file) => file.startsWith(`catalog${path.sep}active`))).toBe(true);
        for (const file of files(first.root)) expect(fs.statSync(path.join(second.root, file)).size).toBe(fs.statSync(path.join(first.root, file)).size);
        // One entry under the key, with nothing half built beside it.
        expect(fs.readdirSync(cache)).toEqual([catalogKey(spec)]);
        // A run's writes stay in its copy.
        fs.writeFileSync(path.join(second.root, 'written-by-a-run'), 'x');
        expect(fs.existsSync(path.join(cache, catalogKey(spec)!, 'data', 'written-by-a-run'))).toBe(false);
    }, 60_000);

    it('builds straight into the run, and keeps nothing, when the code version is unknown', async () => {
        const run = await perfCatalog({ ...spec, code: null }, path.join(work, 'run-uncached'), path.join(work, 'unused-cache'));
        expect(run.from).toBe('built');
        expect(fs.existsSync(path.join(work, 'unused-cache'))).toBe(false);
        expect(fs.existsSync(path.join(run.root, 'catalog', 'active'))).toBe(true);
    }, 60_000);
});
