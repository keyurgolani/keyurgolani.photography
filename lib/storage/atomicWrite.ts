import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fsyncDirectory } from './fsx';

/** Test hooks. Each runs at its point in the write and may throw to simulate a fault there. */
export interface AtomicWriteFaults {
    /** After the temp file is written and fsynced, before the rename. */
    beforeRename?(tempPath: string): void | Promise<void>;
    /** After the rename, before the directory fsync. */
    afterRename?(): void | Promise<void>;
}

export interface AtomicWriteOptions {
    faults?: AtomicWriteFaults;
}

/** The `.<name>.<pid>.<uuid>.tmp` name a write stages beside its target. */
export function tempPathFor(file: string): string {
    return path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
}

/**
 * Replace `file` so a reader sees the old bytes or the new ones, never a mix:
 * write a temp file in the same directory, fsync it, rename it over the
 * target, then fsync the directory. The directory must exist. On failure the
 * temp file is removed and the target keeps its old contents.
 */
export async function atomicWriteFile(file: string, data: string | Uint8Array, { faults }: AtomicWriteOptions = {}): Promise<void> {
    const temp = tempPathFor(file);
    let renamed = false;
    try {
        const handle = await fs.promises.open(temp, 'wx');
        try {
            await handle.writeFile(data);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await faults?.beforeRename?.(temp);
        await fs.promises.rename(temp, file);
        renamed = true;
        await faults?.afterRename?.();
        await fsyncDirectory(path.dirname(file));
    } catch (error) {
        if (!renamed) await fs.promises.rm(temp, { force: true }).catch(() => undefined);
        throw error;
    }
}

/** atomicWriteFile() for a JSON document, pretty-printed with a trailing newline. */
export function atomicWriteJson(file: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
    return atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`, options);
}
