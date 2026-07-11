import { NextRequest } from "next/server";
import { parseJobUrls } from "@/lib/automation/parse-urls";
import {
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  runAutomationPipeline,
} from "@/lib/automation/pipeline";
import type { AutomationRunConfig } from "@/lib/automation/types";
import {
  getDefaultOutputDir,
  loadBaseResumes,
  loadExtractionPrompt,
  loadTailoringPrompt,
} from "@/lib/automation/config-loader";
import { sanitizeResumeNamePrefix } from "@/lib/automation/folder-output";

export const dynamic = "force-dynamic";
/** Vercel Hobby max is 60s; Pro is 300s. Local `next dev` is unaffected. */
export const maxDuration = 60;

type RunBody = {
  urlsText?: string;
  extractionPrompt?: string;
  tailoringPrompt?: string;
  baseResumes?: string[];
  outputDir?: string;
  resumeNamePrefix?: string;
  apiKey?: string;
  concurrency?: number;
};

function resolveConcurrency(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(n)));
}

export async function POST(request: NextRequest) {
  let body: RunBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const urls = parseJobUrls(typeof body.urlsText === "string" ? body.urlsText : "");
  if (urls.length === 0) {
    return new Response(JSON.stringify({ error: "No valid URLs found in input." }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const extractionPrompt =
    (typeof body.extractionPrompt === "string" && body.extractionPrompt.trim()) ||
    loadExtractionPrompt();
  if (!extractionPrompt.trim()) {
    return new Response(
      JSON.stringify({
        error:
          "Extraction prompt is required. Paste your prompt in the UI or set config/extraction-prompt.txt.",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const tailoringPrompt =
    (typeof body.tailoringPrompt === "string" ? body.tailoringPrompt : "") ||
    loadTailoringPrompt();

  const defaultResumes = loadBaseResumes();
  const inputResumes = Array.isArray(body.baseResumes) ? body.baseResumes : [];
  const baseResumes: [string, string, string, string] = [
    inputResumes[0]?.trim() ? inputResumes[0] : defaultResumes[0],
    inputResumes[1]?.trim() ? inputResumes[1] : defaultResumes[1],
    inputResumes[2]?.trim() ? inputResumes[2] : defaultResumes[2],
    inputResumes[3]?.trim() ? inputResumes[3] : defaultResumes[3],
  ];

  const config: AutomationRunConfig = {
    urls,
    extractionPrompt,
    tailoringPrompt,
    baseResumes,
    outputDir:
      (typeof body.outputDir === "string" && body.outputDir.trim()) ||
      getDefaultOutputDir(),
    resumeNamePrefix: sanitizeResumeNamePrefix(
      typeof body.resumeNamePrefix === "string" ? body.resumeNamePrefix : "resume"
    ),
    apiKey:
      typeof body.apiKey === "string" && body.apiKey.trim()
        ? body.apiKey.trim()
        : undefined,
    concurrency: resolveConcurrency(body.concurrency),
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: unknown) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };

      try {
        await runAutomationPipeline(config, emit);
      } catch (err) {
        emit({
          type: "error",
          message: err instanceof Error ? err.message : "Pipeline failed",
        });
      } finally {
        const { closeBrowser } = await import("@/lib/automation/browser");
        await closeBrowser().catch(() => {});
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
