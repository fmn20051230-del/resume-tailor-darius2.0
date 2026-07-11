/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "playwright",
      "playwright-core",
      "libreoffice-convert",
    ],
    // Keep heavy local-only binaries out of Vercel serverless bundles.
    outputFileTracingExcludes: {
      "*": [
        "node_modules/playwright/**",
        "node_modules/playwright-core/**",
        "node_modules/libreoffice-convert/**",
        "node_modules/@img/**",
      ],
    },
  },
};

export default nextConfig;
