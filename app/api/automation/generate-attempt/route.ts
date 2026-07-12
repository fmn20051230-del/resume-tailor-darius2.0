import { NextRequest } from "next/server";
import {
  DEPLOYED_RESUME_ATTEMPT_TIMEOUT_MS,
  runResumeGenerateContinuation,
} from "@/lib/automation/run-single-job";
import { MAX_RESUME_GENERATE_ATTEMPTS } from "@/lib/tailor-resume";

export const dynamic = "force-dynamic";
/** One generate attempt per call — 4.5 min fits Hobby maxDuration 300. */
export const maxDuration = 300;

type Body = {
  url?: string;
  index?: number;
  total?: number;
  nextAttempt?: number;
  maxAttempts?: number;
  tailoringPrompt?: string;
  baseResume?: string;
  slotIndex?: number;
  tailorJd?: string;
  rawJd?: string;
  extractedJd?: string;
  companyName?: string;
  positionName?: string;
  resumeType?: number;
  folderName?: string;
  outputDir?: string;
  resumeNamePrefix?: string;
  apiKey?: string;
  convertApiSecret?: string;
  previousError?: string;
};

export async function POST(request: NextRequest) {
  let body: Body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const url = typeof body.url === "string" ? body.url.trim() : "";
  const tailorJd = typeof body.tailorJd === "string" ? body.tailorJd : "";
  const baseResume = typeof body.baseResume === "string" ? body.baseResume : "";
  if (!url || !tailorJd.trim() || !baseResume.trim()) {
    return new Response(
      JSON.stringify({ error: "Missing url, tailorJd, or baseResume for regenerate" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const generateAttempt = Math.max(
    1,
    Math.min(
      MAX_RESUME_GENERATE_ATTEMPTS,
      typeof body.nextAttempt === "number" ? Math.floor(body.nextAttempt) : 2
    )
  );
  const maxAttempts =
    typeof body.maxAttempts === "number" && Number.isFinite(body.maxAttempts)
      ? Math.max(1, Math.min(MAX_RESUME_GENERATE_ATTEMPTS, Math.floor(body.maxAttempts)))
      : MAX_RESUME_GENERATE_ATTEMPTS;

  const slotIndex = (
    typeof body.slotIndex === "number" && body.slotIndex >= 0 && body.slotIndex <= 3
      ? body.slotIndex
      : 0
  ) as 0 | 1 | 2 | 3;
  const resumeType = ([1, 2, 3, 4].includes(Number(body.resumeType))
    ? Number(body.resumeType)
    : slotIndex + 1) as 1 | 2 | 3 | 4;

  const onVercel = Boolean(process.env.VERCEL);
  const attemptTimeoutMs = onVercel
    ? DEPLOYED_RESUME_ATTEMPT_TIMEOUT_MS
    : 7 * 60 * 1000;

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
        await runResumeGenerateContinuation(
          {
            url,
            index:
              typeof body.index === "number" && Number.isFinite(body.index)
                ? Math.max(1, Math.floor(body.index))
                : 1,
            total:
              typeof body.total === "number" && Number.isFinite(body.total)
                ? Math.max(1, Math.floor(body.total))
                : 1,
            generateAttempt,
            maxAttempts,
            attemptTimeoutMs,
            tailoringPrompt:
              typeof body.tailoringPrompt === "string" ? body.tailoringPrompt : "",
            baseResume,
            slotIndex,
            tailorJd,
            rawJd: typeof body.rawJd === "string" ? body.rawJd : "",
            extractedJd: typeof body.extractedJd === "string" ? body.extractedJd : "",
            companyName: typeof body.companyName === "string" ? body.companyName : "Company",
            positionName:
              typeof body.positionName === "string" ? body.positionName : "Position",
            resumeType,
            folderName:
              typeof body.folderName === "string" && body.folderName.trim()
                ? body.folderName.trim()
                : `job_${Date.now()}`,
            outputDir:
              typeof body.outputDir === "string" && body.outputDir.trim()
                ? body.outputDir.trim()
                : "",
            resumeNamePrefix:
              typeof body.resumeNamePrefix === "string" && body.resumeNamePrefix.trim()
                ? body.resumeNamePrefix.trim()
                : "resume",
            apiKey:
              typeof body.apiKey === "string" && body.apiKey.trim()
                ? body.apiKey.trim()
                : undefined,
            convertApiSecret:
              typeof body.convertApiSecret === "string" && body.convertApiSecret.trim()
                ? body.convertApiSecret.trim()
                : undefined,
            previousError:
              typeof body.previousError === "string" ? body.previousError : undefined,
          },
          emit
        );
      } catch (err) {
        emit({
          type: "error",
          message: err instanceof Error ? err.message : "Generate attempt failed",
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
