import { NextResponse } from "next/server";
import {
  getDefaultOutputDir,
  loadBaseResumes,
  loadExtractionPrompt,
  loadTailoringPrompt,
} from "@/lib/automation/config-loader";

export async function GET() {
  return NextResponse.json({
    extractionPrompt: loadExtractionPrompt(),
    tailoringPrompt: loadTailoringPrompt(),
    baseResumes: loadBaseResumes(),
    outputDir: getDefaultOutputDir(),
  });
}
