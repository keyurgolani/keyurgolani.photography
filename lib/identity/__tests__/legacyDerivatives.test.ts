// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { writeDataRootMarker } from '../../../test/helpers/tempDataRoot';
import { buildLegacyManifest, legacyManifestFile, sealLegacyManifest, type LegacyFolder } from '../legacy-derivatives';

// `photos legacy-derivatives` (#15, v2.0.0 A12) vouches for the legacy
// folders scripts/host/legacy-move-aside.sh may move. A name is never enough,
// so it records a folder only when every file in it is a derivative of an
// original the scan sees at the library root, and it only reads the library.

const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-manifest-')));
    roots.push(root);
    return root;
}

function write(file: string, bytes: string | Buffer = 'x'): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
}

/** A library with originals a.jpg and b.png at its root and c.jpg in a series. */
function library(root: string): string {
    const lib = path.join(root, 'photos');
    write(path.join(lib, 'a.jpg'), Buffer.alloc(64, 1));
    write(path.join(lib, 'b.png'), Buffer.alloc(64, 2));
    write(path.join(lib, 'trip', 'c.jpg'), Buffer.alloc(64, 3));
    return lib;
}

async function folders(lib: string): Promise<Record<string, LegacyFolder>> {
    return Object.fromEntries((await buildLegacyManifest(lib)).folders.map((folder) => [folder.name, folder]));
}

/** Every entry under `dir` with its bytes' digest, size and mtime, symlinks unfollowed. */
function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            const stat = fs.lstatSync(full, { bigint: true });
            const relative = path.relative(dir, full);
            if (entry.isDirectory()) {
                out[relative] = `dir ${stat.mtimeNs}`;
                walk(full);
            } else out[relative] = `${createHash('sha256').update(fs.readFileSync(full)).digest('hex')} ${stat.size} ${stat.mtimeNs} ${stat.mode}`;
        }
    };
    walk(dir);
    return out;
}

describe('buildLegacyManifest', () => {
    it('vouches for folders holding only derivatives of root originals, with every file, size and mtime', async () => {
        const lib = library(tempRoot());
        write(path.join(lib, 'thumbnails', 'a.webp'), Buffer.alloc(10));
        write(path.join(lib, 'thumbnails', 'b.webp'), Buffer.alloc(20));
        write(path.join(lib, 'thumbnails-avif', 'a.avif'), Buffer.alloc(5));
        write(path.join(lib, 'lqip', 'b.txt'), 'data:');
        write(path.join(lib, 'cache', 'dynamic', 'a-800-75.webp'), Buffer.alloc(7));
        write(path.join(lib, 'cache', 'dynamic', 'b-1200-60.avif'), Buffer.alloc(8));
        fs.utimesSync(path.join(lib, 'thumbnails', 'a.webp'), 1_700_000_000, 1_700_000_123);
        const manifest = await buildLegacyManifest(lib, { clock: () => Date.parse('2026-11-05T03:00:00.000Z') });
        expect(manifest.schemaVersion).toBe(1);
        expect(manifest.writtenAt).toBe('2026-11-05T03:00:00.000Z');
        const stat = fs.statSync(lib, { bigint: true });
        expect(manifest.library).toEqual({ dev: String(stat.dev), ino: String(stat.ino) });
        expect(manifest.folders.map((folder) => folder.name)).toEqual(['thumbnails', 'thumbnails-avif', 'lqip', 'cache']);
        expect(manifest.folders[0]).toEqual({
            name: 'thumbnails',
            moves: true,
            files: [{ path: 'a.webp', size: 10, mtime: 1_700_000_123 }, { path: 'b.webp', size: 20, mtime: expect.any(Number) }],
            dirs: [],
        });
        expect(manifest.folders[3]).toMatchObject({ name: 'cache', moves: true, dirs: ['dynamic'] });
    });

    it('records only names the root lists exactly, case-sensitively', async () => {
        const lib = library(tempRoot());
        write(path.join(lib, 'Medium', 'portrait.jpg'));
        write(path.join(lib, 'Cache', 'dynamic', 'a-400-75.webp'));
        write(path.join(lib, 'THUMBNAILS', 'a.webp'));
        expect((await buildLegacyManifest(lib)).folders).toEqual([]);
    });

    it.each([
        ['an original among the derivatives', 'medium', ['medium/a.webp', 'medium/portrait.jpg'], "has an original's extension"],
        ['a RAW file', 'optimized', ['optimized/a.webp', 'optimized/a.cr3'], "has an original's extension"],
        ['a derivative of an original in a series, not at the root', 'thumbnails', ['thumbnails/c.webp'], 'names no original at the library root'],
        ['a derivative of no original at all', 'thumbnails', ['thumbnails/zzz.webp'], 'names no original at the library root'],
        ['another case of the extension', 'thumbnails', ['thumbnails/a.WEBP'], 'named for an original'],
        ['the wrong derivative extension', 'medium-avif', ['medium-avif/a.webp'], "has an original's extension"],
        ['a stray note', 'lqip', ['lqip/a.txt', 'lqip/notes.md'], 'named for an original'],
        ['a marker-looking file', 'optimized', ['optimized/a.webp', 'optimized/legacy-derivatives.json'], 'named for an original'],
        ['a dot-file', 'thumbnails', ['thumbnails/a.webp', 'thumbnails/.DS_Store'], 'named for an original'],
        ['a subfolder', 'thumbnails', ['thumbnails/a.webp', 'thumbnails/sub/a.webp'], 'is a folder'],
        ['a file directly in cache/', 'cache', ['cache/a-400-75.webp'], "isn't in cache/dynamic/"],
        ['another subfolder of cache/', 'cache', ['cache/dynamic/a-400-75.webp', 'cache/other/a-400-75.webp'], 'is a folder'],
        ['a cache file of another shape', 'cache', ['cache/dynamic/a-401-75.webp'], "isn't named as the old image route's cache"],
        ['a JPEG cache file, an original\'s extension', 'cache', ['cache/dynamic/a-400-75.jpeg'], "has an original's extension"],
    ])('says a folder stays for %s', async (_label, name, files, reason) => {
        const lib = library(tempRoot());
        for (const file of files) write(path.join(lib, file));
        const folder = (await folders(lib))[name];
        expect(folder).toMatchObject({ name, moves: false });
        expect(folder.moves === false && folder.reason).toContain(reason);
    });

    it('says a folder stays when it, or anything in it, is a symlink, or it holds nothing', async () => {
        const root = tempRoot();
        const lib = library(root);
        write(path.join(root, 'elsewhere', 'a.webp'));
        fs.symlinkSync(path.join(root, 'elsewhere'), path.join(lib, 'optimized'));
        write(path.join(lib, 'thumbnails', 'a.webp'));
        fs.symlinkSync(path.join(root, 'elsewhere', 'a.webp'), path.join(lib, 'thumbnails', 'b.webp'));
        fs.mkdirSync(path.join(lib, 'lqip'));
        write(path.join(lib, 'medium'));
        const found = await folders(lib);
        expect(found.optimized).toEqual({ name: 'optimized', moves: false, reason: 'optimized is a symlink' });
        expect(found.thumbnails).toEqual({ name: 'thumbnails', moves: false, reason: 'thumbnails/b.webp is a symlink' });
        expect(found.lqip).toEqual({ name: 'lqip', moves: false, reason: 'lqip holds no derivative' });
        expect(found.medium).toEqual({ name: 'medium', moves: false, reason: "medium isn't a folder" });
    });

    it('seals the manifest as a string whose sha256 is its digest', async () => {
        const manifest = await buildLegacyManifest(library(tempRoot()));
        const sealed = JSON.parse(sealLegacyManifest(manifest)) as { schemaVersion: number; digest: string; manifest: string };
        expect(sealed.schemaVersion).toBe(1);
        expect(sealed.digest).toBe(`sha256:${createHash('sha256').update(sealed.manifest, 'utf8').digest('hex')}`);
        expect(JSON.parse(sealed.manifest)).toEqual(manifest);
    });
});

