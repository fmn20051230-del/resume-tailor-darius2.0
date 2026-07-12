import type { AutomationProgressEvent, AutomationRunConfig } from "./types";
import { clearOutputDirectory, buildZipFromEntries, type ZipFolderEntry } from "./folder-output";
import { convertDocxToPdf } from "./docx-to-pdf";
import { runSingleAutomationJob, type ProgressEmitter } from "./run-single-job";

export type { ProgressEmitter } from "./run-single-job";
export { STEP_TIMEOUT_MS } from "./run-single-job";

export type PipelineOptions = {
  shouldStop?: () => boolean;
};

/** Default matches prior app: several resumes at once on one OpenRouter key. */
export const DEFAULT_CONCURRENCY = 4;
export const MAX_CONCURRENCY = 10;

function clampConcurrency(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(value as number)));
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

/**
 * In-process batch (used by /api/automation/run). Prefer client-side parallel
 * /api/automation/run-job calls on Vercel so each job gets its own time budget.
 */
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
  const zipEntries: ZipFolderEntry[] = [];
  const concurrency = clampConcurrency(config.concurrency);
  const batchStartedAt = Date.now();

  emit({ type: "batch_start", total, startedAt: batchStartedAt });
  clearOutputDirectory(config.outputDir);

  await mapPool(
    total,
    concurrency,
    async (i) => {
      if (options?.shouldStop?.()) return;

      const outcome = await runSingleAutomationJob(
        {
          url: config.urls[i],
          index: i + 1,
          total,
          extractionPrompt: config.extractionPrompt,
          tailoringPrompt: config.tailoringPrompt,
          baseResumes: config.baseResumes,
          outputDir: config.outputDir,
          resumeNamePrefix: config.resumeNamePrefix,
          apiKey: config.apiKey,
        },
        (event: AutomationProgressEvent) => {
          emit(event);
          if (event.type === "job_complete") {
            completedFolderPaths.push(event.folderPath);
            if (event.artifacts) {
              const files: ZipFolderEntry["files"] = [
                {
                  name: "job_url.txt",
                  data: Buffer.from(event.artifacts.jobUrl + "\n", "utf8"),
                },
                {
                  name: "raw_jd.txt",
                  data: Buffer.from(event.artifacts.rawJd, "utf8"),
                },
                {
                  name: "extracted_jd.txt",
                  data: Buffer.from(event.artifacts.extractedJd, "utf8"),
                },
                {
                  name: "updated_resume.md",
                  data: Buffer.from(event.artifacts.resumeMarkdown, "utf8"),
                },
                {
                  name: event.artifacts.resumeFileName,
                  data: Buffer.from(event.artifacts.docxBase64, "base64"),
                },
              ];
              if (event.artifacts.pdfBase64) {
                files.push({
                  name: event.artifacts.resumeFileName.replace(/\.docx$/i, ".pdf"),
                  data: Buffer.from(event.artifacts.pdfBase64, "base64"),
                });
              }
              zipEntries.push({ folderName: event.folderName, files });
            }
          }
        },
        { shouldStop: options?.shouldStop }
      );

      if (outcome === "completed") completed++;
      else if (outcome === "failed") failed++;
      else skipped++;
    },
    options?.shouldStop
  );

  let zipBase64: string | undefined;
  let zipFileName: string | undefined;
  if (zipEntries.length > 0) {
    try {
      // Backfill any missing PDFs from DOCX before building the archive.
      for (const entry of zipEntries) {
        const docx = entry.files.find((f) => /\.docx$/i.test(f.name));
        const hasPdf = entry.files.some((f) => /\.pdf$/i.test(f.name));
        if (!docx?.data?.length || hasPdf) continue;
        try {
          const pdf = await convertDocxToPdf(docx.data);
          if (pdf?.length) {
            entry.files.push({
              name: docx.name.replace(/\.docx$/i, ".pdf"),
              data: pdf,
            });
          }
        } catch (err) {
          console.warn(
            `[zip] PDF backfill failed for ${entry.folderName}:`,
            err instanceof Error ? err.message : err
          );
        }
      }

      const zipBuf = buildZipFromEntries(zipEntries);
      zipBase64 = zipBuf.toString("base64");
      zipFileName = `${config.resumeNamePrefix}_resumes.zip`;
    } catch (err) {
      console.error(
        "[zip] Could not build batch ZIP in-process:",
        err instanceof Error ? err.message : err
      );
    }
  }

  emit({
    type: "batch_complete",
    completed,
    failed,
    skipped,
    folderPaths: completedFolderPaths,
    elapsedMs: Date.now() - batchStartedAt,
    zipBase64,
    zipFileName,
  });
  return { completed, failed, skipped };
}
