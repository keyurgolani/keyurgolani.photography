/**
 * The legacy derivative folders directly under the library root, each with
 * the one extension its files have, in the order the pipeline writes them.
 * Everything that names these folders reads this list: the pipeline's paths
 * and encoders, the proxy's allowlist, the /_next/image patterns in
 * next.config.mjs, and the folders the identity scan skips. It is plain
 * JavaScript so next.config.mjs can import it.
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
