// @vitest-environment node
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { runTsx } from '../../../test/helpers/runTsx';
import { writeDataRootMarker } from '../../../test/helpers/tempDataRoot';
import { buildLegacyManifest, legacyManifestFile, NESTED_REASON, sealLegacyManifest, type LegacyFolder } from '../legacy-derivatives';

// `photos legacy-derivatives` (#15, v2.0.0 A12) vouches for the legacy
// folders scripts/host/legacy-move-aside.sh may move. A name is never enough,
// so it records a folder only when every file in it is one the v1.x pipeline
// wrote for an original the scan sees at the library root, by name, header
// and width, and it only reads the library.

const image = (width: number, format: 'webp' | 'avif') => sharp({ create: { width, height: Math.round(width * 0.75), channels: 3, background: '#406080' } })[format]().toBuffer();
const WEBP = await image(40, 'webp');
const WIDE_WEBP = await image(500, 'webp');
const AVIF = await image(40, 'avif');
const LQIP = `data:image/webp;base64,${WEBP.toString('base64')}`;

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

/** The bytes the v1.x pipeline would have written at `relative`, by its folder. */
function derivative(relative: string): string | Buffer {
    if (relative.startsWith('lqip/')) return LQIP;
    if (relative.startsWith('cache/set-sources/')) return `${JSON.stringify({ source: `${path.basename(relative, '.json')}.jpg` })}\n`;
    return relative.endsWith('.avif') ? AVIF : WEBP;
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

/** Every entry under `dir` with its bytes' digest, size, mtime and mode, symlinks unfollowed. */
function snapshot(dir: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (current: string) => {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            const full = path.join(current, entry.name);
            const stat = fs.lstatSync(full, { bigint: true });
            const relative = path.relative(dir, full);
            if (entry.isSymbolicLink()) out[relative] = `link ${fs.readlinkSync(full)}`;
            else if (entry.isDirectory()) {
                out[relative] = `dir ${stat.mtimeNs}`;
                walk(full);
            } else out[relative] = `${createHash('sha256').update(fs.readFileSync(full)).digest('hex')} ${stat.size} ${stat.mtimeNs} ${stat.mode}`;
        }
    };
    walk(dir);
    return out;
}

