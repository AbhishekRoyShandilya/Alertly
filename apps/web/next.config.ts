import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';

const config: NextConfig = {
  poweredByHeader: false,
  // The shared package is TypeScript source; Next compiles it like app code.
  transpilePackages: ['@alertly/shared'],
  // npm workspaces hoist dependencies to the repo root.
  turbopack: { root: join(dirname(fileURLToPath(import.meta.url)), '../..') },

  /**
   * Same-origin API: the browser calls /api/* on the dashboard's own origin, and Next forwards
   * to the API server. The httpOnly session cookie is then first-party (SameSite=Lax works)
   * and production needs no CORS at all.
   */
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_URL}/api/v1/:path*` }];
  },
};

export default config;
