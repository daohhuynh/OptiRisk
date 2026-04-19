import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The `ws` package has optional native deps (bufferutil, utf-8-validate).
  // Letting Next.js webpack-bundle it strips those, breaking send/receive
  // ("bufferUtil.mask is not a function"). Keep it external so the runtime
  // resolves it from node_modules with native modules attached.
  serverExternalPackages: ['ws'],
  transpilePackages: [
    'deck.gl',
    '@deck.gl/core',
    '@deck.gl/react',
    '@deck.gl/layers',
    '@deck.gl/geo-layers',
    'react-map-gl',
    '@math.gl/core',
    '@math.gl/web-mercator',
  ],
};

export default nextConfig;
