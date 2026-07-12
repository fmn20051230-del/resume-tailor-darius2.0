import { NextRequest } from "next/server";
import {
  getDefaultOutputDir,
  loadBaseResumes,
  loadExtractionPrompt,
  loadTailoringPrompt,
} from "@/lib/automation/config-loader";
import { sanitizeResumeNamePrefix } from "@/lib/automation/folder-output";
import {
  DEPLOYED_RESUME_ATTEMPT_TIMEOUT_MS,
  runSingleAutomationJob,
} from "@/lib/automation/run-single-job";
import { MAX_RESUME_GENERATE_ATTEMPTS, RESUME_ATTEMPT_TIMEOUT_MS } from "@/lib/tailor-resume";

export const dynamic = "force-dynamic";
/** Vercel Hobby allows 1–300s only. Each call = one 4.5 min generate attempt. */
export const maxDuration = 300;

type RunJobBody = {
  url?: string;
  index?: number;
  total?: number;
  extractionPrompt?: string;
  tailoringPrompt?: string;
  baseResumes?: string[];
  outputDir?: string;
  resumeNamePrefix?: string;
  apiKey?: string;
};

export async function POST(request: NextRequest) {
  let body: RunJobBody;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (!url) {
    return new Response(JSON.stringify({ error: "Missing job url" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const index =
    typeof body.index === "number" && Number.isFinite(body.index)
      ? Math.max(1, Math.floor(body.index))
      : 1;
  const total =
    typeof body.total === "number" && Number.isFinite(body.total)
      ? Math.max(index, Math.floor(body.total))
      : index;

  const extractionPrompt =
    (typeof body.extractionPrompt === "string" && body.extractionPrompt.trim()) ||
    loadExtractionPrompt();
  if (!extractionPrompt.trim()) {
    return new Response(
      JSON.stringify({ error: "Extraction prompt is required." }),
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

  const onVercel = Boolean(process.env.VERCEL);
  // Deployed: 4.5 min × 1 attempt per invocation; client retries up to 3 via generate-attempt.
  // Local: 7 min × 3 in-process.
  const attemptTimeoutMs = onVercel
    ? DEPLOYED_RESUME_ATTEMPT_TIMEOUT_MS
    : RESUME_ATTEMPT_TIMEOUT_MS;
  const maxAttempts = MAX_RESUME_GENERATE_ATTEMPTS;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const emit = (event: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
          emit({ type: "heartbeat", at: Date.now() });
        } catch {
          closed = true;
        }
      }, 10_000);

      try {
        await runSingleAutomationJob(
          {
            url,
            index,
            total,
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
            attemptTimeoutMs,
            maxAttempts,
            generateAttempt: 1,
          },
          emit
        );
      } catch (err) {
        emit({
          type: "error",
          message: err instanceof Error ? err.message : "Job failed",
        });
      } finally {
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // already closed
        }
        closed = true;
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
