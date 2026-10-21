// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { keyOf, LibraryRootMissingError, scanLibrary } from '../scan';

const isRoot = process.getuid?.() === 0;
let lib: TempLibrary;

beforeEach(async () => {
    lib = await createTempLibrary();
});

afterEach(async () => {
    await lib.cleanup();
});

function write(...relativePaths: string[]): void {
    for (const relativePath of relativePaths) {
        fs.mkdirSync(path.dirname(lib.file(relativePath)), { recursive: true });
        fs.writeFileSync(lib.file(relativePath), `bytes of ${relativePath}`);
    }
}

describe('scanLibrary', () => {
    it('scans sources at any depth and skips legacy outputs, dot-entries, symlinks, and other files', async () => {
        write(
            'cache-1.jpg', 'medium-format.jpg', 'series/thumbnails/x.jpg', 'series/cache/y.png', 'UPPER.JPG', 'a.jpeg', 'b.png', 'c.webp',
            'thumbnails/x.webp', 'medium/x.webp', 'optimized/x.webp', 'thumbnails-avif/x.avif', 'medium-avif/x.avif', 'optimized-avif/x.avif',
            'lqip/x.txt', 'cache/x.jpg', 'cache/dynamic/x.webp', '._x.jpg', '.portfolio/state.jpg', 'series/._z.jpg', 'README.md', 'notes/plan.txt',
            'raw/DSC_0001.NEF', 'raw/IMG_0002.heic', 'raw/scan.TIFF',
        );
        fs.symlinkSync(lib.file('cache-1.jpg'), lib.file('link.jpg'));
        fs.symlinkSync(lib.file('series'), lib.file('linked-series'));

        const scan = await scanLibrary(lib.root, { clock: () => 1_234 });

        expect(scan.observedAt).toBe(1_234);
        expect(scan.unreadableDirs).toEqual([]);
        expect(scan.entries.map((entry) => [entry.path, entry.kind])).toEqual([
            ['UPPER.JPG', 'source'],
            ['a.jpeg', 'source'],
            ['b.png', 'source'],
            ['c.webp', 'source'],
            ['cache-1.jpg', 'source'],
            ['medium-format.jpg', 'source'],
            ['raw/DSC_0001.NEF', 'unsupported'],
            ['raw/IMG_0002.heic', 'unsupported'],
            ['raw/scan.TIFF', 'unsupported'],
            ['series/cache/y.png', 'source'],
            ['series/thumbnails/x.jpg', 'source'],
        ]);
        const entry = scan.entries.find((candidate) => candidate.path === 'cache-1.jpg');
        const stat = fs.lstatSync(lib.file('cache-1.jpg'));
        expect(entry).toMatchObject({ key: 'cache-1.jpg', size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino });
    });

    it('keys paths by their folded form, as a case-insensitive disk compares them', () => {
        expect(keyOf('Series/IMG_0001.JPG')).toBe('series/img_0001.jpg');
        expect(keyOf('Café/Crème.jpg')).toBe('café/crème.jpg');
        expect(keyOf('café/crème.jpg'.normalize('NFD'))).toBe(keyOf('café/crème.jpg'));
        // As APFS folds them: the sharp s and its capital to ss, and the long s to s
        expect(keyOf('Straße.jpg')).toBe('strasse.jpg');
        expect(keyOf('STRAẞE.jpg')).toBe('strasse.jpg');
        expect(keyOf('Caſe.jpg')).toBe('case.jpg');
    });

    it('throws LibraryRootMissingError for a missing root instead of reporting an empty library', async () => {
        const missing = lib.file('not-mounted');
        await expect(scanLibrary(missing)).rejects.toBeInstanceOf(LibraryRootMissingError);
        expect(fs.existsSync(missing)).toBe(false);
    });

    it.skipIf(isRoot)('records a folder it cannot list and keeps going', async () => {
        write('locked/a.jpg', 'open/b.jpg');
        fs.chmodSync(lib.file('locked'), 0o000);
        try {
            const scan = await scanLibrary(lib.root);
            expect(scan.unreadableDirs).toEqual(['locked']);
            expect(scan.entries.map((entry) => entry.path)).toEqual(['open/b.jpg']);
        } finally {
            fs.chmodSync(lib.file('locked'), 0o755);
        }
    });
});
