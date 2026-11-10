import type { NextConfig } from 'next';

const wasm = ['./node_modules/web-tree-sitter/web-tree-sitter.wasm', './node_modules/tree-sitter-python/tree-sitter-python.wasm'];
const fixtures = ['./evals/fixtures/**/*'];

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ['web-tree-sitter', 'chromadb', 'postgres', 'nodemailer'],
  // The Python parser (WASM) and the eval fixtures are read from disk at run time,
  // so they must be traced into the functions that use them.
  outputFileTracingIncludes: {
    '/api/convert': wasm,
    '/api/runs/[id]/revise': wasm,
    '/api/runs/[id]/resume': wasm,
    '/api/runs/[id]/approve': wasm,
    '/api/cron/learn': [...wasm, ...fixtures],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
        ],
      },
    ];
  },
};

export default config;