describe('photos legacy-derivatives', () => {
    it('only reads the library, and writes only status/legacy-derivatives.json in the data root', async () => {
        const root = tempRoot();
        const lib = library(root);
        write(path.join(lib, 'thumbnails', 'a.webp'));
        write(path.join(lib, 'medium', 'portrait.jpg'));
        const dataRoot = path.join(root, 'data');
        fs.mkdirSync(dataRoot, { mode: 0o700 });
        writeDataRootMarker(dataRoot);
        const libraryBefore = snapshot(lib);
        const dataBefore = snapshot(dataRoot);
        const result = await runTsx('scripts/photos.ts', ['legacy-derivatives'], { env: { PHOTOGRAPHY_DATA_DIR: dataRoot, PHOTOGRAPHY_LIBRARY_DIR: lib } });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toMatch(/thumbnails: moves aside, 1 file/);
        expect(result.stdout).toMatch(/medium: stays, because medium\/portrait\.jpg has an original's extension/);
        expect(snapshot(lib)).toEqual(libraryBefore);
        const dataAfter = snapshot(dataRoot);
        expect(Object.keys(dataAfter).filter((entry) => !(entry in dataBefore)).sort()).toEqual(['status', path.join('status', 'legacy-derivatives.json')]);
        const file = legacyManifestFile(dataRoot);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        const sealed = JSON.parse(fs.readFileSync(file, 'utf8')) as { manifest: string };
        expect(JSON.parse(sealed.manifest).folders.map((folder: LegacyFolder) => folder.name)).toEqual(['thumbnails', 'medium']);
    }, 30_000);

    it('exits 1 and writes nothing on a data root that is not ready, and 2 on an argument', async () => {
        const root = tempRoot();
        const lib = library(root);
        // Only temp folders: an unset PHOTOGRAPHY_DATA_DIR would mean portfolio-data under the repository.
        const empty = path.join(root, 'empty');
        fs.mkdirSync(empty);
        const notReady = await runTsx('scripts/photos.ts', ['legacy-derivatives'], { env: { PHOTOGRAPHY_DATA_DIR: empty, PHOTOGRAPHY_LIBRARY_DIR: lib } });
        expect(notReady.code).toBe(1);
        expect(fs.readdirSync(empty)).toEqual([]);
        const usage = await runTsx('scripts/photos.ts', ['legacy-derivatives', '--apply'], { env: { PHOTOGRAPHY_DATA_DIR: empty, PHOTOGRAPHY_LIBRARY_DIR: lib } });
        expect(usage.code).toBe(2);
    }, 30_000);
});
