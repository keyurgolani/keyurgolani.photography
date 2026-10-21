/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  images: {
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 86400, // 1 day
    deviceSizes: [400, 800, 1200, 1920],
    imageSizes: [400, 800],
    // A response over this limit hangs /_next/image instead of failing, so it stays
    // high. localPatterns below keeps originals out of /_next/image entirely.
    maximumResponseBody: 500_000_000,
    // /_next/image optimizes only the legacy derivatives and the profile
    // portraits, so it answers 400 for an original photo. Next adds the
    // patterns for statically imported images itself.
    localPatterns: [
      { pathname: '/assets/photos/thumbnails/*.webp', search: '' },
      { pathname: '/assets/photos/medium/*.webp', search: '' },
      { pathname: '/assets/photos/optimized/*.webp', search: '' },
      { pathname: '/assets/photos/thumbnails-avif/*.avif', search: '' },
      { pathname: '/assets/photos/medium-avif/*.avif', search: '' },
      { pathname: '/assets/photos/optimized-avif/*.avif', search: '' },
      { pathname: '/assets/profile/**', search: '' },
    ],
  },
};

export default nextConfig;
