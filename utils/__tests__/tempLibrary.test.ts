// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { assertOutsidePublic, createTempLibrary, setLibraryDir } from '../../test/helpers/tempLibrary';

const PUBLIC_DIR = fileURLToPath(new URL('../../public', import.meta.url));

describe('tempLibrary', () => {
    it('refuses any library inside public/', () => {
        const before = process.env.PHOTOGRAPHY_LIBRARY_DIR;
        for (const dir of [PUBLIC_DIR, path.join(PUBLIC_DIR, 'assets/photos'), path.join(PUBLIC_DIR, 'assets/photos/not-yet-created')]) {
            expect(() => setLibraryDir(dir), dir).toThrow(/inside .*public/);
        }
        expect(process.env.PHOTOGRAPHY_LIBRARY_DIR).toBe(before);
    });

    it('refuses a symlink that resolves inside public/', () => {
        const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'photography-link-'));
        try {
            fs.symlinkSync(path.join(PUBLIC_DIR, 'assets/photos'), path.join(parent, 'library'));
            expect(() => assertOutsidePublic(path.join(parent, 'library'))).toThrow(/inside .*public/);
        } finally {
            fs.rmSync(parent, { recursive: true, force: true });
        }
    });

    it('points PHOTOGRAPHY_LIBRARY_DIR at a fresh temp root and restores it on cleanup', async () => {
        const before = process.env.PHOTOGRAPHY_LIBRARY_DIR;
        const lib = await createTempLibrary({ fixtures: 'basic' });

        expect(process.env.PHOTOGRAPHY_LIBRARY_DIR).toBe(lib.root);
        expect(fs.realpathSync(lib.root).startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
        expect(fs.readdirSync(lib.root).sort()).toEqual(['landscape.jpg', 'portrait.png', 'square.webp']);

        await lib.cleanup();
        expect(process.env.PHOTOGRAPHY_LIBRARY_DIR).toBe(before);
        expect(fs.existsSync(lib.root)).toBe(false);
    });

    it('keeps PHOTOGRAPHY_LIBRARY_DIR on the temp root until the delete is done', async () => {
        const lib = await createTempLibrary();
        const seen: (string | undefined)[] = [];
        const realRm = fs.promises.rm.bind(fs.promises);
        const rm = vi.spyOn(fs.promises, 'rm').mockImplementation(async (...args: Parameters<typeof fs.promises.rm>) => {
            seen.push(process.env.PHOTOGRAPHY_LIBRARY_DIR);
            return realRm(...args);
        });

        try {
            await lib.cleanup();
        } finally {
            rm.mockRestore();
        }

        expect(seen).toEqual([lib.root]);
    });
});