describe('buildLegacyManifest', () => {
    it('vouches for folders holding only what the v1.x pipeline wrote for root originals, with every file, size and mtime', async () => {
        const lib = library(tempRoot());
        for (const relative of ['thumbnails/a.webp', 'thumbnails/b.webp', 'thumbnails-avif/a.avif', 'lqip/b.txt', 'cache/dynamic/a-800-75.webp', 'cache/dynamic/b-1200-60.avif', 'cache/set-sources/a.json']) {
            write(path.join(lib, relative), derivative(relative));
        }
        write(path.join(lib, 'cache', 'set-sources', 'b.json'), '{"source":"b.png","complete":false}\n');
        write(path.join(lib, 'cache', 'upright-rebuild.json'), `${JSON.stringify({ rebuiltAt: '2026-01-02T03:04:05.000Z', photos: 2, retry: ['a.jpg'] }, null, 2)}\n`);
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
            files: [{ path: 'a.webp', size: WEBP.length, mtime: 1_700_000_123 }, { path: 'b.webp', size: WEBP.length, mtime: expect.any(Number) }],
            dirs: [],
        });
        expect(manifest.folders[3]).toMatchObject({ name: 'cache', moves: true, dirs: ['dynamic', 'set-sources'] });
    });

    it('records only names the root lists exactly, case-sensitively', async () => {
        const lib = library(tempRoot());
        write(path.join(lib, 'Medium', 'portrait.jpg'));
        write(path.join(lib, 'Cache', 'dynamic', 'a-400-75.webp'), WEBP);
        write(path.join(lib, 'THUMBNAILS', 'a.webp'), WEBP);
        expect((await buildLegacyManifest(lib)).folders).toEqual([]);
    });

    it.each([
        ['an original among the derivatives', 'medium', ['medium/a.webp', 'medium/portrait.jpg'], "medium/portrait.jpg has an original's extension"],
        ['a RAW file', 'optimized', ['optimized/a.webp', 'optimized/a.cr3'], "has an original's extension"],
        ['a derivative of no original at all', 'thumbnails', ['thumbnails/zzz.webp'], 'names no original (zzz)'],
        ['another case of the extension', 'thumbnails', ['thumbnails/a.WEBP'], 'named for an original'],
        ['the wrong derivative extension', 'medium-avif', ['medium-avif/a.webp'], "has an original's extension"],
        ['a stray note', 'lqip', ['lqip/a.txt', 'lqip/notes.md'], 'named for an original'],
        ['a marker-looking file', 'optimized', ['optimized/a.webp', 'optimized/legacy-derivatives.json'], 'named for an original'],
        ['a dot-file', 'thumbnails', ['thumbnails/a.webp', 'thumbnails/.DS_Store'], 'named for an original'],
        ['a subfolder', 'thumbnails', ['thumbnails/a.webp', 'thumbnails/sub/a.webp'], 'is a folder'],
        ['a file directly in cache/', 'cache', ['cache/a-400-75.webp'], "isn't in cache/dynamic/ or cache/set-sources/"],
        ['another JSON file directly in cache/', 'cache', ['cache/legacy-derivatives.json'], "isn't in cache/dynamic/ or cache/set-sources/"],
        ['another subfolder of cache/', 'cache', ['cache/dynamic/a-400-75.webp', 'cache/other/a-400-75.webp'], 'is a folder'],
        ['a cache file of another shape', 'cache', ['cache/dynamic/a-401-75.webp'], "isn't named as the old image route's cache"],
        ["a JPEG cache file, an original's extension", 'cache', ['cache/dynamic/a-400-75.jpeg'], "has an original's extension"],
        ['a set record for an original in a series', 'cache', ['cache/set-sources/c.json'], NESTED_REASON],
        ['a set record of no original', 'cache', ['cache/set-sources/zzz.json'], 'names no original (zzz)'],
    ])('says a folder stays for %s', async (_label, name, files, reason) => {
        const lib = library(tempRoot());
        for (const file of files) write(path.join(lib, file), derivative(file));
        const folder = (await folders(lib))[name];
        expect(folder).toMatchObject({ name, moves: false });
        expect(folder.moves === false && folder.reason).toContain(reason);
    });

    it.each([
        ['a WebP that is not one', 'thumbnails/a.webp', Buffer.from('RIFF\0\0\0\0WEBPjunkjunkjunkjunkjunkjunk'), "thumbnails/a.webp isn't a valid WebP file"],
        ['random bytes as a WebP', 'medium/a.webp', Buffer.alloc(200, 7), "medium/a.webp isn't a valid WebP file"],
        ['a WebP wider than the folder', 'thumbnails/a.webp', WIDE_WEBP, 'thumbnails/a.webp is 500 px wide, and the pipeline wrote it at most 400 px wide'],
        ['random bytes as an AVIF', 'optimized-avif/a.avif', Buffer.alloc(200, 7), "optimized-avif/a.avif isn't a valid AVIF file"],
        ['a WebP as an AVIF', 'thumbnails-avif/a.avif', WEBP, "isn't a valid AVIF file"],
        ['a cache file wider than its name', 'cache/dynamic/a-400-75.webp', WIDE_WEBP, 'is 500 px wide, and the pipeline wrote it at most 400 px wide'],
        ['an LQIP that is no data URL', 'lqip/a.txt', 'hello', "lqip/a.txt doesn't start with data:image/"],
        ['a set record that is no JSON', 'cache/set-sources/a.json', 'not json', "cache/set-sources/a.json isn't a set record the v1.x pipeline wrote"],
        ['a set record with another field', 'cache/set-sources/a.json', '{"source":"a.jpg","owner":"me"}', "isn't a set record"],
        ['a set record for another source', 'cache/set-sources/a.json', '{"source":"b.png"}', "isn't a set record"],
        ['an upright marker with another field', 'cache/upright-rebuild.json', '{"rebuiltAt":"2026-01-02T03:04:05.000Z","photos":2,"owner":"me"}', "cache/upright-rebuild.json isn't the marker the v1.x pipeline wrote"],
        ['an upright marker with a count that is no count', 'cache/upright-rebuild.json', '{"rebuiltAt":"2026-01-02T03:04:05.000Z","photos":-1}', "isn't the marker"],
        ['an upright marker with no time', 'cache/upright-rebuild.json', '{"photos":2}', "isn't the marker"],
        ['an upright marker with an empty retry list', 'cache/upright-rebuild.json', '{"rebuiltAt":"2026-01-02T03:04:05.000Z","photos":2,"retry":[]}', "isn't the marker"],
        ['an upright marker that is no JSON', 'cache/upright-rebuild.json', 'done', "isn't the marker"],
    ])('says a folder stays for %s, by its content', async (_label, relative, bytes, reason) => {
        const lib = library(tempRoot());
        write(path.join(lib, relative), bytes);
        const name = relative.split('/')[0];
        const folder = (await folders(lib))[name];
        expect(folder).toMatchObject({ name, moves: false });
        expect(folder.moves === false && folder.reason).toContain(reason);
    });

    it('says, in the ruling\'s words, that a folder of derivatives of nested originals stays', async () => {
        const lib = library(tempRoot());
        write(path.join(lib, 'thumbnails', 'a.webp'), WEBP);
        write(path.join(lib, 'thumbnails', 'c.webp'), WEBP);
        expect((await folders(lib)).thumbnails).toEqual({ name: 'thumbnails', moves: false, reason: 'its originals are nested, so nothing vouches for it' });
    });

    it('says when a name differs from an original only in Unicode form', async () => {
        const lib = path.join(tempRoot(), 'photos');
        // The original's name in NFC, the derivative's in NFD: the same letters, other bytes.
        write(path.join(lib, 'caf\u00e9.jpg'), Buffer.alloc(64, 1));
        write(path.join(lib, 'thumbnails', 'cafe\u0301.webp'), WEBP);
        // A disk that normalizes names on write makes the two one name, and then the folder moves.
        if (fs.readdirSync(path.join(lib, 'thumbnails'))[0] !== 'cafe\u0301.webp') return;
        const folder = (await folders(lib)).thumbnails;
        expect(folder.moves === false && folder.reason).toMatch(/in another Unicode form \(NFC and NFD differ\)/);
    });

    it('keeps control characters out of a reason', async () => {
        const lib = library(tempRoot());
        write(path.join(lib, 'thumbnails', 'a\u0007\tb.webp'), WEBP);
        const folder = (await folders(lib)).thumbnails;
        expect(folder.moves === false && folder.reason).toContain('thumbnails/a??b.webp');
    });

    it('says a folder stays when it, or anything in it, is a symlink, or it holds nothing', async () => {
        const root = tempRoot();
        const lib = library(root);
        write(path.join(root, 'elsewhere', 'a.webp'), WEBP);
        fs.symlinkSync(path.join(root, 'elsewhere'), path.join(lib, 'optimized'));
        write(path.join(lib, 'thumbnails', 'a.webp'), WEBP);
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
    /** A ready data root and a library with one folder that moves and one that stays. */
    function setUp() {
        const root = tempRoot();
        const lib = library(root);
        write(path.join(lib, 'thumbnails', 'a.webp'), WEBP);
        write(path.join(lib, 'medium', 'portrait.jpg'));
        const dataRoot = path.join(root, 'data');
        fs.mkdirSync(dataRoot, { mode: 0o700 });
        writeDataRootMarker(dataRoot);
        return { root, lib, dataRoot, env: { PHOTOGRAPHY_DATA_DIR: dataRoot, PHOTOGRAPHY_LIBRARY_DIR: lib } };
    }

    it('only reads the library, and writes only status/legacy-derivatives.json in the data root, readable by all', async () => {
        const { lib, dataRoot, env } = setUp();
        const libraryBefore = snapshot(lib);
        const dataBefore = snapshot(dataRoot);
        const result = await runTsx('scripts/photos.ts', ['legacy-derivatives'], { env });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toMatch(/^ {2}thumbnails moves aside: 1 file$/m);
        expect(result.stdout).toMatch(/^ {2}medium stays: medium\/portrait\.jpg has an original's extension$/m);
        expect(snapshot(lib)).toEqual(libraryBefore);
        const dataAfter = snapshot(dataRoot);
        expect(Object.keys(dataAfter).filter((entry) => !(entry in dataBefore)).sort()).toEqual(['status', path.join('status', 'legacy-derivatives.json')]);
        const file = legacyManifestFile(dataRoot);
        expect(fs.statSync(file).mode & 0o777).toBe(0o644);
        const sealed = JSON.parse(fs.readFileSync(file, 'utf8')) as { manifest: string };
        expect(JSON.parse(sealed.manifest).folders.map((folder: LegacyFolder) => folder.name)).toEqual(['thumbnails', 'medium']);
    }, 30_000);

    it('with --stdout prints exactly the manifest it wrote, and the summary on stderr', async () => {
        const { dataRoot, env } = setUp();
        const result = await runTsx('scripts/photos.ts', ['legacy-derivatives', '--stdout'], { env });
        expect(result.code, result.stderr).toBe(0);
        expect(result.stdout).toBe(fs.readFileSync(legacyManifestFile(dataRoot), 'utf8'));
        expect(result.stderr).toMatch(/thumbnails moves aside/);
        expect(result.stdout).not.toMatch(/moves aside/);
    }, 30_000);

    it('refuses a symlinked status/ and writes nothing through it', async () => {
        const { root, dataRoot, env } = setUp();
        const elsewhere = path.join(root, 'elsewhere');
        fs.mkdirSync(elsewhere);
        fs.symlinkSync(elsewhere, path.join(dataRoot, 'status'));
        const result = await runTsx('scripts/photos.ts', ['legacy-derivatives'], { env });
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/status\/ is a symlink[\s\S]*Nothing was written/);
        expect(fs.readdirSync(elsewhere)).toEqual([]);
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
