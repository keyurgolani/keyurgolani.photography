import fs from 'node:fs';
import path from 'node:path';

/**
 * Modes for what the data root code creates. Identity state holds
 * curator-only metadata such as GPS, so only the owning user can read it, and
 * whatever serves or writes the data root must run as that user.
 */
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_DIR_MODE = 0o700;

/** A filesystem-safe form of an ISO timestamp, such as 2026-10-20T06-34-12-123Z. */
export function timestampOf(iso: string): string {
    return iso.replace(/[:.]/g, '-');
}

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

/** Whether anything, a dangling symlink included, is at `target`. Throws for errors other than ENOENT and ENOTDIR. */
export async function pathExists(target: string): Promise<boolean> {
    try {
        await fs.promises.lstat(target);
        return true;
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT', 'ENOTDIR')) return false;
        throw error;
    }
}

/**
 * Make `dir`, readable by its owner only, unless it exists, and fsync its
 * parent when this call made it. With `syncParent`, fsync the parent even when
 * it already existed: a first write calls it so, since the writer that made
 * the folder may have crashed or lost before it synced the parent. The parent
 * must exist.
 */
export async function ensureDirectory(dir: string, { syncParent = false }: { syncParent?: boolean } = {}): Promise<void> {
    let created = false;
    try {
        await fs.promises.mkdir(dir, { mode: PRIVATE_DIR_MODE });
        created = true;
    } catch (error) {
        if (!hasErrorCode(error, 'EEXIST')) throw error;
    }
    if (created || syncParent) await fsyncDirectory(path.dirname(dir));
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

// Where an absolute path can start: not inside a relative path, a URL, or another path
const PATH_START = String.raw`(?<![\w.~:/-])`;

// Where a root can start. Looser, since a root's text is a path wherever it starts, even after `:` or `-`. A
// URL's host still keeps `scheme://host/root` whole.
const ROOT_START = String.raw`(?<![\w.~/])`;

// An absolute path or file URL as Node's errors quote one, which may hold spaces
const QUOTED_PATH = /'((?:file:\/\/)?\/[^'\n]*)'/g;

// An absolute path or file URL outside quotes, which ends at a space
const ABSOLUTE_PATH = new RegExp(String.raw`${PATH_START}(?:file://)?/[^\s'"\`,;()]+`, 'g');

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Error text with no absolute path left in it, for a reason a document stores
 * or a status command prints, so neither shows where the library or the data
 * root lives on the host. A path or `file://` URL inside one of `roots`, as
 * given or resolved, becomes relative to it, and any other becomes its base
 * name. A root counts only as a path's whole leading segments, so
 * `/backup/srv/data/x` isn't inside `/srv/data`.
 */
export function withoutAbsolutePaths(text: string, roots: readonly (string | null)[]): string {
    const prefixes = [...new Set(roots.flatMap((root) => (root === null ? [] : [path.resolve(root), realpathLoose(root)])))]
        .sort((a, b) => b.length - a.length);
    // A root first, whatever follows it, quoted or not, so a name with a space or a quote in it stays whole.
    let result = text;
    for (const prefix of prefixes) result = result.replace(new RegExp(`${ROOT_START}(?:file://)?${escapeRegExp(prefix)}/`, 'g'), '');
    // Every other path, quoted, where it may hold a space, or not
    const baseName = (match: string) => path.posix.basename(match.replace(/^file:\/\//, '')) || match;
    return result
        .replace(QUOTED_PATH, (_, quoted: string) => `'${baseName(quoted)}'`)
        .replace(ABSOLUTE_PATH, baseName);
}
