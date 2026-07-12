import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const onVercel = Boolean(process.env.VERCEL);

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: onVercel
      ? ["@matbee/libreoffice-converter"]
      : [
          "playwright",
          "playwright-core",
          "libreoffice-convert",
          "@matbee/libreoffice-converter",
        ],
    // Keep ~246MB LibreOffice WASM out of serverless function bundles.
    // Browser loads it from /lo-wasm/ static files instead.
    outputFileTracingExcludes: {
      "*": [
        "node_modules/playwright/**",
        "node_modules/playwright-core/**",
        "node_modules/libreoffice-convert/**",
        "node_modules/@img/**",
        "node_modules/@matbee/libreoffice-converter/wasm/**",
        "public/lo-wasm/**",
      ],
    },
  },
  webpack: (config, { isServer }) => {
    if (isServer && onVercel) {
      config.resolve.alias = {
        ...config.resolve.alias,
        playwright: path.join(__dirname, "lib/automation/playwright-stub.cjs"),
        "playwright-core": path.join(__dirname, "lib/automation/playwright-stub.cjs"),
        "libreoffice-convert": path.join(
          __dirname,
          "lib/automation/libreoffice-stub.cjs"
        ),
      };
    }
    // Browser LibreOffice converter should not be pulled into the server bundle.
    if (isServer) {
      config.externals = config.externals || [];
      if (Array.isArray(config.externals)) {
        config.externals.push("@matbee/libreoffice-converter/browser");
      }
    }
    return config;
  },
};

export default nextConfig;
