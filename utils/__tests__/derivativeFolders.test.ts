// @vitest-environment node
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CACHE_FOLDER, DERIVATIVE_FOLDERS } from '../../lib/derivativeFolders.mjs';
import { LEGACY_OUTPUT_DIRS } from '../../lib/identity/scan';
import nextConfig from '../../next.config.mjs';
import { generatedFolderNames, libraryPaths } from '../imageOptimizer';
import { PUBLIC_DERIVATIVE_FOLDERS } from '../publicDerivatives';

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

    it('is what the pipeline, the proxy, /_next/image, and the identity scan all read', () => {
        const paths = libraryPaths();
        const folderPaths = Object.entries(paths).filter(([key]) => key !== 'root' && key !== 'dynamicCache').map(([, folder]) => path.relative(paths.root, folder));
        expect(folderPaths).toEqual(folders);
        expect(generatedFolderNames()).toEqual([...folders, CACHE_FOLDER]);
        expect(PUBLIC_DERIVATIVE_FOLDERS).toEqual(DERIVATIVE_FOLDERS);
        expect(LEGACY_OUTPUT_DIRS).toEqual([...folders, CACHE_FOLDER]);
        const photoPatterns = (nextConfig.images?.localPatterns ?? []).map((pattern) => pattern.pathname).filter((pathname) => pathname?.startsWith('/assets/photos/'));
        expect(photoPatterns).toEqual(entries.filter(([, extension]) => extension !== '.txt').map(([folder, extension]) => `/assets/photos/${folder}/*${extension}`));
    });
});
