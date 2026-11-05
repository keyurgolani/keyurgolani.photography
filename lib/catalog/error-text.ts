import path from 'node:path';

/**
 * An error for a message, without the absolute path a Node fs error carries:
 * its code and the path relative to the data root, or "a path outside the
 * data root". Other errors keep their message, which catalog code writes
 * relative already. Its own module so verify.ts and rollback.ts, which
 * reads verify.ts's record, don't import each other (#181).
 */
export function errorText(error: unknown, root: string): string {
    const errno = error as NodeJS.ErrnoException;
    if (error instanceof Error && typeof errno.code === 'string' && typeof errno.path === 'string') {
        return `${errno.code} on ${relativeName(root, errno.path)}`;
    }
    // The storage layer's document errors, such as a damaged registry's, start with the file's absolute path.
    const file = (error as { file?: unknown } | null)?.file;
    if (error instanceof Error && typeof file === 'string' && path.isAbsolute(file)) return error.message.split(file).join(relativeName(root, file));
    return error instanceof Error ? error.message : String(error);
}

/** A path relative to the data root, POSIX style, or a stand-in for one outside it. */
function relativeName(root: string, file: string): string {
    const relative = path.relative(root, path.resolve(file));
    if (relative === '') return 'the data root';
    if (relative.startsWith('..') || path.isAbsolute(relative)) return 'a path outside the data root';
    return relative.split(path.sep).join('/');
}
