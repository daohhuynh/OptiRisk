import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
