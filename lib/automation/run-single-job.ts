import type { AutomationProgressEvent, AutomationRunConfig, PipelineStepId, ResumeSlotIndex } from "./types";
import { scrapeJobPage } from "./scraper";
import { extractJobData, EXTRACTION_ATTEMPT_TIMEOUT_MS } from "./extractor";
import { buildTailorJobDescription } from "./parse-extraction";
import { resumeTypeToSlotIndex, slotLabel } from "./slot-router";
import { buildFolderName, saveJobArtifacts } from "./folder-output";
import { convertDocxToPdf } from "./docx-to-pdf";
import {
  MAX_RESUME_GENERATE_ATTEMPTS,
  RESUME_ATTEMPT_TIMEOUT_MS,
  isRegenerableTailorError,
  tailorResume,
} from "@/lib/tailor-resume";
import {
  requiresSecurityClearance,
  securityClearanceSkipReason,
} from "./jd-filters";

export type ProgressEmitter = (event: AutomationProgressEvent) => void;

export const STEP_TIMEOUT_MS = 5 * 60 * 1000;

/** Per generate attempt on Vercel Hobby (fits under maxDuration 300). */
export const DEPLOYED_RESUME_ATTEMPT_TIMEOUT_MS = 4.5 * 60 * 1000;

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
  attemptTimeoutMs?: number;
  maxAttempts?: number;
  /** 1-based generate attempt for this invocation (deployed retries use 2, 3). */
  generateAttempt?: number;
};

export type ResumeGenerateContinuationConfig = {
  url: string;
  index: number;
  total: number;
  generateAttempt: number;
  maxAttempts: number;
  attemptTimeoutMs: number;
  tailoringPrompt: string;
  baseResume: string;
  slotIndex: ResumeSlotIndex;
  tailorJd: string;
  rawJd: string;
  extractedJd: string;
  companyName: string;
  positionName: string;
  resumeType: 1 | 2 | 3 | 4;
  folderName: string;
  outputDir: string;
  resumeNamePrefix: string;
  apiKey?: string;
  previousError?: string;
};

export type SingleJobOutcome = "completed" | "failed" | "skipped" | "needs_regenerate";

async function saveAndComplete(args: {
  emit: ProgressEmitter;
  emitStep: (step: PipelineStepId, message: string, stepElapsedMs?: number) => void;
  index: number;
  url: string;
  folderName: string;
  companyName: string;
  positionName: string;
  slotName: string;
  outputDir: string;
  resumeNamePrefix: string;
  rawJd: string;
  extractedJd: string;
  resumeMarkdown: string;
  docxBuffer: Buffer;
  jobElapsed: () => number;
}): Promise<"completed"> {
  const pdfStarted = Date.now();
  const pdfBuffer = await pdfLock(() =>
    withTimeout(STEP_TIMEOUT_MS, "PDF conversion", () => convertDocxToPdf(args.docxBuffer))
  ).catch((err) => {
    console.error(
      `[pdf] DOCX→PDF failed for job ${args.index} (${args.folderName}):`,
      err instanceof Error ? err.message : err
    );
    return null;
  });

  const saved = await saveJobArtifacts({
    outputDir: args.outputDir,
    folderName: args.folderName,
    resumeNamePrefix: args.resumeNamePrefix,
    jobUrl: args.url,
    rawJd: args.rawJd,
    extractedJd: args.extractedJd,
    resumeMarkdown: args.resumeMarkdown,
    docxBuffer: args.docxBuffer,
    pdfBuffer,
  });

  const hasPdf = !!saved.pdfPath;
  args.emitStep(
    "folder_created",
    hasPdf
      ? "Folder created (DOCX + PDF)"
      : "Folder created (DOCX only — install Word or LibreOffice for PDF)",
    Date.now() - pdfStarted
  );

  args.emit({
    type: "job_complete",
    index: args.index,
    folderPath: saved.folderPath,
    folderName: args.folderName,
    companyName: args.companyName,
    positionName: args.positionName,
    slotLabel: args.slotName,
    hasPdf,
    elapsedMs: args.jobElapsed(),
    artifacts: {
      jobUrl: args.url,
      rawJd: args.rawJd,
      extractedJd: args.extractedJd,
      resumeMarkdown: args.resumeMarkdown,
      docxBase64: args.docxBuffer.toString("base64"),
      resumeFileName: `${saved.resumeBaseName}.docx`,
      pdfBase64: pdfBuffer?.length ? pdfBuffer.toString("base64") : undefined,
    },
  });
  args.emitStep("moving_next", "Moving to next job...");
  return "completed";
}

/**
 * One generate attempt (used for deployed retries 2/3 and 3/3 — each gets its own
 * serverless maxDuration / 4.5 min window).
 */
