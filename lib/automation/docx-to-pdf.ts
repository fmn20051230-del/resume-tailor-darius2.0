/**
 * Converts DOCX → PDF from the real DOCX bytes (no OpenRouter / no HTML resume rebuild).
 *
 * Priority:
 *   1. ConvertAPI when token/secret is set (UI Settings or CONVERTAPI_* env) — Word-quality on Vercel
 *   2. Localhost: Microsoft Word / LibreOffice via docx-to-pdf-lite
 *   3. Fallback: docx-preview + PlutoPrint (layout can differ from Word)
 */
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const PDF_CONVERT_ATTEMPTS = 3;
const CONVERT_API_URL = "https://v2.convertapi.com/convert/docx/to/pdf";

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

/** Normalize pasted tokens (strip Bearer prefix / whitespace). */
export function normalizeConvertApiToken(raw?: string | null): string | null {
  if (!raw) return null;
  let token = raw.trim();
  if (!token) return null;
  if (/^bearer\s+/i.test(token)) token = token.replace(/^bearer\s+/i, "").trim();
  return token || null;
}

export function getConvertApiCredential(override?: string | null): string | null {
  return (
    normalizeConvertApiToken(override) ||
    normalizeConvertApiToken(process.env.CONVERTAPI_SECRET) ||
    normalizeConvertApiToken(process.env.CONVERTAPI_TOKEN)
  );
}

/** True when ConvertAPI can be used (request override or Vercel env). */
export function isConvertApiConfigured(override?: string | null): boolean {
  return Boolean(getConvertApiCredential(override));
}

class ConvertApiError extends Error {
  constructor(
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = "ConvertApiError";
  }
}

async function downloadConvertApiFile(file: {
  FileData?: string;
  Url?: string;
  FileUrl?: string;
}): Promise<Buffer | null> {
  if (file.FileData) {
    const pdf = Buffer.from(file.FileData, "base64");
    if (pdf.length >= 5 && pdf.subarray(0, 5).toString("utf8") === "%PDF-") {
      return pdf;
    }
    if (pdf.length) return pdf;
  }
  const url = file.Url || file.FileUrl;
  if (url) {
    const fileRes = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!fileRes.ok) {
      throw new ConvertApiError(
        `ConvertAPI download failed: ${fileRes.status}`,
        true
      );
    }
    const pdf = Buffer.from(await fileRes.arrayBuffer());
    return pdf.length ? pdf : null;
  }
  return null;
}

