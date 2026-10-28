/**
 * The stand-in About portrait the Playwright servers read from their site
 * config folder: a generated picture, never a real photo. The constants are
 * what the About specs expect; write-site-config.ts writes the files.
 */

export const STAND_IN_PORTRAIT = {
    /** Upright. The file is stored on its side with EXIF orientation 6, so the server has to turn it. */
    width: 1600,
    height: 2000,
    alt: 'A stand-in portrait for the tests: a dark figure against a warm, lit paper ground',
    focalPoint: { x: 50, y: 32 },
} as const;
