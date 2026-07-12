import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const onVercel = Boolean(process.env.VERCEL);

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Keep Chromium/mammoth external on Vercel so DOCX→PDF works without ConvertAPI.
    serverComponentsExternalPackages: onVercel
      ? ["@sparticuz/chromium", "puppeteer-core", "mammoth"]
      : [
          "playwright",
          "playwright-core",
          "libreoffice-convert",
          "@sparticuz/chromium",
          "puppeteer-core",
          "mammoth",
        ],
    outputFileTracingExcludes: {
      "*": [
        "node_modules/playwright/**",
        "node_modules/playwright-core/**",
        "node_modules/libreoffice-convert/**",
        "node_modules/@img/**",
      ],
    },
    outputFileTracingIncludes: onVercel
      ? {
          "/api/automation/convert-pdf": [
            "./node_modules/@sparticuz/chromium/**",
            "./node_modules/puppeteer-core/**",
            "./node_modules/mammoth/**",
          ],
          "/api/automation/run-job": [
            "./node_modules/@sparticuz/chromium/**",
            "./node_modules/puppeteer-core/**",
            "./node_modules/mammoth/**",
          ],
          "/api/automation/generate-attempt": [
            "./node_modules/@sparticuz/chromium/**",
            "./node_modules/puppeteer-core/**",
            "./node_modules/mammoth/**",
          ],
          "/api/automation/download-zip": [
            "./node_modules/@sparticuz/chromium/**",
            "./node_modules/puppeteer-core/**",
            "./node_modules/mammoth/**",
          ],
        }
      : {},
  },
  webpack: (config, { isServer }) => {
    if (isServer && onVercel) {
      config.resolve.alias = {
        ...config.resolve.alias,
        // Stub Playwright (scraping) — do NOT stub puppeteer-core (used for PDF).
        playwright: path.join(__dirname, "lib/automation/playwright-stub.cjs"),
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