async function parseConvertApiResponse(res: Response): Promise<Buffer> {
  const contentType = (res.headers.get("content-type") || "").toLowerCase();

  if (
    contentType.includes("application/pdf") ||
    contentType.includes("application/octet-stream")
  ) {
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new ConvertApiError(
        `ConvertAPI ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        res.status === 429 || res.status >= 500
      );
    }
    const pdf = Buffer.from(await res.arrayBuffer());
    if (!pdf.length) {
      throw new ConvertApiError("ConvertAPI returned empty PDF body", true);
    }
    return pdf;
  }

  const text = await res.text();
  let json: {
    Files?: Array<{ FileData?: string; Url?: string; FileUrl?: string }>;
    Message?: string;
    message?: string;
    Code?: number | string;
  };
  try {
    json = JSON.parse(text) as typeof json;
  } catch {
    const asBuf = Buffer.from(text, "binary");
    if (asBuf.length >= 5 && asBuf.subarray(0, 5).toString("utf8") === "%PDF-") {
      return asBuf;
    }
    throw new ConvertApiError(
      `ConvertAPI returned non-JSON response (${res.status}): ${text.slice(0, 200)}`,
      res.status >= 500 || res.status === 429
    );
  }

  if (!res.ok) {
    const msg =
      json.Message ||
      json.message ||
      text.slice(0, 240) ||
      `HTTP ${res.status}`;
    throw new ConvertApiError(
      `ConvertAPI ${res.status}: ${msg}`,
      res.status === 429 || res.status >= 500
    );
  }

  const file = json.Files?.[0];
  if (!file) {
    throw new ConvertApiError(
      `ConvertAPI response missing Files: ${text.slice(0, 240)}`,
      true
    );
  }
  const pdf = await downloadConvertApiFile(file);
  if (!pdf?.length) {
    throw new ConvertApiError(
      "ConvertAPI Files entry had no FileData/Url",
      true
    );
  }
  return pdf;
}

/**
 * ConvertAPI upload: multipart (matches their curl examples) is most reliable.
 * Auth: Bearer, then ?auth=, then legacy ?Secret=.
 */
async function convertWithConvertApiOnce(
  docxBuffer: Buffer,
  secret: string
): Promise<Buffer> {
  const attempts: Array<{ label: string; url: string; headers: HeadersInit }> = [
    {
      label: "Bearer",
      url: CONVERT_API_URL,
      headers: {
        Authorization: `Bearer ${secret}`,
        Accept: "application/json",
      },
    },
    {
      label: "auth query",
      url: `${CONVERT_API_URL}?auth=${encodeURIComponent(secret)}`,
      headers: { Accept: "application/json" },
    },
    {
      label: "Secret query",
      url: `${CONVERT_API_URL}?Secret=${encodeURIComponent(secret)}`,
      headers: { Accept: "application/json" },
    },
  ];

  let lastErr: ConvertApiError | null = null;

  for (const attempt of attempts) {
    const body = new FormData();
    body.append(
      "File",
      new Blob([new Uint8Array(docxBuffer)], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      }),
      "resume.docx"
    );
    body.append("StoreFile", "true");

    const res = await fetch(attempt.url, {
      method: "POST",
      headers: attempt.headers,
      body,
      signal: AbortSignal.timeout(90_000),
    });

    try {
      return await parseConvertApiResponse(res);
    } catch (err) {
      const apiErr =
        err instanceof ConvertApiError
          ? err
          : new ConvertApiError(
              err instanceof Error ? err.message : String(err),
              true
            );
      lastErr = new ConvertApiError(
        `${apiErr.message} (via ${attempt.label})`,
        apiErr.retryable
      );
      console.warn(`[pdf] ConvertAPI ${attempt.label} failed:`, lastErr.message);
      // Keep trying alternate auth styles (Bearer / auth= / Secret=).
    }
  }

  throw lastErr ?? new ConvertApiError("ConvertAPI authentication failed");
}

async function convertWithConvertApi(
  docxBuffer: Buffer,
  convertApiSecret?: string | null
): Promise<{ pdf: Buffer | null; error?: string }> {
  const secret = getConvertApiCredential(convertApiSecret);
  if (!secret) return { pdf: null, error: "ConvertAPI token not configured" };

  let lastError: string | undefined;
  for (let attempt = 1; attempt <= PDF_CONVERT_ATTEMPTS; attempt++) {
    try {
      const pdf = await convertWithConvertApiOnce(docxBuffer, secret);
      if (pdf?.length) return { pdf };
      lastError = "ConvertAPI returned empty PDF";
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      const retryable =
        err instanceof ConvertApiError
          ? err.retryable
          : /timeout|aborted|fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(
              lastError
            );
      if (!retryable || attempt >= PDF_CONVERT_ATTEMPTS) break;
      await sleep(1000 * Math.pow(2, attempt - 1));
      continue;
    }
    if (attempt < PDF_CONVERT_ATTEMPTS) {
      await sleep(1000 * Math.pow(2, attempt - 1));
    }
  }

  console.warn("[pdf] ConvertAPI failed after retries:", lastError);
  return { pdf: null, error: lastError };
}

let lastConvertError: string | undefined;

async function convertDocxToPdfOnce(
  docxBuffer: Buffer,
  convertApiSecret?: string | null
): Promise<Buffer | null> {
  const convertApiReady = isConvertApiConfigured(convertApiSecret);

  if (convertApiReady) {
    const { pdf, error } = await convertWithConvertApi(docxBuffer, convertApiSecret);
    if (pdf?.length) {
      lastConvertError = undefined;
      return pdf;
    }
    lastConvertError = error;
    // On Vercel with ConvertAPI configured, do not silently use a different layout engine.
    if (isServerless()) {
      console.warn("[pdf] ConvertAPI failed on Vercel; skipping preview fallback.");
      return null;
    }
  } else {
    lastConvertError = isServerless()
      ? "ConvertAPI token missing (required on Vercel)"
      : undefined;
  }

  if (isServerless()) {
    return convertWithDocxToPdfLite(docxBuffer, "preview");
  }

  const fromAuto = await convertWithDocxToPdfLite(docxBuffer, "auto");
  if (fromAuto?.length) return fromAuto;

  return convertWithDocxToPdfLite(docxBuffer, "preview");
}

export type ConvertDocxToPdfOptions = {
  convertApiSecret?: string | null;
};

export type ConvertDocxToPdfResult = {
  pdf: Buffer | null;
  error?: string;
};

/** Convert DOCX bytes → PDF bytes, with error detail for the UI. */
export async function convertDocxToPdfDetailed(
  docxBuffer: Buffer,
  options?: ConvertDocxToPdfOptions
): Promise<ConvertDocxToPdfResult> {
  if (!docxBuffer?.length) {
    return { pdf: null, error: "Empty DOCX" };
  }

  lastConvertError = undefined;
  for (let attempt = 1; attempt <= PDF_CONVERT_ATTEMPTS; attempt++) {
    try {
      const pdf = await convertDocxToPdfOnce(docxBuffer, options?.convertApiSecret);
      if (pdf?.length) return { pdf };
    } catch (err) {
      lastConvertError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[pdf] DOCX→PDF attempt ${attempt}/${PDF_CONVERT_ATTEMPTS} error:`,
        lastConvertError
      );
    }
    if (attempt < PDF_CONVERT_ATTEMPTS) {
      await sleep(1000 * attempt);
    }
  }

  return {
    pdf: null,
    error:
      lastConvertError ||
      "Could not convert DOCX→PDF after retries. Check ConvertAPI token.",
  };
}

/** Convert DOCX bytes → PDF bytes. Never uses OpenRouter. */
export async function convertDocxToPdf(
  docxBuffer: Buffer,
  options?: ConvertDocxToPdfOptions
): Promise<Buffer | null> {
  const { pdf } = await convertDocxToPdfDetailed(docxBuffer, options);
  return pdf;
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

export function isPdfConversionConfigured(convertApiSecret?: string | null): boolean {
  if (!isServerless()) return true;
  return isConvertApiConfigured(convertApiSecret);
}
