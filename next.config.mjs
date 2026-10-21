/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // The file access in lib/storage/config.ts makes the build trace the whole
  // project into .next/standalone. Keep out the default data root, whose
  // registry holds curator-only metadata, and the library's original photos.
  outputFileTracingExcludes: {
    '*': ['./portfolio-data/**/*', './public/assets/photos/**/*'],
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 86400, // 1 day
    deviceSizes: [400, 800, 1200, 1920],
    imageSizes: [400, 800],
    // A response over this limit hangs /_next/image instead of failing, so it stays
    // high. localPatterns below keeps originals out of /_next/image entirely.
    maximumResponseBody: 500_000_000,
    // /_next/image optimizes only the legacy derivatives and the two profile
    // portraits, so it answers 400 for an original photo. The portraits are
    // listed by exact path, which no encoded `..` can climb out of. The pages
    // import them statically, and Next adds /_next/static/media for those itself.
    localPatterns: [
      { pathname: '/assets/photos/thumbnails/*.webp', search: '' },
      { pathname: '/assets/photos/medium/*.webp', search: '' },
      { pathname: '/assets/photos/optimized/*.webp', search: '' },
      { pathname: '/assets/photos/thumbnails-avif/*.avif', search: '' },
      { pathname: '/assets/photos/medium-avif/*.avif', search: '' },
      { pathname: '/assets/photos/optimized-avif/*.avif', search: '' },
      { pathname: '/assets/profile/front.png', search: '' },
      { pathname: '/assets/profile/back.png', search: '' },
    ],
  },
};

export default nextConfig;
