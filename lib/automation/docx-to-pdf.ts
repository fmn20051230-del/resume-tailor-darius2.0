/**
 * Converts a generated DOCX resume to PDF (same layout as the Word file).
 * Order: Microsoft Word COM (Windows) → LibreOffice (local) → ConvertAPI (serverless).
 * Does not regenerate layout from markdown.
 */
import { execFile } from "child_process";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";

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

/**
 * ConvertAPI keeps Word layout fidelity on serverless hosts where Word/LibreOffice
 * are unavailable. Set CONVERTAPI_SECRET in Vercel env vars.
 * https://www.convertapi.com/docx-to-pdf
 */
async function convertWithConvertApi(docxBuffer: Buffer): Promise<Buffer | null> {
  const secret = process.env.CONVERTAPI_SECRET?.trim();
  if (!secret) return null;

  try {
    const res = await fetch(
      `https://v2.convertapi.com/convert/docx/to/pdf?Secret=${encodeURIComponent(secret)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          Parameters: [
            {
              Name: "File",
              FileValue: {
                Name: "resume.docx",
                Data: docxBuffer.toString("base64"),
              },
            },
          ],
        }),
        signal: AbortSignal.timeout(90_000),
      }
    );

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

    // Some responses return a download URL instead of inline base64.
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
    "[pdf] Could not convert DOCX→PDF. Locally: install Microsoft Word or LibreOffice. On Vercel: set CONVERTAPI_SECRET."
  );
  return null;
}

/** @deprecated Use convertDocxToPdf — PDF is always derived from the DOCX. */
export async function convertResumeToPdf(input: {
  docxBuffer: Buffer;
  resumeMarkdown?: string;
  baseResume?: string;
}): Promise<Buffer | null> {
  return convertDocxToPdf(input.docxBuffer);
}
