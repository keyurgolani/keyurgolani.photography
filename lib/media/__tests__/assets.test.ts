// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDataRoot, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import type { AssetManifest } from '../../identity/types';
import { VARIANT_FORMATS, VARIANT_WIDTHS } from '../../identity/variants';
import { parseAssetManifest, readAssetManifest, resolveAsset } from '../manifest';
import { assetDir, MediaPathError, mediaFilePath, parseVariantFile } from '../path';

const REF = {
    photoId: 'ph_00000000-0000-4000-8000-000000000001',
    assetRevision: `sha256-${'a'.repeat(64)}`,
    profileId: `p_${'1'.repeat(16)}`,
};
const LQIP = 'data:image/webp;base64,UklGRhoAAABXRUJQ';

let data: TempDataRoot;

afterEach(async () => {
    vi.unstubAllEnvs();
    await data?.cleanup();
});

function manifestFor(ref = REF): AssetManifest {
    const variants = Object.fromEntries(VARIANT_WIDTHS.map((width, index) => [width, Object.fromEntries(VARIANT_FORMATS.map((format) => [
        format, { width: 400 * (index + 1), height: 300 * (index + 1), bytes: 10 + index, sha256: 'b'.repeat(64) },
    ]))])) as AssetManifest['variants'];
    return { schemaVersion: 1, ...ref, variants, lqip: LQIP, createdAt: '2026-01-01T00:00:00.000Z' };
}

/** Write a set whose files have the sizes its manifest claims. */
function writeSet(manifest = manifestFor(), { skip }: { skip?: string } = {}): string {
    const dir = assetDir(manifest, data.root);
    fs.mkdirSync(dir, { recursive: true });
    for (const width of VARIANT_WIDTHS) {
        for (const format of VARIANT_FORMATS) {
            const name = `${width}.${format}`;
            if (name !== skip) fs.writeFileSync(path.join(dir, name), Buffer.alloc(manifest.variants[width][format].bytes));
        }
    }
    fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return dir;
}

describe('mediaFilePath', () => {
    it('names a variant file inside the data root\'s asset store', () => {
        data = createTempDataRoot();
        expect(mediaFilePath(REF, 'w400', 'avif')).toBe(path.join(data.root, 'assets', REF.photoId, REF.assetRevision, REF.profileId, 'w400.avif'));
        expect(assetDir(REF)).toBe(path.join(data.root, 'assets', REF.photoId, REF.assetRevision, REF.profileId));
    });

    it.each([
        ['a photo ID', { ...REF, photoId: '../../etc' }],
        ['an asset revision', { ...REF, assetRevision: 'sha256-..' }],
        ['a profile ID', { ...REF, profileId: 'p_/../../x' }],
    ])('throws for an invalid %s', (_label, ref) => {
        data = createTempDataRoot();
        expect(() => mediaFilePath(ref, 'w400', 'webp')).toThrow(MediaPathError);
    });

    it('throws for an unknown variant or format', () => {
        data = createTempDataRoot();
        expect(() => mediaFilePath(REF, 'w401' as 'w400', 'webp')).toThrow(MediaPathError);
        expect(() => mediaFilePath(REF, 'w400', 'jpg' as 'webp')).toThrow(MediaPathError);
    });

    it('throws when no data root is configured', () => {
        data = createTempDataRoot();
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        vi.stubEnv('NODE_ENV', 'production');
        expect(() => mediaFilePath(REF, 'w400', 'webp')).toThrow(MediaPathError);
    });
});

describe('parseVariantFile', () => {
    it.each([['w400.avif', 'w400', 'avif'], ['w1920.webp', 'w1920', 'webp'], ['w1200.webp', 'w1200', 'webp']])('reads %s', (segment, variant, format) => {
        expect(parseVariantFile(segment)).toEqual({ variant, format });
    });

    it.each(['w401.avif', 'w400.jpg', 'W400.AVIF', 'w400.avif.', '../w400.avif', 'w400%2eavif', 'manifest.json', ''])('refuses %j', (segment) => {
        expect(parseVariantFile(segment)).toBeNull();
    });
});

describe('the asset manifest', () => {
    it('accepts a manifest for the ref it names, and refuses one for another', () => {
        expect(parseAssetManifest(manifestFor(), REF)).toEqual(manifestFor());
        expect(parseAssetManifest(manifestFor(), { ...REF, profileId: `p_${'2'.repeat(16)}` })).toBeNull();
    });

    it.each([
        ['a newer schemaVersion', (manifest: Record<string, unknown>) => ({ ...manifest, schemaVersion: 2 })],
        ['a missing variant', (manifest: Record<string, unknown>) => ({ ...manifest, variants: { ...(manifest.variants as object), w1920: undefined } })],
        ['a bad digest', (manifest: Record<string, unknown>) => ({ ...manifest, variants: { ...(manifest.variants as Record<string, object>), w400: { avif: { width: 1, height: 1, bytes: 1, sha256: 'xyz' }, webp: { width: 1, height: 1, bytes: 1, sha256: 'b'.repeat(64) } } } })],
        ['an LQIP that is not a WebP data URI', (manifest: Record<string, unknown>) => ({ ...manifest, lqip: 'https://example.com/x.webp' })],
        ['an unknown field', (manifest: Record<string, unknown>) => ({ ...manifest, sourcePath: 'IMG_1234.jpg' })],
    ])('refuses %s', (_label, change) => {
        expect(parseAssetManifest(change(manifestFor() as unknown as Record<string, unknown>), REF)).toBeNull();
    });
});

