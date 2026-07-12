/**
 * Copy LibreOffice WASM assets into public/lo-wasm for browser DOCX→PDF on Vercel.
 * Runs on postinstall so deploys include the static files (not inside the serverless bundle).
 */
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const srcWasm = path.join(root, "node_modules", "@matbee", "libreoffice-converter", "wasm");
const srcWorker = path.join(
  root,
  "node_modules",
  "@matbee",
  "libreoffice-converter",
  "dist",
  "browser.worker.global.js"
);
const dest = path.join(root, "public", "lo-wasm");

if (!fs.existsSync(srcWasm)) {
  console.warn("[copy-lo-wasm] @matbee/libreoffice-converter not installed — skip");
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
for (const name of ["soffice.js", "soffice.wasm", "soffice.data", "soffice.worker.js"]) {
  const from = path.join(srcWasm, name);
  if (!fs.existsSync(from)) {
    console.warn(`[copy-lo-wasm] missing ${name}`);
    continue;
  }
  fs.copyFileSync(from, path.join(dest, name));
}
if (fs.existsSync(srcWorker)) {
  fs.copyFileSync(srcWorker, path.join(dest, "browser.worker.global.js"));
}
console.log("[copy-lo-wasm] LibreOffice WASM assets ready in public/lo-wasm");
