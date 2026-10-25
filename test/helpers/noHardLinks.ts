/**
 * A filesystem that can't hold hard links, as exFAT can't, for the writers
 * that commit versioned documents with link().
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { vi } from 'vitest';

const unsupported = (): never => {
    throw Object.assign(new Error('ENOTSUP: operation not supported, link'), { code: 'ENOTSUP' });
};

/** Fail every link() in this process. Returns a function that restores them. */
export function stubNoHardLinks(): () => void {
    const sync = vi.spyOn(fs, 'linkSync').mockImplementation(unsupported);
    const promised = vi.spyOn(fs.promises, 'link').mockImplementation(async () => unsupported());
    return () => {
        sync.mockRestore();
        promised.mockRestore();
    };
}

const PRELOAD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'noHardLinks.preload.mjs');

/** NODE_OPTIONS for a child process in which every link() fails the same way. */
export function noHardLinksNodeOptions(): string {
    return [process.env.NODE_OPTIONS, `--import=${pathToFileURL(PRELOAD).href}`].filter(Boolean).join(' ');
}
