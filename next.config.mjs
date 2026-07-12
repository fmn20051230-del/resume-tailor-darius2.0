import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const onVercel = Boolean(process.env.VERCEL);

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "docx-to-pdf-lite",
      "plutoprint",
      "docx-preview",
      "jsdom",
      ...(onVercel ? [] : ["playwright", "playwright-core", "libreoffice-convert"]),
    ],
    outputFileTracingExcludes: {
      "*": [
        "node_modules/playwright/**",
        "node_modules/playwright-core/**",
        "node_modules/libreoffice-convert/**",
        "node_modules/@img/**",
        "node_modules/@matbee/**",
        "public/lo-wasm/**",
      ],
    },
    outputFileTracingIncludes: {
      "/api/automation/convert-pdf": [
        "./node_modules/docx-to-pdf-lite/**",
        "./node_modules/plutoprint/**",
        "./node_modules/docx-preview/**",
        "./node_modules/jsdom/**",
      ],
      "/api/automation/run-job": [
        "./node_modules/docx-to-pdf-lite/**",
        "./node_modules/plutoprint/**",
        "./node_modules/docx-preview/**",
        "./node_modules/jsdom/**",
      ],
      "/api/automation/generate-attempt": [
        "./node_modules/docx-to-pdf-lite/**",
        "./node_modules/plutoprint/**",
        "./node_modules/docx-preview/**",
        "./node_modules/jsdom/**",
      ],
      "/api/automation/download-zip": [
        "./node_modules/docx-to-pdf-lite/**",
        "./node_modules/plutoprint/**",
        "./node_modules/docx-preview/**",
        "./node_modules/jsdom/**",
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
