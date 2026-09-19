import { createMDX } from 'fumadocs-mdx/next';
import { fileURLToPath } from 'node:url';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // The Docker image (Dockerfile) sets DOCS_STANDALONE=1 to get a self-contained
  // server; the tracing root is the monorepo root so workspace deps resolve.
  ...(process.env.DOCS_STANDALONE === '1' && {
    output: 'standalone',
    outputFileTracingRoot: fileURLToPath(new URL('../../', import.meta.url)),
  }),
  async redirects() {
    return [
      {
        source: '/blog',
        destination: '/en/general',
        permanent: true,
      },
      {
        source: '/blog/:path*',
        destination: '/en/general',
        permanent: true,
      },
    ];
  },
};

export default withMDX(config);
