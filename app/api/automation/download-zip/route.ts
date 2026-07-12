import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { resolveOutputRoot } from "@/lib/automation/folder-output";
import { convertDocxToPdf } from "@/lib/automation/docx-to-pdf";

export const maxDuration = 300;

function sanitizeZipName(zipFileName: string): string {
  const safe = zipFileName.replace(/[^\w.\-() ]+/g, "_");
  return safe.toLowerCase().endsWith(".zip") ? safe : `${safe}.zip`;
}

function isPathInsideRoot(folderPath: string, root: string): boolean {
  const resolvedFolder = path.resolve(folderPath);
  const resolvedRoot = path.resolve(root);
  return resolvedFolder === resolvedRoot || resolvedFolder.startsWith(`${resolvedRoot}${path.sep}`);
}

/** If a folder has a .docx but no .pdf, convert DOCX→PDF in place. */
async function ensurePdfInFolder(folderPath: string): Promise<void> {
  const entries = fs.readdirSync(folderPath);
  const docxName = entries.find((n) => /\.docx$/i.test(n));
  if (!docxName) return;
  const pdfName = docxName.replace(/\.docx$/i, ".pdf");
  if (entries.some((n) => n.toLowerCase() === pdfName.toLowerCase())) return;

  const docxPath = path.join(folderPath, docxName);
  const docxBuffer = fs.readFileSync(docxPath);
  const pdfBuffer = await convertDocxToPdf(docxBuffer);
  if (pdfBuffer?.length) {
    fs.writeFileSync(path.join(folderPath, pdfName), pdfBuffer);
  }
}

export async function POST(request: NextRequest) {
  let body: {
    outputDir?: string;
    zipFileName?: string;
    folderPaths?: string[];
    ensurePdf?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const outputDir =
    (typeof body.outputDir === "string" && body.outputDir.trim()) || "output";
  const zipFileName =
    (typeof body.zipFileName === "string" && body.zipFileName.trim()) || "resume-output.zip";
  const safeZipName = sanitizeZipName(zipFileName);
  const root = resolveOutputRoot(outputDir);
  const ensurePdf = body.ensurePdf !== false;

  const folderPaths = Array.isArray(body.folderPaths)
    ? body.folderPaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : [];

  if (!fs.existsSync(root) && folderPaths.length === 0) {
    return NextResponse.json({ error: "Output folder is empty" }, { status: 404 });
  }

  try {
    const zip = new AdmZip();
    const foldersToZip: string[] = [];

    if (folderPaths.length > 0) {
      for (const folderPath of folderPaths) {
        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) continue;
        if (!isPathInsideRoot(folderPath, root)) continue;
        foldersToZip.push(folderPath);
      }
      if (foldersToZip.length === 0) {
        return NextResponse.json(
          {
            error:
              process.env.VERCEL
                ? "On Vercel, batch folders are cleared after the run. Re-run generate — the ZIP downloads automatically when the batch finishes."
                : "No batch folders found to zip",
          },
          { status: 404 }
        );
      }
    } else if (fs.existsSync(root)) {
      for (const name of fs.readdirSync(root)) {
        const full = path.join(root, name);
        if (fs.statSync(full).isDirectory()) foldersToZip.push(full);
      }
      if (foldersToZip.length === 0) {
        return NextResponse.json({ error: "Output folder is empty" }, { status: 404 });
      }
    } else {
      return NextResponse.json({ error: "Output folder is empty" }, { status: 404 });
    }

    if (ensurePdf) {
      for (const folderPath of foldersToZip) {
        try {
          await ensurePdfInFolder(folderPath);
        } catch (err) {
          console.warn(
            `[zip] PDF backfill failed for ${folderPath}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }

    for (const folderPath of foldersToZip) {
      zip.addLocalFolder(folderPath, path.basename(folderPath));
    }

    const buffer = zip.toBuffer();

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${safeZipName}"`,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "ZIP creation failed" },
      { status: 500 }
    );
  }
}
