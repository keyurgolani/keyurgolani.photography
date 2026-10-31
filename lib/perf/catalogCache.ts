import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publish } from '../catalog/publish';
import { createTestCatalog, type VariantByteTable } from '../catalog/testing';
import { isReadOnly, makeReadOnly } from './runFiles';

/**
 * The perf run's published catalog, built once and served from the cache (e2e/themes/surround-perf.spec.ts). Building
 * and publishing 5,000 photographs is most of the run's setup, and under load it took perf4 past its cap, so the
 * published data root is kept in a cache folder outside the repository, keyed by everything that shapes it: the photo
 * count, the seed, the variant sizes, and the catalog code that writes and publishes it.
 *
 * The servers read the cache entry in place, marked read-only, and nothing copies it: its variant files are sparse, and
 * a copy that can't clone writes them out whole (the 2026-10-31 disk fill, notes/photo-perf-scroll/disk-0704.md). A
 * server that writes to its data root fails on the read-only entry; that's a run that needs a writable root, and it
 * should fail and say so, not fall back to a copy. Nothing in the cache is ever deleted; a new key is a new folder.
 */

export interface CatalogSpec {
    photos: number;
    seed: number;
    variantBytes: VariantByteTable;
    /** The catalog code's version, or null when it can't be named (uncommitted edits): then nothing is cached. */
    code: string | null;
}

export interface PerfCatalog {
    /** The data root to serve: the cache entry's, read-only, or the run's scratch one when nothing is cached. */
    root: string;
    /** The one series' slug. */
    slug: string;
    /** Whether this run built the cache entry, found it, or built an uncached catalog in its scratch folder. */
    from: 'built' | 'cache' | 'uncached';
}

/** The git tree of `lib/catalog` at HEAD, or null if it has uncommitted changes or there's no git. */
export function catalogCodeVersion(repo: string): string | null {
    const dirty = spawnSync('git', ['status', '--porcelain', '--', 'lib/catalog'], { cwd: repo, encoding: 'utf8' });
    if (dirty.status !== 0 || dirty.stdout.trim() !== '') return null;
    const tree = spawnSync('git', ['rev-parse', 'HEAD:lib/catalog'], { cwd: repo, encoding: 'utf8' });
    return tree.status === 0 ? tree.stdout.trim() : null;
}

/** The cache key for a spec: a hash of every input, or null when the code version is unknown. */
export function catalogKey(spec: CatalogSpec): string | null {
    if (spec.code === null) return null;
    const inputs = JSON.stringify({ photos: spec.photos, seed: spec.seed, variantBytes: spec.variantBytes, code: spec.code });
    return `catalog-${spec.photos}-${createHash('sha256').update(inputs).digest('hex').slice(0, 16)}`;
}

/** Builds and publishes a catalog into `dataRoot` (absent or empty), and returns its series' slug. */
async function build(spec: CatalogSpec, dataRoot: string): Promise<string> {
    const catalog = await createTestCatalog({ photos: spec.photos, series: [{ photos: spec.photos }], seed: spec.seed, root: dataRoot, variantBytes: spec.variantBytes });
    const outcome = await publish({ dataRoot: catalog.root, actor: 'e2e', confirmLaunch: true, logger: { log: () => undefined } });
    if (outcome.outcome !== 'PUBLISHED') throw new Error(`The perf catalog didn't publish: ${outcome.message}`);
    return catalog.series[0].slug;
}

/**
 * The catalog for `spec`: the cache entry in `cacheDir` with this key, built there first when there's none, served in
 * place and read-only. With no key (uncommitted catalog code), it's built into `scratch` (absent), a folder of the
 * run's own that the run removes, and not kept.
 */
export async function perfCatalog(spec: CatalogSpec, cacheDir: string, scratch: string): Promise<PerfCatalog> {
    const key = catalogKey(spec);
    if (key === null) return { root: scratch, slug: await build(spec, scratch), from: 'uncached' };
    const entry = path.join(cacheDir, key);
    const manifest = path.join(entry, 'catalog.json');
    let from: PerfCatalog['from'] = 'cache';
    if (!fs.existsSync(manifest)) {
        from = 'built';
        fs.mkdirSync(cacheDir, { recursive: true });
        // Built aside and moved in whole, so a run that dies midway never leaves a half-built entry under the key.
        const stage = fs.mkdtempSync(path.join(cacheDir, `${key}.building-`));
        const slug = await build(spec, path.join(stage, 'data'));
        fs.writeFileSync(path.join(stage, 'catalog.json'), `${JSON.stringify({ slug, photos: spec.photos, seed: spec.seed, code: spec.code })}\n`);
        makeReadOnly(path.join(stage, 'data'));
        try {
            fs.renameSync(stage, entry);
        } catch {
            // Another run filed the same key first: theirs serves, and this stage stays beside it, unused.
        }
    }
    const { slug } = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { slug: string };
    const data = path.join(entry, 'data');
    // An entry filed before the cache was read-only is marked now.
    if (!isReadOnly(data)) makeReadOnly(data);
    return { root: data, slug, from };
}

/** Where the cache lives unless PERF_CATALOG_CACHE says otherwise: outside the repository, under the user's cache. */
export const DEFAULT_CATALOG_CACHE = path.join(os.homedir(), '.cache', 'photography-perf');
