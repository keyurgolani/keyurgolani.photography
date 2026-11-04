// @vitest-environment node
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CACHE_FOLDER, DERIVATIVE_FOLDERS } from '../../lib/derivativeFolders.mjs';
import { LEGACY_OUTPUT_DIRS } from '../../lib/identity/scan';
import nextConfig from '../../next.config.mjs';
import { generatedFolderNames, libraryPaths } from '../imageOptimizer';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('the derivative folder list', () => {
    const entries = Object.entries(DERIVATIVE_FOLDERS);
    const folders = entries.map(([folder]) => folder);

    it('names the seven folders the pipeline writes, in order, each with its extension', () => {
        expect(entries).toEqual([
            ['thumbnails', '.webp'], ['medium', '.webp'], ['optimized', '.webp'],
            ['thumbnails-avif', '.avif'], ['medium-avif', '.avif'], ['optimized-avif', '.avif'],
            ['lqip', '.txt'],
        ]);
    });

    it('is what the pipeline and the identity scan read, and nothing serves them', () => {
        // Never read: libraryPaths() only joins names onto the root.
        vi.stubEnv('PHOTOGRAPHY_LIBRARY_DIR', path.join(path.sep, 'nowhere', 'library'));
        const paths = libraryPaths();
        const folderPaths = Object.entries(paths).filter(([key]) => key !== 'root' && key !== 'dynamicCache').map(([, folder]) => path.relative(paths.root, folder));
        expect(folderPaths).toEqual(folders);
        expect(generatedFolderNames()).toEqual([...folders, CACHE_FOLDER]);
        // Nothing writes them from v1.7.0, but a v1.6 library still holds them, so the scan keeps skipping them by name.
        expect(LEGACY_OUTPUT_DIRS).toEqual([...folders, CACHE_FOLDER]);
        // #13's slice E: /_next/image optimizes none of them (proxy.ts 404s them and refuses them there too).
        const photoPatterns = (nextConfig.images?.localPatterns ?? []).map((pattern) => pattern.pathname).filter((pathname) => pathname?.startsWith('/assets/photos/'));
        expect(photoPatterns).toEqual([]);
    });
});
