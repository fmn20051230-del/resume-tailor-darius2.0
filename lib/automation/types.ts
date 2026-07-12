export type ResumeSlotIndex = 0 | 1 | 2 | 3;

export const SLOT_LABELS = [
  "AI Engineer",
  "Data Engineer",
  "Data Scientist",
  "Data Analyst",
] as const;

export type PipelineStepId =
  | "url_loaded"
  | "jd_extracted"
  | "resume_type"
  | "resume_generating"
  | "resume_generated"
  | "folder_created"
  | "moving_next";

export type JobStatus = "pending" | "processing" | "completed" | "failed" | "skipped";

export type ExtractedJobData = {
  companyName: string;
  positionName: string;
  resumeType: 1 | 2 | 3 | 4;
  title: string;
  summary: string;
  experience: string;
  skills: string;
  raw: string;
};

export type AutomationJob = {
  index: number;
  url: string;
  status: JobStatus;
  error?: string;
  folderPath?: string;
  extracted?: ExtractedJobData;
  slotIndex?: ResumeSlotIndex;
  steps: Partial<Record<PipelineStepId, string>>;
};

export type AutomationProgressEvent =
  | { type: "batch_start"; total: number; startedAt: number }
  | { type: "job_start"; index: number; total: number; url: string; startedAt: number }
  | {
      type: "job_meta";
      index: number;
      companyName: string;
      positionName: string;
      resumeType: 1 | 2 | 3 | 4;
      slotLabel: string;
      folderName: string;
    }
  | {
      type: "step";
      index: number;
      step: PipelineStepId;
      message: string;
      elapsedMs?: number;
      stepElapsedMs?: number;
    }
  | { type: "job_raw_jd"; index: number; rawJd: string }
  | { type: "job_extracted_jd"; index: number; extractedJd: string }
  | { type: "job_resume_content"; index: number; resumeMarkdown: string }
  | {
      type: "job_complete";
      index: number;
      folderPath: string;
      folderName: string;
      companyName: string;
      positionName: string;
      slotLabel: string;
      hasPdf: boolean;
      elapsedMs: number;
      /** Browser ZIP fallback when the in-process archive is missing (Vercel). */
      artifacts?: {
        jobUrl: string;
        rawJd: string;
        extractedJd: string;
        resumeMarkdown: string;
        docxBase64: string;
        resumeFileName: string;
        pdfBase64?: string;
      };
    }
  | { type: "job_failed"; index: number; url: string; error: string; elapsedMs?: number }
  | { type: "job_skipped"; index: number; url: string; error: string; elapsedMs?: number }
  | {
      /** Deployed: each generate attempt is its own serverless call (4.5 min × up to 3). */
      type: "job_need_regenerate";
      index: number;
      url: string;
      error: string;
      /** Next attempt number to run (2 or 3). */
      nextAttempt: number;
      maxAttempts: number;
      elapsedMs?: number;
      tailoringPrompt: string;
      baseResume: string;
      slotIndex: number;
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
    }
  | { type: "heartbeat"; at: number }
  | {
      type: "batch_complete";
      completed: number;
      failed: number;
      skipped: number;
      folderPaths: string[];
      elapsedMs: number;
      /** ZIP built in the same serverless invocation — use this on Vercel. */
      zipBase64?: string;
      zipFileName?: string;
    };

export type AutomationRunConfig = {
  urls: string[];
  extractionPrompt: string;
  tailoringPrompt: string;
  baseResumes: [string, string, string, string];
  outputDir: string;
  /** Prefix for resume files, e.g. "darius" → darius_resume.docx */
  resumeNamePrefix: string;
  apiKey?: string;
  /** How many jobs to process at once (same OpenRouter key). Default 4. */
  concurrency?: number;
};
