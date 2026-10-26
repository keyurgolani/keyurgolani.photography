import { DERIVATIVE_FOLDERS } from './lib/derivativeFolders.mjs';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // lib/storage/config.ts and lib/siteConfig/dir.ts keep their run-time paths
  // out of the trace. These excludes keep out the default data root, whose
  // registry holds curator-only metadata, the library's original photos, and
  // the default site config folder, whose portrait is read from the host and
  // never ships in the image, should anything else reach them.
  outputFileTracingExcludes: {
    '*': ['./portfolio-data/**/*', './public/assets/photos/**/*', './site-config/**/*'],
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 86400, // 1 day
    deviceSizes: [400, 800, 1200, 1920],
    imageSizes: [400, 800],
    // A response over this limit hangs /_next/image instead of failing, so it stays
    // high. localPatterns below keeps originals out of /_next/image entirely.
    maximumResponseBody: 500_000_000,
    // /_next/image optimizes only the legacy derivatives, so it answers 400
    // for an original photo and for any other public file. About's portrait,
    // which Home's intro shows too, comes from the site config folder at
    // /about/portrait/, never through /_next/image.
    localPatterns: [
      // Every image derivative folder, by its extension. The LQIP text files aren't images.
      ...Object.entries(DERIVATIVE_FOLDERS)
        .filter(([, extension]) => extension !== '.txt')
        .map(([folder, extension]) => ({ pathname: `/assets/photos/${folder}/*${extension}`, search: '' })),
    ],
  },
};

export default nextConfig;
