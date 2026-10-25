/**
 * Record which folders get fsynced, through a spy on fs.promises.open: a
 * folder is opened only by fsyncDirectory(), and its handle's sync() is what's
 * recorded. The test's afterEach must call vi.restoreAllMocks().
 */

import fs from 'node:fs';
import { vi } from 'vitest';

// Taken before any spy, so a second call in one test doesn't wrap the first.
const open = fs.promises.open;

export function recordDirectorySyncs(): string[] {
    const synced: string[] = [];
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
        const handle = await open.apply(fs.promises, args);
        const [file] = args;
        if (typeof file === 'string' && fs.statSync(file).isDirectory()) {
            const sync = handle.sync.bind(handle);
            handle.sync = async () => {
                await sync();
                synced.push(file);
            };
        }
        return handle;
    });
    return synced;
}
