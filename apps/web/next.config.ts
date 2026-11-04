import type { NextConfig } from 'next';

// The dashboard talks only to the digest server's HTTP API, from its own server code (DECISIONS.md D91, D93).
const config: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
};

export default config;
