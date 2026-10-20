/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  images: {
    formats: ['image/avif', 'image/webp'],
    minimumCacheTTL: 86400, // 1 day
    deviceSizes: [400, 800, 1200, 1920],
    imageSizes: [400, 800],
    // Gallery tiles can request originals, and one over the 50 MB default hangs /_next/image.
    maximumResponseBody: 500_000_000,
  },
};

export default nextConfig;