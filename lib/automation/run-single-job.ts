import type { AutomationProgressEvent, AutomationRunConfig, PipelineStepId } from "./types";
import { scrapeJobPage } from "./scraper";
import { extractJobData } from "./extractor";
import { buildTailorJobDescription } from "./parse-extraction";
import { resumeTypeToSlotIndex, slotLabel } from "./slot-router";
import { buildFolderName, saveJobArtifacts } from "./folder-output";
import { convertDocxToPdf } from "./docx-to-pdf";
import {
  MAX_RESUME_GENERATE_ATTEMPTS,
  RESUME_ATTEMPT_TIMEOUT_MS,
  tailorResume,
} from "@/lib/tailor-resume";
import {
  requiresSecurityClearance,
  securityClearanceSkipReason,
} from "./jd-filters";

export type ProgressEmitter = (event: AutomationProgressEvent) => void;

export const STEP_TIMEOUT_MS = 5 * 60 * 1000;

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

class StepTimeoutError extends Error {
  constructor(public readonly stepLabel: string, timeoutMs = STEP_TIMEOUT_MS) {
    super(`Step "${stepLabel}" exceeded ${formatDuration(timeoutMs)} and was terminated`);
    this.name = "StepTimeoutError";
  }
}

async function withTimeout<T>(ms: number, label: string, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new StepTimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withTimeoutRetry<T>(
  label: string,
  fn: () => Promise<T>,
  onRetry?: (error: string) => void
): Promise<T> {
  try {
    return await withTimeout(STEP_TIMEOUT_MS, label, fn);
  } catch (err) {
    if (!(err instanceof StepTimeoutError)) throw err;
    onRetry?.(err.message);
    return withTimeout(STEP_TIMEOUT_MS, `${label} (retry)`, fn);
  }
}

/** Serialize Word/LibreOffice PDF conversion within one Node process. */
const pdfLock = (() => {
  let chain: Promise<unknown> = Promise.resolve();
  return function withPdfLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
})();

export type SingleJobConfig = Pick<
  AutomationRunConfig,
  | "extractionPrompt"
  | "tailoringPrompt"
  | "baseResumes"
  | "outputDir"
  | "resumeNamePrefix"
  | "apiKey"
> & {
  url: string;
  index: number;
  total: number;
  /** Optional overrides (e.g. shorter on constrained hosts). */
  attemptTimeoutMs?: number;
  maxAttempts?: number;
};

export type SingleJobOutcome = "completed" | "failed" | "skipped";

/**
 * Process one job URL end-to-end, emitting the same progress events as the batch pipeline.
 * Used by both the batch pipeline and per-job API (parallel on Vercel + localhost).
 */
export async function runSingleAutomationJob(
  config: SingleJobConfig,
  emit: ProgressEmitter,
  options?: { shouldStop?: () => boolean }
): Promise<SingleJobOutcome> {
  const { url, index, total } = config;
  const jobStartedAt = Date.now();
  const jobElapsed = () => Date.now() - jobStartedAt;
  const attemptTimeoutMs = config.attemptTimeoutMs ?? RESUME_ATTEMPT_TIMEOUT_MS;
  const maxAttempts = config.maxAttempts ?? MAX_RESUME_GENERATE_ATTEMPTS;

  const emitStep = (
    step: PipelineStepId,
    message: string,
    stepElapsedMs?: number
  ) => {
    emit({
      type: "step",
      index,
      step,
      message:
        stepElapsedMs != null
          ? `${message} (${formatDuration(stepElapsedMs)})`
          : message,
      elapsedMs: jobElapsed(),
      stepElapsedMs,
    });
  };

  emit({ type: "job_start", index, total, url, startedAt: jobStartedAt });

  try {
    let rawText: string;
    try {
      const scrapeStarted = Date.now();
      rawText = await withTimeoutRetry("URL scrape", () => scrapeJobPage(url), (msg) => {
        emitStep("url_loaded", `Scrape timed out — retrying… ${msg}`);
      });
      emit({ type: "job_raw_jd", index, rawJd: rawText });
      emitStep("url_loaded", "URL loaded", Date.now() - scrapeStarted);

      if (requiresSecurityClearance(rawText)) {
        emit({
          type: "job_skipped",
          index,
          url,
          error: securityClearanceSkipReason(),
          elapsedMs: jobElapsed(),
        });
        emitStep("moving_next", "Moving to next job...");
        return "skipped";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load URL";
      emit({ type: "job_skipped", index, url, error: msg, elapsedMs: jobElapsed() });
      emitStep("moving_next", "Moving to next job...");
      return "skipped";
    }

    if (options?.shouldStop?.()) {
      emit({
        type: "job_failed",
        index,
        url,
        error: "Batch stopped",
        elapsedMs: jobElapsed(),
      });
      return "failed";
    }

    let extracted;
    try {
      const extractStarted = Date.now();
      emitStep("jd_extracted", "Extracting JD (30s limit, retry on timeout)…");
      extracted = await extractJobData(
        config.extractionPrompt,
        rawText,
        config.apiKey,
        url,
        {
          attemptTimeoutMs: 30_000,
          onRetry: (reason) => {
            emitStep(
              "jd_extracted",
              `No extracted JD within 30s — retrying with raw JD… (${reason})`
            );
          },
        }
      );
      emit({ type: "job_extracted_jd", index, extractedJd: extracted.raw });
      emitStep("jd_extracted", "JD extracted", Date.now() - extractStarted);

      if (requiresSecurityClearance(`${rawText}\n${extracted.raw}`)) {
        emit({
          type: "job_skipped",
          index,
          url,
          error: securityClearanceSkipReason(),
          elapsedMs: jobElapsed(),
        });
        emitStep("moving_next", "Moving to next job...");
        return "skipped";
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Extraction failed";
      emit({ type: "job_failed", index, url, error: msg, elapsedMs: jobElapsed() });
      emitStep("moving_next", "Moving to next job...");
      return "failed";
    }

    const slotIndex = resumeTypeToSlotIndex(extracted.resumeType);
    const slotName = slotLabel(slotIndex);
    const folderName = buildFolderName(
      index,
      extracted.companyName,
      extracted.positionName
    );

    emit({
      type: "job_meta",
      index,
      companyName: extracted.companyName,
      positionName: extracted.positionName,
      resumeType: extracted.resumeType,
      slotLabel: slotName,
      folderName,
    });

    emitStep("resume_type", `Resume slot selected: ${slotName}`);

    const tailorJd = buildTailorJobDescription(extracted);
    const baseResume = config.baseResumes[slotIndex];
    if (!baseResume?.trim()) {
      throw new Error(`Base resume for ${slotName} slot is empty.`);
    }

    if (options?.shouldStop?.()) {
      emit({
        type: "job_failed",
        index,
        url,
        error: "Batch stopped",
        elapsedMs: jobElapsed(),
      });
      return "failed";
    }

    let docxBuffer: Buffer;
    let resumeMarkdown: string;
    try {
      emitStep(
        "resume_generating",
        `Resume generating (${formatDuration(attemptTimeoutMs)} limit, up to ${maxAttempts} attempts)`
      );
      const tailorStarted = Date.now();
      const tailored = await tailorResume({
        slotIndex,
        baseResume,
        jobDescription: tailorJd,
        tailoringPrompt: config.tailoringPrompt,
        apiKey: config.apiKey,
        attemptTimeoutMs,
        maxAttempts,
        onAttempt: (attempt, maxAtt, previousError) => {
          if (attempt === 1) return;
          const reason = previousError
            ? previousError.length > 120
              ? `${previousError.slice(0, 120)}…`
              : previousError
            : "retrying";
          emitStep(
            "resume_generating",
            `Resume regenerating (${attempt}/${maxAtt}, ${formatDuration(attemptTimeoutMs)} limit) — ${reason}`
          );
        },
      });
      docxBuffer = tailored.docxBuffer;
      resumeMarkdown = tailored.content;
      emit({ type: "job_resume_content", index, resumeMarkdown });
      const tailorMs = Date.now() - tailorStarted;
      emitStep(
        "resume_generated",
        tailored.attempts > 1
          ? `Resume generated (after ${tailored.attempts} attempts)`
          : "Resume generated",
        tailorMs
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Resume generation failed";
      emit({ type: "job_failed", index, url, error: msg, elapsedMs: jobElapsed() });
      emitStep("moving_next", "Moving to next job...");
      return "failed";
    }

    const pdfStarted = Date.now();
    const pdfBuffer = await pdfLock(() =>
      withTimeout(STEP_TIMEOUT_MS, "PDF conversion", () => convertDocxToPdf(docxBuffer))
    ).catch((err) => {
      console.error(
        `[pdf] DOCX→PDF failed for job ${index} (${folderName}):`,
        err instanceof Error ? err.message : err
      );
      return null;
    });

    const saved = await saveJobArtifacts({
      outputDir: config.outputDir,
      folderName,
      resumeNamePrefix: config.resumeNamePrefix,
      jobUrl: url,
      rawJd: rawText,
      extractedJd: extracted.raw,
      resumeMarkdown,
      docxBuffer,
      pdfBuffer,
    });

    const hasPdf = !!saved.pdfPath;
    emitStep(
      "folder_created",
      hasPdf
        ? "Folder created (DOCX + PDF)"
        : "Folder created (DOCX only — install Word or LibreOffice for PDF)",
      Date.now() - pdfStarted
    );

    emit({
      type: "job_complete",
      index,
      folderPath: saved.folderPath,
      folderName,
      companyName: extracted.companyName,
      positionName: extracted.positionName,
      slotLabel: slotName,
      hasPdf,
      elapsedMs: jobElapsed(),
      artifacts: {
        jobUrl: url,
        rawJd: rawText,
        extractedJd: extracted.raw,
        resumeMarkdown,
        docxBase64: docxBuffer.toString("base64"),
        resumeFileName: `${saved.resumeBaseName}.docx`,
        pdfBase64: pdfBuffer?.length ? pdfBuffer.toString("base64") : undefined,
      },
    });
    emitStep("moving_next", "Moving to next job...");
    return "completed";
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    emit({ type: "job_failed", index, url, error: msg, elapsedMs: jobElapsed() });
    emitStep("moving_next", "Moving to next job...");
    return "failed";
  }
}
