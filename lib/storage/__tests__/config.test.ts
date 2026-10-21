// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDataRoot, writeDataRootMarker, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { libraryPaths } from '../../../utils/imageOptimizer';
import { DATA_ROOT_FILE, dataRoot, dataRootState, dataRootStatus, libraryRoot } from '../config';

const isRoot = process.getuid?.() === 0;
// macOS volumes are usually case-insensitive, where another spelling of a path is the same folder.
const caseInsensitiveTmp = fs.existsSync(os.tmpdir().toUpperCase());
const cleanups: (() => Promise<void>)[] = [];

function tempDataRoot(options?: Parameters<typeof createTempDataRoot>[0]): TempDataRoot {
    const data = createTempDataRoot(options);
    cleanups.push(() => data.cleanup());
    return data;
}

async function tempLibrary(): Promise<TempLibrary> {
    const lib = await createTempLibrary();
    cleanups.push(() => lib.cleanup());
    return lib;
}

afterEach(async () => {
    vi.unstubAllEnvs();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe('libraryRoot', () => {
    it('reads PHOTOGRAPHY_LIBRARY_DIR on every call and backs libraryPaths()', async () => {
        const first = await tempLibrary();
        expect(libraryRoot()).toBe(first.root);
        expect(libraryPaths().root).toBe(first.root);

        const second = await tempLibrary();
        expect(libraryRoot()).toBe(second.root);
        expect(libraryPaths().thumbnails).toBe(path.join(second.root, 'thumbnails'));
    });

    it('defaults to public/assets/photos under the working directory', () => {
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', '');
        expect(libraryRoot()).toBe(path.join(process.cwd(), 'public/assets/photos'));
    });
});

describe('dataRoot', () => {
    it('reads PHOTOGRAPHY_DATA_DIR on every call', () => {
        const first = tempDataRoot();
        expect(dataRoot()).toBe(first.root);
        const second = tempDataRoot();
        expect(dataRoot()).toBe(second.root);
    });

    it('defaults to portfolio-data under the working directory outside production', () => {
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        vi.stubEnv('NODE_ENV', 'development');
        expect(dataRoot()).toBe(path.join(process.cwd(), 'portfolio-data'));
    });

    it('has no default in production', () => {
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', '');
        vi.stubEnv('NODE_ENV', 'production');
        expect(dataRoot()).toBeNull();
        expect(dataRootStatus()).toMatchObject({ state: 'unset', root: null });
        expect(dataRootState({ write: true })).toBe('unset');
    });
});

describe('dataRootState', () => {
    it('is ready with a valid data-root.json, with or without write', () => {
        tempDataRoot();
        expect(dataRootState()).toBe('ready');
        expect(dataRootState({ write: true })).toBe('ready');
    });

    it('is unavailable when the directory is missing or not a directory, and creates nothing', () => {
        const missing = tempDataRoot({ state: 'missing' });
        expect(dataRootStatus()).toMatchObject({ state: 'unavailable', root: missing.root, cause: 'missing' });
        expect(fs.existsSync(missing.root)).toBe(false);

        const notDir = tempDataRoot({ state: 'missing' });
        fs.writeFileSync(notDir.root, 'not a directory');
        expect(dataRootStatus({ write: true })).toMatchObject({ state: 'unavailable', cause: 'not-a-directory' });
    });

    it('is uninitialized without a valid data-root.json', () => {
        const data = tempDataRoot({ state: 'uninitialized' });
        expect(dataRootState()).toBe('uninitialized');
        expect(dataRootState({ write: true })).toBe('uninitialized');

        fs.writeFileSync(data.file(DATA_ROOT_FILE), '{ not json');
        expect(dataRootState()).toBe('uninitialized');
        writeDataRootMarker(data.root, { initializedAt: 'yesterday' });
        expect(dataRootState()).toBe('uninitialized');
        writeDataRootMarker(data.root, { schemaVersion: 0 });
        expect(dataRootState()).toBe('uninitialized');
    });

    it('is unavailable when data-root.json comes from a newer build', () => {
        const data = tempDataRoot();
        writeDataRootMarker(data.root, { schemaVersion: 2 });
        expect(dataRootStatus()).toMatchObject({ state: 'unavailable', cause: 'newer-schema', detail: expect.stringContaining('schemaVersion 2') });
        expect(dataRootState({ write: true })).toBe('unavailable');
    });

    it('is unavailable inside the photo library, so a scan never walks into it', async () => {
        const lib = await tempLibrary();
        fs.mkdirSync(lib.file('data'));
        writeDataRootMarker(lib.file('data'));
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', lib.file('data'));
        expect(dataRootStatus()).toMatchObject({ state: 'unavailable', cause: 'inside-served-folder', detail: expect.stringContaining('inside') });
    });

    it.runIf(caseInsensitiveTmp)('is unavailable inside the library even when the path is spelled in another case', async () => {
        const lib = await tempLibrary();
        fs.mkdirSync(lib.file('data'));
        writeDataRootMarker(lib.file('data'));
        const respelled = path.join(path.dirname(lib.root), path.basename(lib.root).toUpperCase(), 'data');
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', respelled);
        expect(dataRootStatus()).toMatchObject({ state: 'unavailable', cause: 'inside-served-folder' });
    });

    it.skipIf(isRoot)('is unwritable only when asked with write', () => {
        const data = tempDataRoot();
        fs.chmodSync(data.root, 0o555);
        expect(dataRootState({ write: true })).toBe('unwritable');
        expect(dataRootState()).toBe('ready');
    });

    it.skipIf(isRoot)('is unavailable when data-root.json exists but cannot be read', () => {
        const data = tempDataRoot();
        fs.chmodSync(data.file(DATA_ROOT_FILE), 0o000);
        expect(dataRootStatus()).toMatchObject({ state: 'unavailable', cause: 'marker-unreadable' });
    });
});
