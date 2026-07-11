/**
 * Runtime stub for Vercel builds. Real Playwright is excluded from serverless
 * traces (too large / no browser binaries). Callers catch and use HTTP scrape.
 */
async function unavailable() {
  throw new Error("Cannot find package 'playwright'");
}

module.exports = {
  chromium: {
    launch: unavailable,
  },
  firefox: {
    launch: unavailable,
  },
  webkit: {
    launch: unavailable,
  },
};
