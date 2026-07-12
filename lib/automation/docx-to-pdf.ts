/**
 * Converts a generated DOCX resume to PDF from the real DOCX bytes (no OpenRouter).
 *
 * Order:
 *   1. Microsoft Word COM (Windows localhost)
 *   2. LibreOffice (local non-serverless)
 *   3. Open-source: mammoth (DOCX→HTML) + @sparticuz/chromium (HTML→PDF) — works on Vercel, no API
 *   4. Optional ConvertAPI if CONVERTAPI_SECRET / Settings secret is set (closer to Word layout)
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

/**
 * Open-source DOCX→PDF for Vercel: mammoth renders the DOCX to HTML, then
 * headless Chromium prints that HTML to PDF. No external conversion API.
 */
async function convertWithMammothChromium(docxBuffer: Buffer): Promise<Buffer | null> {
  try {
    const mammoth = await import("mammoth");
    const result = await mammoth.convertToHtml({ buffer: docxBuffer });
    const bodyHtml = result.value?.trim();
    if (!bodyHtml) {
      console.warn("[pdf] mammoth returned empty HTML");
      return null;
    }

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @page { margin: 0.6in; size: Letter; }
    html, body {
      margin: 0;
      padding: 0;
      background: #fff;
      color: #111;
      font-family: Calibri, "Segoe UI", Arial, sans-serif;
      font-size: 11pt;
      line-height: 1.35;
    }
    body { padding: 0.15in 0.1in; }
    p { margin: 0 0 6pt 0; }
    h1 { font-size: 18pt; margin: 0 0 8pt 0; text-align: center; }
    h2 { font-size: 12pt; margin: 14pt 0 6pt 0; border-bottom: 1px solid #333; padding-bottom: 2pt; }
    h3 { font-size: 11pt; margin: 8pt 0 4pt 0; }
    ul, ol { margin: 0 0 6pt 18pt; padding: 0; }
    li { margin: 0 0 3pt 0; }
    a { color: #0645ad; text-decoration: none; }
    table { border-collapse: collapse; width: 100%; }
    td, th { vertical-align: top; }
  </style>
</head>
<body>${bodyHtml}</body>
</html>`;

    const chromium = (await import("@sparticuz/chromium")).default;
    const puppeteer = await import("puppeteer-core");

    const executablePath = await chromium.executablePath();
    const browser = await puppeteer.default.launch({
      args: chromium.args,
      executablePath,
      headless: true,
      defaultViewport: { width: 816, height: 1056, deviceScaleFactor: 1 },
    });

    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load", timeout: 60_000 });
      const pdf = await page.pdf({
        format: "Letter",
        printBackground: true,
        margin: { top: "0.55in", right: "0.55in", bottom: "0.55in", left: "0.55in" },
      });
      return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (err) {
    console.warn(
      "[pdf] mammoth+Chromium DOCX→PDF failed:",
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

/** Optional paid ConvertAPI — only used when a secret is configured. */
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
  if (!isServerless()) {
    const fromWord = await convertWithWord(docxBuffer);
    if (fromWord?.length) return fromWord;

    const fromLibre = await convertWithLibreOffice(docxBuffer);
    if (fromLibre?.length) return fromLibre;
  }

  // Optional ConvertAPI (closer to Word) when user configured a secret.
  const fromConvertApi = await convertWithConvertApi(docxBuffer, convertApiSecret);
  if (fromConvertApi?.length) return fromConvertApi;

  // Open-source path for Vercel / when Word & LibreOffice are unavailable.
  const fromChromium = await convertWithMammothChromium(docxBuffer);
  if (fromChromium?.length) return fromChromium;

  return null;
}

export type ConvertDocxToPdfOptions = {
  /** Optional ConvertAPI secret (overrides env). Not required — open-source Chromium is used otherwise. */
  convertApiSecret?: string | null;
};

/**
 * Convert DOCX bytes to PDF bytes. Never regenerates via LLM / OpenRouter.
 */
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
    "[pdf] Could not convert DOCX→PDF after retries (Word / LibreOffice / mammoth+Chromium / ConvertAPI)."
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
  // Open-source mammoth+Chromium works on Vercel without any API key.
  return true;
}
