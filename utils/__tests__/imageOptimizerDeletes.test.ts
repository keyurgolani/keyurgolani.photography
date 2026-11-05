// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { libraryPaths, processImage, writeVariants } from '../imageOptimizer';

// The legacy v1.x pipeline (#15, v2.0.0 A12) deletes nothing but the temp
// files it staged itself: not the old image route's cache in cache/dynamic,
// and not a set's record in cache/set-sources. Only e2e/support/carry-over.ts
// still runs it, on a temp library, and it needs neither delete.

const SOURCE = fs.readFileSync(fileURLToPath(new URL('../imageOptimizer.ts', import.meta.url)), 'utf8');

const roots: string[] = [];
afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function library(): Promise<string> {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-pipeline-')));
    roots.push(root);
    const lib = path.join(root, 'photos');
    fs.mkdirSync(lib);
    fs.writeFileSync(path.join(lib, 'a.jpg'), await sharp({ create: { width: 64, height: 48, channels: 3, background: '#406080' } }).jpeg().toBuffer());
    vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', lib);
    return lib;
}

describe('utils/imageOptimizer.ts', () => {
    it('has no unlink or rmSync, and its one rm is removeQuietly, for its own staged temp files', () => {
        expect(SOURCE).not.toMatch(/\bunlink(?:Sync)?\s*\(/);
        expect(SOURCE).not.toMatch(/\brmSync\s*\(/);
        expect(SOURCE.match(/\.rm\s*\(/g)).toHaveLength(1);
        expect(SOURCE).toMatch(/async function removeQuietly\(files: string\[\]\): Promise<void> \{\n\s+await Promise\.all\(files\.map\(\(file\) => fs\.promises\.rm\(/);
    });

    it('leaves the old image route cache in place when it rebuilds a set', async () => {
        const lib = await library();
        await processImage('a.jpg');
        const cached = path.join(lib, 'cache', 'dynamic', 'a-400-75.webp');
        fs.mkdirSync(path.dirname(cached), { recursive: true });
        fs.writeFileSync(cached, 'cached');
        await writeVariants('a.jpg', { overwrite: true, paths: libraryPaths() });
        expect(fs.readFileSync(cached, 'utf8')).toBe('cached');
    }, 30_000);

    it("keeps a set's record when it fills in only the missing outputs", async () => {
        const lib = await library();
        await processImage('a.jpg');
        const record = path.join(lib, 'cache', 'set-sources', 'a.json');
        expect(fs.existsSync(record)).toBe(true);
        fs.renameSync(path.join(lib, 'lqip', 'a.txt'), path.join(path.dirname(lib), 'a.txt'));
        await processImage('a.jpg');
        expect(fs.existsSync(path.join(lib, 'lqip', 'a.txt'))).toBe(true);
        expect(fs.existsSync(record)).toBe(true);
    }, 30_000);
});
