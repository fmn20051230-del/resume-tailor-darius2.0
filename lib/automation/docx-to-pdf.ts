/**
 * Converts DOCX → PDF from the real DOCX bytes (no OpenRouter / no HTML resume rebuild).
 *
 * Engines (via open-source docx-to-pdf-lite):
 *   1. Microsoft Word COM on Windows — identical to the DOCX (localhost)
 *   2. System LibreOffice when installed
 *   3. docx-preview + PlutoPrint (pure Node, works on Vercel) — Word-oriented layout
 *   4. Optional ConvertAPI if a secret is configured
 */
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const PDF_CONVERT_ATTEMPTS = 3;

function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Open-source converter: Word → LibreOffice → docx-preview/PlutoPrint.
 * On Vercel, Word/LibreOffice are unavailable so the preview engine runs.
 */
async function convertWithDocxToPdfLite(
  docxBuffer: Buffer,
  engine: "auto" | "msword" | "libreoffice" | "preview"
): Promise<Buffer | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "docx2pdf-lite-"));
  const docxPath = path.join(dir, "resume.docx");
  const pdfPath = path.join(dir, "resume.pdf");

  try {
    await writeFile(docxPath, docxBuffer);
    const { convertDocxToPdf } = require("docx-to-pdf-lite") as {
      convertDocxToPdf: (
        input: string,
        output: string,
        options?: {
          engine?: "auto" | "msword" | "libreoffice" | "preview";
          format?: "A4" | "Letter";
          timeout?: number;
        }
      ) => Promise<void>;
    };

    await convertDocxToPdf(docxPath, pdfPath, {
      engine,
      format: "Letter",
      timeout: 120_000,
    });

    const pdf = await readFile(pdfPath);
    return pdf.length ? pdf : null;
  } catch (err) {
    console.warn(
      `[pdf] docx-to-pdf-lite (${engine}) failed:`,
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
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
    console.warn("[pdf] ConvertAPI failed:", res.status, body.slice(0, 300));
    return null;
  }

  const json = (await res.json()) as {
    Files?: Array<{ FileData?: string; Url?: string }>;
  };
  const file = json.Files?.[0];
  if (!file) throw new ConvertApiRetryError("ConvertAPI response missing Files");
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
    "[pdf] ConvertAPI failed after retries:",
    lastError instanceof Error ? lastError.message : lastError
  );
  return null;
}

async function convertDocxToPdfOnce(
  docxBuffer: Buffer,
  convertApiSecret?: string | null
): Promise<Buffer | null> {
  // Optional ConvertAPI first when configured (closest to Word on Vercel).
  const fromConvertApi = await convertWithConvertApi(docxBuffer, convertApiSecret);
  if (fromConvertApi?.length) return fromConvertApi;

  if (isServerless()) {
    // Vercel: open-source docx-preview + PlutoPrint (Word-oriented, no LibreOffice binary).
    return convertWithDocxToPdfLite(docxBuffer, "preview");
  }

  // Local: Word first (identical), then LibreOffice, then preview.
  const fromAuto = await convertWithDocxToPdfLite(docxBuffer, "auto");
  if (fromAuto?.length) return fromAuto;

  return convertWithDocxToPdfLite(docxBuffer, "preview");
}

export type ConvertDocxToPdfOptions = {
  convertApiSecret?: string | null;
};

/** Convert DOCX bytes → PDF bytes. Never uses OpenRouter. */
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

  console.warn("[pdf] Could not convert DOCX→PDF after retries.");
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
  return true;
}
