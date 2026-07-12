import { NextRequest, NextResponse } from "next/server";
import { clearOutputDirectory } from "@/lib/automation/folder-output";
import { getDefaultOutputDir } from "@/lib/automation/config-loader";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: { outputDir?: string };
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const outputDir =
    (typeof body.outputDir === "string" && body.outputDir.trim()) || getDefaultOutputDir();

  try {
    clearOutputDirectory(outputDir);
    return NextResponse.json({ ok: true, outputDir });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not prepare output folder" },
      { status: 500 }
    );
  }
}
