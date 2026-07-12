import { NextResponse } from "next/server";
import {
  getDefaultOutputDir,
  loadBaseResumes,
  loadExtractionPrompt,
  loadTailoringPrompt,
} from "@/lib/automation/config-loader";

export async function GET() {
  const convertApiConfigured = Boolean(
    process.env.CONVERTAPI_SECRET?.trim() || process.env.CONVERTAPI_TOKEN?.trim()
  );

  return NextResponse.json({
    extractionPrompt: loadExtractionPrompt(),
    tailoringPrompt: loadTailoringPrompt(),
    baseResumes: loadBaseResumes(),
    outputDir: getDefaultOutputDir(),
    /** True when CONVERTAPI_SECRET or CONVERTAPI_TOKEN is set on the server (e.g. Vercel). */
    convertApiConfigured,
  });
}
