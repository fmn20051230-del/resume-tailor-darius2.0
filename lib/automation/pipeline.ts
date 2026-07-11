import type { AutomationProgressEvent, AutomationRunConfig, PipelineStepId } from "./types";
import { scrapeJobPage } from "./scraper";
import { extractJobData } from "./extractor";
import { buildTailorJobDescription } from "./parse-extraction";
import { resumeTypeToSlotIndex, slotLabel } from "./slot-router";
import { buildFolderName, clearOutputDirectory, saveJobArtifacts } from "./folder-output";
import { convertDocxToPdf } from "./docx-to-pdf";
import { tailorResume } from "@/lib/tailor-resume";
import {
  requiresSecurityClearance,
  securityClearanceSkipReason,
} from "./jd-filters";

export type ProgressEmitter = (event: AutomationProgressEvent) => void;

export type PipelineOptions = {
  shouldStop?: () => boolean;
};

/** Default matches prior app: several resumes at once on one OpenRouter key. */
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 10;
/** Per-step wall-clock limit; timed-out LLM/scrape steps are retried once. */
export const STEP_TIMEOUT_MS = 5 * 60 * 1000;

function clampConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(value as number)));
}

function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

class StepTimeoutError extends Error {
  constructor(public readonly stepLabel: string) {
    super(`Step "${stepLabel}" exceeded ${formatDuration(STEP_TIMEOUT_MS)} and was terminated`);
    this.name = "StepTimeoutError";
  }
}

async function withTimeout<T>(ms: number, label: string, fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new StepTimeoutError(label)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Run fn; on timeout, retry once (regenerate). */
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

/** Serialize Word/LibreOffice PDF conversion — COM is not safe in parallel. */
function createPdfLock() {
  let chain: Promise<unknown> = Promise.resolve();
  return function withPdfLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
}

async function mapPool(
  total: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
  shouldStop?: () => boolean
): Promise<void> {
  let next = 0;

  async function runWorker() {
    while (true) {
      if (shouldStop?.()) return;
      const i = next++;
      if (i >= total) return;
      await worker(i);
    }
  }

  const poolSize = Math.min(Math.max(1, concurrency), total);
  await Promise.all(Array.from({ length: poolSize }, () => runWorker()));
}

export async function runAutomationPipeline(
  config: AutomationRunConfig,
  emit: ProgressEmitter,
  options?: PipelineOptions
): Promise<{ completed: number; failed: number; skipped: number }> {
  const total = config.urls.length;
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const completedFolderPaths: string[] = [];
  const concurrency = clampConcurrency(config.concurrency);
  const withPdfLock = createPdfLock();
  const batchStartedAt = Date.now();

  emit({ type: "batch_start", total, startedAt: batchStartedAt });
  clearOutputDirectory(config.outputDir);

  await mapPool(
    total,
    concurrency,
    async (i) => {
      if (options?.shouldStop?.()) return;

      const url = config.urls[i];
      const index = i + 1;
      const jobStartedAt = Date.now();
      const jobElapsed = () => Date.now() - jobStartedAt;

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
            skipped++;
            emitStep("moving_next", "Moving to next job...");
            return;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Failed to load URL";
          emit({ type: "job_skipped", index, url, error: msg, elapsedMs: jobElapsed() });
          skipped++;
          emitStep("moving_next", "Moving to next job...");
          return;
        }

        if (options?.shouldStop?.()) return;

        let extracted;
        try {
          const extractStarted = Date.now();
          extracted = await withTimeoutRetry(
            "JD extraction",
            () =>
              extractJobData(
                config.extractionPrompt,
                rawText,
                config.apiKey,
                url
              ),
            (msg) => {
              emitStep("jd_extracted", `Extraction timed out — regenerating… ${msg}`);
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
            skipped++;
            emitStep("moving_next", "Moving to next job...");
            return;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Extraction failed";
          emit({ type: "job_failed", index, url, error: msg, elapsedMs: jobElapsed() });
          failed++;
          emitStep("moving_next", "Moving to next job...");
          return;
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

        if (options?.shouldStop?.()) return;

        let docxBuffer: Buffer;
        let resumeMarkdown: string;
        try {
          emitStep("resume_generating", "Resume generating");
          const tailorStarted = Date.now();
          const tailored = await withTimeoutRetry(
            "Resume generation",
            () =>
              tailorResume({
                slotIndex,
                baseResume,
                jobDescription: tailorJd,
                tailoringPrompt: config.tailoringPrompt,
                apiKey: config.apiKey,
                onAttempt: (attempt, maxAttempts, previousError) => {
                  if (attempt === 1) return;
                  emitStep(
                    "resume_generating",
                    previousError
                      ? `Resume regenerating (${attempt}/${maxAttempts}) — ${previousError}`
                      : `Resume regenerating (${attempt}/${maxAttempts})`
                  );
                },
              }),
            (msg) => {
              emitStep("resume_generating", `Resume timed out — regenerating… ${msg}`);
            }
          );
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
          failed++;
          emitStep("moving_next", "Moving to next job...");
          return;
        }

        const pdfStarted = Date.now();
        const pdfBuffer = await withPdfLock(() =>
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

        completedFolderPaths.push(saved.folderPath);
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
        });
        completed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unexpected error";
        emit({ type: "job_failed", index, url, error: msg, elapsedMs: jobElapsed() });
        failed++;
      }

      emitStep("moving_next", "Moving to next job...");
    },
    options?.shouldStop
  );

  emit({
    type: "batch_complete",
    completed,
    failed,
    skipped,
    folderPaths: completedFolderPaths,
    elapsedMs: Date.now() - batchStartedAt,
  });
  return { completed, failed, skipped };
}
