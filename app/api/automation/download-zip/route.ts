import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { resolveOutputRoot } from "@/lib/automation/folder-output";

function sanitizeZipName(zipFileName: string): string {
  const safe = zipFileName.replace(/[^\w.\-() ]+/g, "_");
  return safe.toLowerCase().endsWith(".zip") ? safe : `${safe}.zip`;
}

function isPathInsideRoot(folderPath: string, root: string): boolean {
  const resolvedFolder = path.resolve(folderPath);
  const resolvedRoot = path.resolve(root);
  return resolvedFolder === resolvedRoot || resolvedFolder.startsWith(`${resolvedRoot}${path.sep}`);
}

export async function POST(request: NextRequest) {
  let body: { outputDir?: string; zipFileName?: string; folderPaths?: string[] };
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

  const folderPaths = Array.isArray(body.folderPaths)
    ? body.folderPaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : [];

  if (!fs.existsSync(root) && folderPaths.length === 0) {
    return NextResponse.json({ error: "Output folder is empty" }, { status: 404 });
  }

  try {
    const zip = new AdmZip();

    if (folderPaths.length > 0) {
      let added = 0;
      for (const folderPath of folderPaths) {
        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) continue;
        if (!isPathInsideRoot(folderPath, root)) continue;
        zip.addLocalFolder(folderPath, path.basename(folderPath));
        added++;
      }
      if (added === 0) {
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
      zip.addLocalFolder(root);
    } else {
      return NextResponse.json({ error: "Output folder is empty" }, { status: 404 });
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