describe('resolveAsset', () => {
    it('resolves a complete set as ready, with its manifest', async () => {
        data = createTempDataRoot();
        writeSet();
        expect(await resolveAsset(REF)).toEqual({ state: 'ready', manifest: manifestFor() });
        expect(await readAssetManifest(REF)).toEqual(manifestFor());
    });

    it('reports a set with no manifest as missing', async () => {
        data = createTempDataRoot();
        expect(await resolveAsset(REF)).toEqual({ state: 'unavailable', reason: 'missing' });
    });

    it('reports a variant file that is gone or the wrong size', async () => {
        data = createTempDataRoot();
        writeSet(manifestFor(), { skip: 'w800.webp' });
        expect(await resolveAsset(REF)).toEqual({ state: 'unavailable', reason: 'missing-file' });
        fs.writeFileSync(mediaFilePath(REF, 'w800', 'webp'), Buffer.alloc(3));
        expect(await resolveAsset(REF)).toEqual({ state: 'unavailable', reason: 'missing-file' });
    });

    it('reports a variant file that is a symlink as missing, even one of the listed size', async () => {
        const elsewhere = createTempDataRoot();
        data = createTempDataRoot();
        try {
            writeSet();
            const copy = elsewhere.file('w800.webp');
            fs.writeFileSync(copy, Buffer.alloc(manifestFor().variants.w800.webp.bytes));
            fs.rmSync(mediaFilePath(REF, 'w800', 'webp'));
            fs.symlinkSync(copy, mediaFilePath(REF, 'w800', 'webp'));
            expect(await resolveAsset(REF)).toEqual({ state: 'unavailable', reason: 'missing-file' });
        } finally {
            await elsewhere.cleanup();
        }
    });

    it('reports a set whose folder, or manifest, is a symlink as missing', async () => {
        const elsewhere = createTempDataRoot();
        data = createTempDataRoot();
        try {
            const dir = writeSet();
            fs.renameSync(dir, elsewhere.file('set'));
            fs.symlinkSync(elsewhere.file('set'), dir);
            expect(await resolveAsset(REF)).toEqual({ state: 'unavailable', reason: 'missing' });
            expect(await readAssetManifest(REF)).toBeNull();

            fs.rmSync(dir);
            writeSet();
            fs.renameSync(path.join(dir, 'manifest.json'), elsewhere.file('manifest.json'));
            fs.symlinkSync(elsewhere.file('manifest.json'), path.join(dir, 'manifest.json'));
            expect(await resolveAsset(REF)).toEqual({ state: 'unavailable', reason: 'missing' });
        } finally {
            await elsewhere.cleanup();
        }
    });

    it('reports a manifest for another set, or unreadable JSON, as invalid', async () => {
        data = createTempDataRoot();
        const dir = writeSet();
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ ...manifestFor(), photoId: 'ph_00000000-0000-4000-8000-000000000002' }));
        expect(await resolveAsset(REF)).toEqual({ state: 'unavailable', reason: 'invalid-manifest' });
        fs.writeFileSync(path.join(dir, 'manifest.json'), '{');
        expect(await resolveAsset(REF)).toEqual({ state: 'unavailable', reason: 'invalid-manifest' });
    });

    it('refuses an invalid ref without touching the disk', async () => {
        data = createTempDataRoot();
        expect(await resolveAsset({ ...REF, photoId: 'IMG_1234' })).toEqual({ state: 'unavailable', reason: 'invalid-ref' });
    });

    it.each(['uninitialized', 'missing'] as const)('reports a data root that is %s', async (state) => {
        data = createTempDataRoot({ state });
        expect(await resolveAsset(REF)).toEqual({ state: 'unavailable', reason: 'data-root' });
    });

    it('reads one data root it is given instead of the configured one', async () => {
        data = createTempDataRoot();
        writeSet();
        const other = createTempDataRoot();
        try {
            expect(await resolveAsset(REF)).toEqual({ state: 'unavailable', reason: 'missing' });
            expect(await resolveAsset(REF, { root: data.root })).toMatchObject({ state: 'ready' });
        } finally {
            await other.cleanup();
        }
    });
});
