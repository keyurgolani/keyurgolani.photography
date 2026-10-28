// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTempDataRoot, writeDataRootMarker, type TempDataRoot } from '../../../test/helpers/tempDataRoot';
import { createTempLibrary, type TempLibrary } from '../../../test/helpers/tempLibrary';
import { libraryPaths } from '../../../utils/imageOptimizer';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { DATA_ROOT_FILE, dataRoot, dataRootState, dataRootStatus, libraryRoot, PROBE_SWEEP_AGE_MS, probeHostTag } from '../config';

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
    vi.restoreAllMocks();
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
        expect(dataRootStatus()).toMatchObject({ state: 'unavailable', cause: 'inside-served-folder', detail: 'it is inside the photo library' });
    });

    it('names the served folder it is inside without printing that folder\'s path', () => {
        // public/ under a temp working directory, so the repository's own public/ is never touched.
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'photography-cwd-'));
        cleanups.push(() => fs.promises.rm(cwd, { recursive: true, force: true }));
        vi.spyOn(process, 'cwd').mockReturnValue(cwd);
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', path.join(cwd, 'library'));
        const data = path.join(cwd, 'public', 'data');
        fs.mkdirSync(data, { recursive: true });
        writeDataRootMarker(data);
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', data);
        const status = dataRootStatus();
        expect(status).toMatchObject({ state: 'unavailable', cause: 'inside-served-folder', detail: 'it is inside the app\'s public folder' });
        expect(status.detail).not.toContain(cwd);
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

    it("is unwritable when asked for a versioned writer if its filesystem can't hold hard links, and says why", () => {
        const data = tempDataRoot();
        // As on exFAT
        const link = vi.spyOn(fs, 'linkSync').mockImplementation(() => {
            throw Object.assign(new Error('ENOTSUP: operation not supported, link'), { code: 'ENOTSUP' });
        });
        expect(dataRootStatus({ versioned: true })).toMatchObject({ state: 'unwritable', detail: expect.stringContaining("can't hold hard links") });
        expect(dataRootState()).toBe('ready');
        expect(data.files()).toEqual([DATA_ROOT_FILE]);

        // A writer of anything else, such as the dry run's report, needs no hard links, so nothing probes for them.
        link.mockClear();
        const write = vi.spyOn(fs, 'writeFileSync');
        expect(dataRootState({ write: true })).toBe('ready');
        expect(link).not.toHaveBeenCalled();
        expect(write).not.toHaveBeenCalled();

        vi.restoreAllMocks();
        expect(dataRootState({ versioned: true })).toBe('ready');
        expect(data.files()).toEqual([DATA_ROOT_FILE]);
    });

    describe('the probe files a killed process left', () => {
        // A process that has exited, so its ID names nothing running (and a reused one only keeps a leftover).
        const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid as number;
        const probeName = (host: string, pid: number) => `.link-probe-${host}-${pid}-${randomUUID()}`;
        const place = (root: string, name: string, ageMs: number) => {
            const file = path.join(root, name);
            fs.writeFileSync(file, '');
            const at = new Date(Date.now() - ageMs);
            fs.utimesSync(file, at, at);
            return name;
        };

        it("sweeps only this machine's, of a process that isn't running, older than a minute, and leaves everything else", () => {
            const data = tempDataRoot();
            const host = probeHostTag();
            const old = PROBE_SWEEP_AGE_MS + 5_000;
            const dead = deadPid();
            const stale = probeName(host, dead);
            place(data.root, stale, old);
            place(data.root, `${stale}.link`, old);
            const kept = [
                // A probe a live process may still be using: this test's parent is running.
                place(data.root, probeName(host, process.ppid), old),
                // Too young to be a leftover.
                place(data.root, probeName(host, dead), 1_000),
                // Another machine's, whose process IDs mean nothing here.
                place(data.root, probeName(host === '00000000' ? '11111111' : '00000000', dead), old),
                // The old name, without a host, and anything else that looks close.
                place(data.root, `.link-probe-${dead}-${randomUUID()}`, old),
                place(data.root, '.link-probe-notes', old),
            ];
            // A folder with a probe's name stays too: the sweep removes regular files only.
            const folder = probeName(host, dead);
            fs.mkdirSync(path.join(data.root, folder));
            const at = new Date(Date.now() - old);
            fs.utimesSync(path.join(data.root, folder), at, at);

            expect(dataRootStatus({ versioned: true })).toMatchObject({ state: 'ready' });
            expect(data.files().sort()).toEqual([DATA_ROOT_FILE, ...kept].sort());
            expect(fs.statSync(path.join(data.root, folder)).isDirectory()).toBe(true);
        });

        it('names its own probe with this host and its process, and leaves none behind', () => {
            const data = tempDataRoot();
            const write = vi.spyOn(fs, 'writeFileSync');
            expect(dataRootStatus({ versioned: true })).toMatchObject({ state: 'ready' });
            const probe = path.basename(String(write.mock.calls.find(([target]) => String(target).includes('.link-probe-'))?.[0]));
            expect(probe).toMatch(new RegExp(`^\\.link-probe-${probeHostTag()}-${process.pid}-[0-9a-f-]{36}$`));
            expect(data.files()).toEqual([DATA_ROOT_FILE]);
        });
    });

    describe('a root it already probed for hard links', () => {
        const ENOTSUP = () => {
            throw Object.assign(new Error('ENOTSUP: operation not supported, link'), { code: 'ENOTSUP' });
        };

        it("isn't taken for a new root that has its inode, and its birth time, back", () => {
            const first = tempDataRoot();
            const second = tempDataRoot();
            // As a root removed and made again within one tick can on Linux: the same device, inode and birth time.
            const real = fs.statSync;
            vi.spyOn(fs, 'statSync').mockImplementation(((target: fs.PathLike, options?: fs.StatSyncOptions) => {
                const stat = real(target, options) as fs.Stats;
                if (![first.root, second.root].includes(path.resolve(String(target)))) return stat;
                return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: 7, ino: 4242, birthtimeMs: 1_700_000_000_000 });
            }) as typeof fs.statSync);
            expect(dataRootStatus({ versioned: true, root: first.root })).toMatchObject({ state: 'ready', root: first.root });
            // The new root's filesystem can't hold hard links, and it has to be probed to find that out.
            vi.spyOn(fs, 'linkSync').mockImplementation(ENOTSUP);
            expect(dataRootStatus({ versioned: true })).toMatchObject({ state: 'unwritable', root: second.root, detail: expect.stringContaining("can't hold hard links") });
            expect(second.files()).toEqual([DATA_ROOT_FILE]);
        });

        it("is unwritable, and doesn't throw, when a probe file can't be removed", () => {
            const data = tempDataRoot();
            const real = fs.rmSync;
            let failed = false;
            vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, options?: fs.RmOptions) => {
                if (!failed && String(target).endsWith('.link')) {
                    failed = true;
                    throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
                }
                return real(target, options);
            }) as typeof fs.rmSync);
            expect(dataRootStatus({ versioned: true })).toMatchObject({ state: 'unwritable', detail: expect.stringContaining("a probe file can't be removed from it (EPERM)") });
            // The other name still went.
            expect(data.files().filter((name) => !name.endsWith('.link'))).toEqual([DATA_ROOT_FILE]);
        });

        it('is probed again each time, and leaves nothing behind', () => {
            const data = tempDataRoot();
            const link = vi.spyOn(fs, 'linkSync');
            expect(dataRootState({ versioned: true })).toBe('ready');
            expect(dataRootState({ versioned: true })).toBe('ready');
            expect(link).toHaveBeenCalledTimes(2);
            expect(data.files()).toEqual([DATA_ROOT_FILE]);
        });
    });

    it.skipIf(isRoot)('is unavailable when data-root.json exists but cannot be read', () => {
        const data = tempDataRoot();
        fs.chmodSync(data.file(DATA_ROOT_FILE), 0o000);
        const status = dataRootStatus();
        expect(status).toMatchObject({ state: 'unavailable', cause: 'marker-unreadable', detail: `${DATA_ROOT_FILE} can't be read (EACCES)` });
        expect(status.detail).not.toContain(data.root);
    });

    it('names a data root it can\'t stat by the error code, not by a message that carries its path', () => {
        // A symlink to itself: stat fails with ELOOP, even as root.
        const data = tempDataRoot();
        const loop = data.file('loop');
        fs.symlinkSync(loop, loop);
        vi.stubEnv('PHOTOGRAPHY_DATA_DIR', loop);
        const status = dataRootStatus();
        expect(status).toMatchObject({ state: 'unavailable', cause: 'not-readable', detail: 'it can\'t be read (ELOOP)' });
        expect(status.detail).not.toContain(data.root);
    });
});