export async function runResumeGenerateContinuation(
  config: ResumeGenerateContinuationConfig,
  emit: ProgressEmitter
): Promise<SingleJobOutcome> {
  const {
    url,
    index,
    total,
    generateAttempt,
    maxAttempts,
    attemptTimeoutMs,
    slotIndex,
    folderName,
  } = config;
  const jobStartedAt = Date.now();
  const jobElapsed = () => Date.now() - jobStartedAt;
  const slotName = slotLabel(slotIndex);

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

  emit({
    type: "job_start",
    index,
    total,
    url,
    startedAt: jobStartedAt,
  });
  emit({
    type: "job_meta",
    index,
    companyName: config.companyName,
    positionName: config.positionName,
    resumeType: config.resumeType,
    slotLabel: slotName,
    folderName,
  });
  emitStep(
    "resume_generating",
    `Resume generating attempt ${generateAttempt}/${maxAttempts} (${formatDuration(attemptTimeoutMs)} limit)`
  );

  emit({
    type: "job_generate_ready",
    index,
    url,
    nextAttempt: generateAttempt,
    maxAttempts,
    elapsedMs: jobElapsed(),
    tailoringPrompt: config.tailoringPrompt,
    baseResume: config.baseResume,
    slotIndex,
    tailorJd: config.tailorJd,
    rawJd: config.rawJd,
    extractedJd: config.extractedJd,
    companyName: config.companyName,
    positionName: config.positionName,
    resumeType: config.resumeType,
    folderName,
    outputDir: config.outputDir,
    resumeNamePrefix: config.resumeNamePrefix,
    apiKey: config.apiKey,
  });

  try {
    const tailorStarted = Date.now();
    const tailored = await tailorResume({
      slotIndex,
      baseResume: config.baseResume,
      jobDescription: config.tailorJd,
      tailoringPrompt: config.tailoringPrompt,
      apiKey: config.apiKey,
      attemptTimeoutMs,
      maxAttempts, // regenerate missing Summary immediately within this call
      totalBudgetMs: attemptTimeoutMs,
      onAttempt: (attempt, maxAtt, previousError) => {
        if (attempt === 1) return;
        const reason = previousError
          ? previousError.length > 140
            ? `${previousError.slice(0, 140)}…`
            : previousError
          : "retrying";
        emitStep(
          "resume_generating",
          `Regenerating immediately (${attempt}/${maxAtt}) — ${reason}`
        );
      },
    });

    emit({ type: "job_resume_content", index, resumeMarkdown: tailored.content });
    emitStep(
      "resume_generated",
      tailored.attempts > 1
        ? `Resume generated (after ${tailored.attempts} attempts)`
        : `Resume generated (attempt ${generateAttempt}/${maxAttempts})`,
      Date.now() - tailorStarted
    );

    return saveAndComplete({
      emit,
      emitStep,
      index,
      url,
      folderName,
      companyName: config.companyName,
      positionName: config.positionName,
      slotName,
      outputDir: config.outputDir,
      resumeNamePrefix: config.resumeNamePrefix,
      rawJd: config.rawJd,
      extractedJd: config.extractedJd,
      resumeMarkdown: tailored.content,
      docxBuffer: tailored.docxBuffer,
      jobElapsed,
    });
  } catch (err) {
    const raw = err instanceof Error ? err.message : "Resume generation failed";
    const msg = raw.replace(
      /attempt \d+\/\d+/i,
      `attempt ${generateAttempt}/${maxAttempts}`
    );
    const timedOut = /exceeded .+ and was terminated|timed out|timeout/i.test(msg);
    if (timedOut && isRegenerableTailorError(err) && generateAttempt < maxAttempts) {
      emit({
        type: "job_need_regenerate",
        index,
        url,
        error: msg,
        nextAttempt: generateAttempt + 1,
        maxAttempts,
        elapsedMs: jobElapsed(),
        tailoringPrompt: config.tailoringPrompt,
        baseResume: config.baseResume,
        slotIndex,
        tailorJd: config.tailorJd,
        rawJd: config.rawJd,
        extractedJd: config.extractedJd,
        companyName: config.companyName,
        positionName: config.positionName,
        resumeType: config.resumeType,
        folderName,
        outputDir: config.outputDir,
        resumeNamePrefix: config.resumeNamePrefix,
        apiKey: config.apiKey,
      });
      emitStep(
        "resume_generating",
        `Attempt ${generateAttempt}/${maxAttempts} timed out — starting next attempt…`
      );
      return "needs_regenerate";
    }

    emit({ type: "job_failed", index, url, error: msg, elapsedMs: jobElapsed() });
    emitStep("moving_next", "Moving to next job...");
    return "failed";
  }
}

/**
 * Process one job URL end-to-end, emitting the same progress events as the batch pipeline.
 * On Vercel, generate uses 1 attempt per invocation (4.5 min); client retries via
 * job_need_regenerate up to 3 times. Localhost keeps in-process 3 × 7 min.
 */
