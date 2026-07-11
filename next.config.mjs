import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const onVercel = Boolean(process.env.VERCEL);

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // On Vercel, resolve via webpack stubs instead of missing node_modules packages.
    serverComponentsExternalPackages: onVercel
      ? []
      : ["playwright", "playwright-core", "libreoffice-convert"],
    outputFileTracingExcludes: {
      "*": [
        "node_modules/playwright/**",
        "node_modules/playwright-core/**",
        "node_modules/libreoffice-convert/**",
        "node_modules/@img/**",
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
    return config;
  },
};

export default nextConfig;
