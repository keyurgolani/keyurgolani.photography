import fs from 'node:fs';
import path from 'node:path';

/** True when `error` is a Node errno error carrying one of `codes`. */
export function hasErrorCode(error: unknown, ...codes: string[]): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' && codes.includes(code);
}

/**
 * fsync a directory so a rename inside it survives a crash. Platforms that
 * can't fsync a directory (Windows) report EPERM, EISDIR, EINVAL, or ENOTSUP,
 * and those are ignored.
 */
export async function fsyncDirectory(dir: string): Promise<void> {
    let handle: fs.promises.FileHandle;
    try {
        handle = await fs.promises.open(dir, 'r');
    } catch (error) {
        if (hasErrorCode(error, 'EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP')) return;
        throw error;
    }
    try {
        await handle.sync();
    } catch (error) {
        if (!hasErrorCode(error, 'EPERM', 'EISDIR', 'EINVAL', 'ENOTSUP')) throw error;
    } finally {
        await handle.close();
    }
}

/**
 * Resolve symlinks in the longest existing prefix of `target`, so it works for
 * paths that don't exist yet. Uses the native realpath, which also returns the
 * on-disk case, so `Public/` and `public/` compare equal on a case-insensitive disk.
 */
export function realpathLoose(target: string): string {
    const missing: string[] = [];
    let current = path.resolve(target);
    for (;;) {
        try {
            return path.join(fs.realpathSync.native(current), ...missing);
        } catch {
            const parent = path.dirname(current);
            if (parent === current) return path.join(current, ...missing);
            missing.unshift(path.basename(current));
            current = parent;
        }
    }
}

/** True when `child` is `parent` or inside it. Both should be absolute. */
export function isInside(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
