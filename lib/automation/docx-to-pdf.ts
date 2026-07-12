/**
 * Converts a generated DOCX resume to PDF (same layout as the Word file).
 * Order: Microsoft Word COM (Windows) → LibreOffice (local) → ConvertAPI (serverless)
 * → simple pdf-lib fallback from markdown (always available on Vercel).
 */
import { execFile } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const execFileAsync = promisify(execFile);

function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

async function convertWithWord(docxBuffer: Buffer): Promise<Buffer | null> {
  if (process.platform !== "win32") return null;

  const dir = await mkdtemp(path.join(tmpdir(), "resume-docx2pdf-"));
  const docxPath = path.join(dir, "resume.docx");
  const pdfPath = path.join(dir, "resume.pdf");

  try {
    await writeFile(docxPath, docxBuffer);

    // Word COM SaveAs format: wdFormatPDF = 17
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
  // LibreOffice binary is not available on Vercel; the package is stubbed there.
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

function getConvertApiCredential(): string | null {
  return (
    process.env.CONVERTAPI_SECRET?.trim() ||
    process.env.CONVERTAPI_TOKEN?.trim() ||
    null
  );
}

/**
 * ConvertAPI keeps Word layout fidelity on serverless hosts where Word/LibreOffice
 * are unavailable. Set CONVERTAPI_SECRET (or CONVERTAPI_TOKEN) in Vercel env vars.
 * https://www.convertapi.com/docx-to-pdf
 */
async function convertWithConvertApi(docxBuffer: Buffer): Promise<Buffer | null> {
  const secret = getConvertApiCredential();
  if (!secret) {
    if (isServerless()) {
      console.warn(
        "[pdf] CONVERTAPI_SECRET not set — will use markdown PDF fallback on Vercel"
      );
    }
    return null;
  }

  try {
    const res = await fetch("https://v2.convertapi.com/convert/docx/to/pdf", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
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
      }),
      signal: AbortSignal.timeout(90_000),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn(
        "[pdf] ConvertAPI DOCX→PDF failed:",
        res.status,
        body.slice(0, 300)
      );
      return null;
    }

    const json = (await res.json()) as {
      Files?: Array<{ FileData?: string; Url?: string }>;
    };
    const file = json.Files?.[0];
    if (file?.FileData) {
      const pdf = Buffer.from(file.FileData, "base64");
      return pdf.length ? pdf : null;
    }

    if (file?.Url) {
      const fileRes = await fetch(file.Url, { signal: AbortSignal.timeout(60_000) });
      if (!fileRes.ok) {
        console.warn("[pdf] ConvertAPI download failed:", fileRes.status);
        return null;
      }
      const ab = await fileRes.arrayBuffer();
      const pdf = Buffer.from(ab);
      return pdf.length ? pdf : null;
    }

    console.warn("[pdf] ConvertAPI response missing file data");
    return null;
  } catch (err) {
    console.warn(
      "[pdf] ConvertAPI DOCX→PDF failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Strip markdown markers for a plain-text PDF fallback. */
function markdownToPlainLines(markdown: string): string[] {
  return markdown
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/^[-*+]\s+/, "• ")
        .replace(/^\d+\.\s+/, "")
        .replace(/`([^`]+)`/g, "$1")
        .trimEnd()
    );
}

/**
 * Last-resort PDF when Word/LibreOffice/ConvertAPI are unavailable (typical on Vercel).
 * Layout is plain text — not identical to the DOCX template — but always produces a PDF.
 */
export async function convertMarkdownToPdf(markdown: string): Promise<Buffer | null> {
  const text = markdown?.trim();
  if (!text) return null;

  try {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const fontSize = 10;
    const lineHeight = 13;
    const margin = 50;
    const pageWidth = 612;
    const pageHeight = 792;
    const maxWidth = pageWidth - margin * 2;

    let page = doc.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    const wrapLine = (line: string, useBold: boolean): void => {
      const f = useBold ? bold : font;
      const words = line.length ? line.split(/\s+/) : [""];
      let current = "";
      const flush = (chunk: string) => {
        if (y < margin + lineHeight) {
          page = doc.addPage([pageWidth, pageHeight]);
          y = pageHeight - margin;
        }
        page.drawText(chunk || " ", {
          x: margin,
          y,
          size: fontSize,
          font: f,
          color: rgb(0.1, 0.1, 0.1),
          maxWidth,
        });
        y -= lineHeight;
      };

      for (const word of words) {
        const next = current ? `${current} ${word}` : word;
        const width = f.widthOfTextAtSize(next, fontSize);
        if (width > maxWidth && current) {
          flush(current);
          current = word;
        } else {
          current = next;
        }
      }
      flush(current);
    };

    for (const raw of markdownToPlainLines(text)) {
      if (!raw.trim()) {
        y -= lineHeight * 0.5;
        continue;
      }
      const isHeading =
        /^[A-Z][A-Za-z0-9 /&-]{2,40}$/.test(raw.trim()) ||
        /^(Summary|Experience|Education|Skills|Certifications|Projects)\b/i.test(
          raw.trim()
        );
      wrapLine(raw, isHeading);
    }

    const bytes = await doc.save();
    return Buffer.from(bytes);
  } catch (err) {
    console.warn(
      "[pdf] markdown PDF fallback failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

/** Convert DOCX bytes to PDF bytes. Returns null if no converter is available. */
export async function convertDocxToPdf(docxBuffer: Buffer): Promise<Buffer | null> {
  if (!docxBuffer?.length) return null;

  const fromWord = await convertWithWord(docxBuffer);
  if (fromWord?.length) return fromWord;

  const fromLibre = await convertWithLibreOffice(docxBuffer);
  if (fromLibre?.length) return fromLibre;

  const fromConvertApi = await convertWithConvertApi(docxBuffer);
  if (fromConvertApi?.length) return fromConvertApi;

  console.warn(
    "[pdf] Word/LibreOffice/ConvertAPI unavailable for DOCX→PDF."
  );
  return null;
}

/**
 * Prefer layout-faithful DOCX→PDF; if that fails, fall back to a markdown PDF
 * so deployed ZIPs still include a .pdf file.
 */
export async function convertResumeToPdfBuffer(input: {
  docxBuffer: Buffer;
  resumeMarkdown?: string;
}): Promise<Buffer | null> {
  const fromDocx = await convertDocxToPdf(input.docxBuffer);
  if (fromDocx?.length) return fromDocx;

  if (input.resumeMarkdown?.trim()) {
    const fromMd = await convertMarkdownToPdf(input.resumeMarkdown);
    if (fromMd?.length) {
      console.warn("[pdf] Using markdown PDF fallback (layout differs from DOCX).");
      return fromMd;
    }
  }

  return null;
}

/** @deprecated Use convertDocxToPdf / convertResumeToPdfBuffer */
export async function convertResumeToPdf(input: {
  docxBuffer: Buffer;
  resumeMarkdown?: string;
  baseResume?: string;
}): Promise<Buffer | null> {
  return convertResumeToPdfBuffer({
    docxBuffer: input.docxBuffer,
    resumeMarkdown: input.resumeMarkdown,
  });
}
