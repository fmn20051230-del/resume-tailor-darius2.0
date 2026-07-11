/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      "playwright",
      "playwright-core",
      "libreoffice-convert",
    ],
  },
};

export default nextConfig;
