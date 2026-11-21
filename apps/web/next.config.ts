import type { NextConfig } from 'next';

const apiOrigin = (process.env.MATRIXARK_API_ORIGIN ?? 'http://127.0.0.1:4000').replace(/\/$/, '');

const config: NextConfig = {
  agentRules: false,
  devIndicators: false,
  poweredByHeader: false,
  experimental: { proxyClientMaxBodySize: '100mb' },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
};

export default config;
