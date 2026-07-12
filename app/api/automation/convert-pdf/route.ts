import { NextRequest, NextResponse } from "next/server";
import { convertDocxToPdfDetailed } from "@/lib/automation/docx-to-pdf";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * Convert an existing DOCX (base64) → PDF (base64).
 * Used to backfill missing PDFs so every resume in the ZIP has both files.
 * Does not call OpenRouter — only ConvertAPI / Word / LibreOffice.
 */
export async function POST(request: NextRequest) {
  let body: {
    docxBase64?: string;
    fileName?: string;
    convertApiSecret?: string;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const docxBase64 =
    typeof body.docxBase64 === "string" ? body.docxBase64.trim() : "";
  if (!docxBase64) {
    return NextResponse.json({ error: "Missing docxBase64" }, { status: 400 });
  }

  let docxBuffer: Buffer;
  try {
    docxBuffer = Buffer.from(docxBase64, "base64");
  } catch {
    return NextResponse.json({ error: "Invalid docxBase64" }, { status: 400 });
  }

  if (!docxBuffer.length) {
    return NextResponse.json({ error: "Empty DOCX" }, { status: 400 });
  }

  const convertApiSecret =
    typeof body.convertApiSecret === "string" && body.convertApiSecret.trim()
      ? body.convertApiSecret.trim()
      : undefined;

  try {
    const { pdf: pdfBuffer, error } = await convertDocxToPdfDetailed(docxBuffer, {
      convertApiSecret,
    });
    if (!pdfBuffer?.length) {
      return NextResponse.json(
        {
          error:
            error ||
            "DOCX→PDF failed. Paste your ConvertAPI Production token on the Dashboard, or set CONVERTAPI_SECRET / CONVERTAPI_TOKEN on Vercel.",
        },
        { status: 502 }
      );
    }

    const resumeFileName =
      typeof body.fileName === "string" && body.fileName.trim()
        ? body.fileName.trim()
        : "resume.docx";
    const pdfFileName = resumeFileName.replace(/\.docx$/i, ".pdf");

    return NextResponse.json({
      pdfBase64: pdfBuffer.toString("base64"),
      pdfFileName,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : "DOCX→PDF conversion failed",
      },
      { status: 502 }
    );
  }
}
