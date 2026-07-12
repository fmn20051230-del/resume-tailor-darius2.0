/**
 * Converts a generated DOCX resume to PDF from the real DOCX bytes (no OpenRouter).
 * Preserves Word/LibreOffice layout — does NOT re-render via HTML/markdown.
 *
 * Order:
 *   1. Microsoft Word COM (Windows localhost)
 *   2. System LibreOffice (local)
 *   3. Open-source LibreOffice WASM (@matbee/libreoffice-converter) — works without API
 *   4. Optional ConvertAPI if a secret is set
 *
 * On Vercel serverless, WASM is too large for the function bundle — the browser
 * converts via /lo-wasm/ (see docx-to-pdf-browser.ts) before ZIP download.
 */
import { execFile } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const PDF_CONVERT_ATTEMPTS = 3;

function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function convertWithWord(docxBuffer: Buffer): Promise<Buffer | null> {
  if (process.platform !== "win32") return null;

  const dir = await mkdtemp(path.join(tmpdir(), "resume-docx2pdf-"));
  const docxPath = path.join(dir, "resume.docx");
  const pdfPath = path.join(dir, "resume.pdf");

  try {
    await writeFile(docxPath, docxBuffer);

    const ps = `
$ErrorActionPreference = 'Stop'
$word = $null
$doc = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0
  $doc = $word.Documents.Open('${docxPath.replace(/'/g, "''")}', $false, $true)
  $null = $doc.SaveAs([ref] '${pdfPath.replace(/'/g, "''")}', [ref] 17)
} finally {
  if ($doc -ne $null) { $doc.Close([ref] $false) | Out-Null }
  if ($word -ne $null) { $word.Quit() | Out-Null; [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null }
}
`;

    await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", ps],
      { timeout: 90_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
    );

    const pdf = await readFile(pdfPath);
    return pdf.length ? pdf : null;
  } catch (err) {
    console.warn(
      "[pdf] Word DOCX→PDF failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertWithLibreOffice(docxBuffer: Buffer): Promise<Buffer | null> {
  if (isServerless()) return null;

  try {
    const libre = await import("libreoffice-convert");
    const pdf = await new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("LibreOffice conversion timed out")),
        60_000
      );
      libre.default.convert(
        docxBuffer,
        ".pdf",
        undefined,
        (err: Error | null, data: Buffer) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve(Buffer.isBuffer(data) ? data : Buffer.from(data));
        }
      );
    });
    return pdf?.length ? pdf : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Could not find soffice|timed out|Cannot find package/i.test(msg)) {
      console.warn("[pdf] LibreOffice DOCX→PDF failed:", msg);
    }
    return null;
  }
}

/** Open-source LibreOffice compiled to WASM — real DOCX→PDF, no external API. */
async function convertWithLibreOfficeWasm(docxBuffer: Buffer): Promise<Buffer | null> {
  // Too large (~246MB) to bundle into a Vercel serverless function.
  if (isServerless()) return null;

  try {
    const { convertDocument } = await import("@matbee/libreoffice-converter/server");
    const wasmPath = path.join(
      process.cwd(),
      "node_modules",
      "@matbee",
      "libreoffice-converter",
      "wasm"
    );
    const result = await convertDocument(
      docxBuffer,
      { outputFormat: "pdf" },
      { wasmPath }
    );
    const data = result?.data;
    if (!data?.length) return null;
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
  } catch (err) {
    console.warn(
      "[pdf] LibreOffice WASM DOCX→PDF failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function getConvertApiCredential(override?: string | null): string | null {
  const fromOverride = override?.trim();
  if (fromOverride) return fromOverride;
  return (
    process.env.CONVERTAPI_SECRET?.trim() ||
    process.env.CONVERTAPI_TOKEN?.trim() ||
    null
  );
}

class ConvertApiRetryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConvertApiRetryError";
  }
}

async function downloadConvertApiFile(
  file: { FileData?: string; Url?: string }
): Promise<Buffer | null> {
  if (file.FileData) {
    const pdf = Buffer.from(file.FileData, "base64");
    return pdf.length ? pdf : null;
  }
  if (file.Url) {
    const fileRes = await fetch(file.Url, { signal: AbortSignal.timeout(60_000) });
    if (!fileRes.ok) {
      throw new ConvertApiRetryError(`ConvertAPI download failed: ${fileRes.status}`);
    }
    const pdf = Buffer.from(await fileRes.arrayBuffer());
    return pdf.length ? pdf : null;
  }
  return null;
}

