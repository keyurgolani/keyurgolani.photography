// #14's curator paths. proxy.ts 404s them unless CURATION_ENABLED is true.
const CURATOR_SOURCES = ['/curation/:path*', '/api/curation/:path*'];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  // Every curator response: never cached, indexed, framed, or sent as a
  // referrer. The framing policy is its own entry, so #16's preview can
  // override it for its own path. lib/curation/auth/policy.ts holds the same
  // values, and proxy.ts sends them on the responses it refuses.
  async headers() {
    return [
      ...CURATOR_SOURCES.map((source) => ({
        source,
        headers: [
          { key: 'Cache-Control', value: 'no-store' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      })),
      ...CURATOR_SOURCES.map((source) => ({
        source,
        headers: [{ key: 'Content-Security-Policy', value: "frame-ancestors 'none'" }],
      })),
    ];
  },
  // lib/storage/config.ts keeps its run-time paths out of the trace. These
  // excludes keep out the default data root, whose registry holds curator-only
  // metadata, and the library's original photos, should anything else reach them.
  outputFileTracingExcludes: {
    '*': ['./portfolio-data/**/*', './public/assets/photos/**/*'],
  },
  images: {
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 86400, // 1 day
    deviceSizes: [400, 800, 1200, 1920],
    imageSizes: [400, 800],
    // A response over this limit hangs /_next/image instead of failing, so it stays
    // high. localPatterns below keeps the photo library out of /_next/image entirely.
    maximumResponseBody: 500_000_000,
    // Of the public files, /_next/image optimizes only the two profile
    // portraits, so it answers 400 for every url under /assets/photos,
    // originals and legacy derivatives alike. Photos come from /media sets,
    // which never go through /_next/image. The portraits are listed by exact
    // path, which no encoded `..` can climb out of. The pages import them
    // statically, and at load Next adds its own /_next/static/media patterns to
    // this list for those. proxy.ts is what keeps a url under those from
    // reaching /assets/photos.
    localPatterns: [
      { pathname: '/assets/profile/front.png', search: '' },
      { pathname: '/assets/profile/back.png', search: '' },
    ],
  },
};

export default nextConfig;
