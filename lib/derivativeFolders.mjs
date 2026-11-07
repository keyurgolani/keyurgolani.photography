/**
 * The legacy derivative folders directly under the library root, each with
 * the one extension its files have, in the order the pipeline writes them.
 * Everything that names these folders reads this list: the pipeline's paths
 * and encoders, and the folders the identity scan skips. Since #13's slice E
 * nothing serves them (proxy.ts 404s all of /assets/photos), and since its
 * second PR (v1.7.0) the watcher no longer writes them, but a library may
 * still hold them, so the scan keeps skipping these names.
 * scripts/host/legacy-move-aside.sh moves these seven and CACHE_FOLDER out of
 * the library by hand. It's shell, so it can't import this, and
 * test/legacyMoveAside.test.mjs keeps its list equal to these. It is plain
 * JavaScript so the pipeline and a config file alike can import it.
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