async function convertWithConvertApiOnce(
  docxBuffer: Buffer,
  secret: string
): Promise<Buffer | null> {
  const payload = {
    Parameters: [
      {
        Name: "File",
        FileValue: {
          Name: "resume.docx",
          Data: docxBuffer.toString("base64"),
        },
      },
      { Name: "StoreFile", Value: "false" },
    ],
  };

  let res = await fetch("https://v2.convertapi.com/convert/docx/to/pdf", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(90_000),
  });

  if (res.status === 401 || res.status === 403) {
    res = await fetch(
      `https://v2.convertapi.com/convert/docx/to/pdf?Secret=${encodeURIComponent(secret)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(90_000),
      }
    );
  }

  if (res.status === 429 || res.status >= 500) {
    const body = await res.text().catch(() => "");
    throw new ConvertApiRetryError(
      `ConvertAPI ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn("[pdf] ConvertAPI DOCX→PDF failed:", res.status, body.slice(0, 300));
    return null;
  }

  const json = (await res.json()) as {
    Files?: Array<{ FileData?: string; Url?: string }>;
  };
  const file = json.Files?.[0];
  if (!file) {
    throw new ConvertApiRetryError("ConvertAPI response missing Files");
  }
  return downloadConvertApiFile(file);
}

async function convertWithConvertApi(
  docxBuffer: Buffer,
  convertApiSecret?: string | null
): Promise<Buffer | null> {
  const secret = getConvertApiCredential(convertApiSecret);
  if (!secret) return null;

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= PDF_CONVERT_ATTEMPTS; attempt++) {
    try {
      const pdf = await convertWithConvertApiOnce(docxBuffer, secret);
      if (pdf?.length) return pdf;
      lastError = new Error("ConvertAPI returned empty PDF");
    } catch (err) {
      lastError = err;
      const retryable =
        err instanceof ConvertApiRetryError ||
        (err instanceof Error &&
          /timeout|aborted|fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(
            err.message
          ));
      if (!retryable || attempt >= PDF_CONVERT_ATTEMPTS) break;
      await sleep(1000 * Math.pow(2, attempt - 1));
      continue;
    }
    if (attempt < PDF_CONVERT_ATTEMPTS) {
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }

  console.warn(
    "[pdf] ConvertAPI DOCX→PDF failed after retries:",
    lastError instanceof Error ? lastError.message : lastError
  );
  return null;
}

async function convertDocxToPdfOnce(
  docxBuffer: Buffer,
  convertApiSecret?: string | null
): Promise<Buffer | null> {
  if (isServerless()) {
    // Serverless: prefer ConvertAPI if configured; otherwise browser WASM backfill handles PDF.
    return convertWithConvertApi(docxBuffer, convertApiSecret);
  }

  const fromWord = await convertWithWord(docxBuffer);
  if (fromWord?.length) return fromWord;

  const fromLibre = await convertWithLibreOffice(docxBuffer);
  if (fromLibre?.length) return fromLibre;

  const fromWasm = await convertWithLibreOfficeWasm(docxBuffer);
  if (fromWasm?.length) return fromWasm;

  return convertWithConvertApi(docxBuffer, convertApiSecret);
}

export type ConvertDocxToPdfOptions = {
  convertApiSecret?: string | null;
};

/** Convert DOCX bytes → PDF bytes (layout-faithful). Never uses OpenRouter. */
export async function convertDocxToPdf(
  docxBuffer: Buffer,
  options?: ConvertDocxToPdfOptions
): Promise<Buffer | null> {
  if (!docxBuffer?.length) return null;

  for (let attempt = 1; attempt <= PDF_CONVERT_ATTEMPTS; attempt++) {
    try {
      const pdf = await convertDocxToPdfOnce(docxBuffer, options?.convertApiSecret);
      if (pdf?.length) return pdf;
    } catch (err) {
      console.warn(
        `[pdf] DOCX→PDF attempt ${attempt}/${PDF_CONVERT_ATTEMPTS} error:`,
        err instanceof Error ? err.message : err
      );
    }
    if (attempt < PDF_CONVERT_ATTEMPTS) {
      await sleep(1000 * attempt);
    }
  }

  console.warn(
    "[pdf] Server DOCX→PDF unavailable — browser LibreOffice WASM will convert before ZIP on Vercel."
  );
  return null;
}

export async function convertResumeToPdfBuffer(input: {
  docxBuffer: Buffer;
  resumeMarkdown?: string;
  convertApiSecret?: string | null;
}): Promise<Buffer | null> {
  return convertDocxToPdf(input.docxBuffer, {
    convertApiSecret: input.convertApiSecret,
  });
}

/** @deprecated Use convertDocxToPdf */
export async function convertResumeToPdf(input: {
  docxBuffer: Buffer;
  resumeMarkdown?: string;
  baseResume?: string;
  convertApiSecret?: string | null;
}): Promise<Buffer | null> {
  return convertDocxToPdf(input.docxBuffer, {
    convertApiSecret: input.convertApiSecret,
  });
}

export function isPdfConversionConfigured(_convertApiSecret?: string | null): boolean {
  // Browser LibreOffice WASM always available when /lo-wasm assets are deployed.
  return true;
}