export async function runSingleAutomationJob(
  config: SingleJobConfig,
  emit: ProgressEmitter,
  options?: { shouldStop?: () => boolean }
): Promise<SingleJobOutcome> {
  const { url, index, total } = config;
  const jobStartedAt = Date.now();
  const jobElapsed = () => Date.now() - jobStartedAt;
  const onVercel = Boolean(process.env.VERCEL);
  const attemptTimeoutMs =
    config.attemptTimeoutMs ??
    (onVercel ? DEPLOYED_RESUME_ATTEMPT_TIMEOUT_MS : RESUME_ATTEMPT_TIMEOUT_MS);
  const maxAttempts = config.maxAttempts ?? MAX_RESUME_GENERATE_ATTEMPTS;
  const generateAttempt = config.generateAttempt ?? 1;

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
      emitStep("jd_extracted", "Extracting JD (2m limit, retry on timeout)…");
      extracted = await extractJobData(
        config.extractionPrompt,
        rawText,
        config.apiKey,
        url,
        {
          attemptTimeoutMs: EXTRACTION_ATTEMPT_TIMEOUT_MS,
          onRetry: (reason) => {
            emitStep(
              "jd_extracted",
              `No extracted JD within 2m — retrying with raw JD… (${reason})`
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

    // Always up to 3 in-process attempts so missing-Summary regenerates immediately.
    // On Vercel, share one 4.5 min budget across those attempts (validation fails are fast).
    // Full timeouts that burn the budget still emit job_need_regenerate for a fresh call.
    const inProcessAttempts = maxAttempts;

    // Let the client resume generate if this SSE dies mid-flight (common on Vercel).
    emit({
      type: "job_generate_ready",
      index,
      url,
      nextAttempt: generateAttempt,
      maxAttempts,
      elapsedMs: jobElapsed(),
      tailoringPrompt: config.tailoringPrompt,
      baseResume,
      slotIndex,
      tailorJd,
      rawJd: rawText,
      extractedJd: extracted.raw,
      companyName: extracted.companyName,
      positionName: extracted.positionName,
      resumeType: extracted.resumeType,
      folderName,
      outputDir: config.outputDir,
      resumeNamePrefix: config.resumeNamePrefix,
      apiKey: config.apiKey,
    });

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
        maxAttempts: inProcessAttempts,
        totalBudgetMs: onVercel ? attemptTimeoutMs : undefined,
        onAttempt: (attempt, maxAtt, previousError) => {
          if (attempt === 1) return;
          const reason = previousError
            ? previousError.length > 140
              ? `${previousError.slice(0, 140)}…`
              : previousError
            : "retrying";
          emitStep(
            "resume_generating",
            `Regenerating immediately (${attempt}/${maxAtt}) — ${reason}`
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
      const raw = err instanceof Error ? err.message : "Resume generation failed";
      const msg = raw.replace(
        /attempt \d+\/\d+/i,
        `attempt ${generateAttempt}/${maxAttempts}`
      );
      // Only hop to a new serverless call when this invocation timed out and budget is gone.
      const timedOut = /exceeded .+ and was terminated|timed out|timeout/i.test(msg);
      if (
        onVercel &&
        timedOut &&
        isRegenerableTailorError(err) &&
        generateAttempt < maxAttempts
      ) {
        emit({
          type: "job_need_regenerate",
          index,
          url,
          error: msg,
          nextAttempt: generateAttempt + 1,
          maxAttempts,
          elapsedMs: jobElapsed(),
          tailoringPrompt: config.tailoringPrompt,
          baseResume,
          slotIndex,
          tailorJd,
          rawJd: rawText,
          extractedJd: extracted.raw,
          companyName: extracted.companyName,
          positionName: extracted.positionName,
          resumeType: extracted.resumeType,
          folderName,
          outputDir: config.outputDir,
          resumeNamePrefix: config.resumeNamePrefix,
          apiKey: config.apiKey,
        });
        emitStep(
          "resume_generating",
          `Attempt ${generateAttempt}/${maxAttempts} timed out — starting next attempt…`
        );
        return "needs_regenerate";
      }

      emit({ type: "job_failed", index, url, error: msg, elapsedMs: jobElapsed() });
      emitStep("moving_next", "Moving to next job...");
      return "failed";
    }

    return saveAndComplete({
      emit,
      emitStep,
      index,
      url,
      folderName,
      companyName: extracted.companyName,
      positionName: extracted.positionName,
      slotName,
      outputDir: config.outputDir,
      resumeNamePrefix: config.resumeNamePrefix,
      rawJd: rawText,
      extractedJd: extracted.raw,
      resumeMarkdown,
      docxBuffer,
      jobElapsed,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    emit({ type: "job_failed", index, url, error: msg, elapsedMs: jobElapsed() });
    emitStep("moving_next", "Moving to next job...");
    return "failed";
  }
}
