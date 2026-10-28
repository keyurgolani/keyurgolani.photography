/** The four derivative widths, as manifest keys and `/media` file names. */
export const VARIANT_WIDTHS = ['w400', 'w800', 'w1200', 'w1920'] as const;
export type VariantWidth = (typeof VARIANT_WIDTHS)[number];

export const VARIANT_FORMATS = ['avif', 'webp'] as const;
export type VariantFormat = (typeof VARIANT_FORMATS)[number];

/** The pixel width each variant targets. Narrower sources are never enlarged. */
export const VARIANT_PIXELS: Record<VariantWidth, number> = { w400: 400, w800: 800, w1200: 1200, w1920: 1920 };

/** The `[variant]` segment of a `/media` URL: `w1200.webp` and the like. */
export const VARIANT_FILE_RE = /^w(400|800|1200|1920)\.(avif|webp)$/;
