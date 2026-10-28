import path from 'node:path';
import { DERIVATIVE_FOLDERS } from '../derivativeFolders.mjs';

/**
 * The URLs the legacy site served for a source, as getImagePaths() names
 * them: the original, and for a top-level file the derivatives named by its
 * base name. Nested files never had derivatives. Each path segment is
 * encoded, as the site wrote it, so a `%` or `#` in a name stays part of it.
 * Its own module, so the web process's legacy /api/photos can use it without
 * loading the migration.
 */
export function legacyUrls(sourcePath: string): string[] {
    const url = (...segments: string[]) => `/assets/photos/${segments.map(encodeURIComponent).join('/')}`;
    const original = url(...sourcePath.split('/'));
    if (sourcePath.includes('/')) return [original];
    const base = path.posix.basename(sourcePath, path.posix.extname(sourcePath));
    return [original, ...Object.entries(DERIVATIVE_FOLDERS).map(([folder, extension]) => url(folder, `${base}${extension}`))];
}
