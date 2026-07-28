import bundleAnalyzer from '@next/bundle-analyzer';

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === 'true',
  openAnalyzer: false,
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // The dashboard ships zero images and zero web fonts, so the only thing worth
  // trimming is JS. Keeping this on shaves the `console.*` calls out of prod.
  compiler: {
    removeConsole: process.env.NODE_ENV === 'production' ? { exclude: ['error', 'warn'] } : false,
  },

  experimental: {
    // Charts push a lot of small state updates; this keeps the router cache from
    // fighting the stream on client navigations between dashboard tabs.
    staleTimes: { dynamic: 30, static: 180 },
  },

  async headers() {
    return [
      {
        // The worker + wasm-free hot path benefits from a cross-origin isolated
        // context (unlocks precise performance.now + SharedArrayBuffer if we
        // ever need it). Harmless when unsupported.
        source: '/dashboard',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
};

export default withBundleAnalyzer(nextConfig);
