/**
 * Browser-side DOCX → PDF using open-source LibreOffice WASM.
 * Same engine as LibreOffice desktop — converts the real DOCX (not HTML re-layout).
 * WASM assets are served from /lo-wasm/ (copied on postinstall). No ConvertAPI / OpenRouter.
 */

type BrowserConverter = {
  initialize: () => Promise<void>;
  convert: (
    input: Uint8Array | ArrayBuffer,
    options: { outputFormat: "pdf" },
    filename?: string
  ) => Promise<{ data: Uint8Array | ArrayBuffer }>;
  destroy: () => Promise<void>;
};

let converterPromise: Promise<BrowserConverter> | null = null;

async function getBrowserConverter(): Promise<BrowserConverter> {
  if (!converterPromise) {
    converterPromise = (async () => {
      const mod = await import("@matbee/libreoffice-converter/browser");
      const converter = new mod.WorkerBrowserConverter({
        ...mod.createWasmPaths("/lo-wasm/"),
        browserWorkerJs: "/lo-wasm/browser.worker.global.js",
        verbose: false,
      });
      await converter.initialize();
      return converter as BrowserConverter;
    })().catch((err) => {
      converterPromise = null;
      throw err;
    });
  }
  return converterPromise;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Convert DOCX base64 → PDF base64 in the browser via LibreOffice WASM. */
export async function convertDocxBase64ToPdfInBrowser(
  docxBase64: string
): Promise<string | null> {
  const docxBytes = base64ToUint8Array(docxBase64);
  if (!docxBytes.length) return null;

  const converter = await getBrowserConverter();
  const result = await converter.convert(
    docxBytes,
    { outputFormat: "pdf" },
    "resume.docx"
  );
  if (!result?.data) return null;
  const data =
    result.data instanceof Uint8Array
      ? result.data
      : new Uint8Array(result.data);
  if (!data.length) return null;
  return uint8ArrayToBase64(data);
}
