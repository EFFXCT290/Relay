import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Allow importing JSON from outside the app (../../mocks, ../../design)
  experimental: { externalDir: true },
  // @relay/contracts is a TS-source workspace package — its re-exports use
  // the .js extensions ESM expects (so the api can run them via tsx/tsc),
  // which Next's webpack won't resolve unless we both transpile the package
  // AND teach the resolver to try .ts/.tsx when it sees a .js import.
  transpilePackages: ["@relay/contracts"],
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js":  [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default config;
