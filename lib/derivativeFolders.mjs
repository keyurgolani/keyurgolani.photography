/**
 * The legacy derivative folders directly under the library root, each with
 * the one extension its files have, in the order the pipeline writes them.
 * Everything that names these folders reads this list: the pipeline's paths
 * and encoders, the legacy /api/photos item URLs, and the folders the identity
 * scan skips. The site no longer serves them: proxy.ts 404s all of
 * /assets/photos, and /_next/image refuses it.
 */
export const DERIVATIVE_FOLDERS = Object.freeze(/** @type {const} */ ({
    thumbnails: '.webp',
    medium: '.webp',
    optimized: '.webp',
    'thumbnails-avif': '.avif',
    'medium-avif': '.avif',
    'optimized-avif': '.avif',
    lqip: '.txt',
}));

/** The folder beside them that the removed /api/image route cached into. Nothing in it is served. */
export const CACHE_FOLDER = 'cache';
