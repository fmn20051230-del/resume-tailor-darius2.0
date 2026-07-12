/**
 * Server-side resume tailoring — mirrors the existing UI + /api/chat + /api/docx flow
 * without modifying the tailoring prompt or generation logic.
 */
import { fillTemplateDocx } from "@/lib/fill-template-docx";
import {
  completeChat,
  getTailorModel,
  pickRandomApiKey,
  resolveApiKeys,
} from "@/lib/openrouter";

/** Wall-clock limit for a single LLM generate + DOCX fill attempt. */
export const RESUME_ATTEMPT_TIMEOUT_MS = 7 * 60 * 1000;

/** Max generate attempts (timeout or invalid output → regenerate). 3 × 7m = 21m max. */
export const MAX_RESUME_GENERATE_ATTEMPTS = 3;

/** Hard ceiling across all attempts — never approach 28 minutes. */
export const RESUME_TOTAL_BUDGET_MS =
  RESUME_ATTEMPT_TIMEOUT_MS * MAX_RESUME_GENERATE_ATTEMPTS;

export type TailorResumeInput = {
  slotIndex: number;
  baseResume: string;
  /** JD sent to tailor — automation supplies only Summary + Experience + Skills */
  jobDescription: string;
  tailoringPrompt: string;
  apiKey?: string;
  /** Override per-attempt timeout (default 7 minutes). */
  attemptTimeoutMs?: number;
  /** Override max attempts (default 3). Includes regenerations for missing Summary, etc. */
  maxAttempts?: number;
  /**
   * Hard wall-clock budget across all attempts. When set (e.g. on Vercel Hobby),
   * remaining time is shared so missing-Summary regenerations can still run.
   */
  totalBudgetMs?: number;
  /** Called before each generate attempt (1-based). */
  onAttempt?: (attempt: number, maxAttempts: number, previousError?: string) => void;
};

export function buildTailorMessage(
  tailoringPrompt: string,
  baseResume: string,
  jobDescription: string
): string {
  const parts: string[] = [];
  if (tailoringPrompt.trim()) parts.push(tailoringPrompt.trim());
  parts.push("=== RESUME ===\n\n" + baseResume.trim());
  parts.push("=== JD (Job Description) ===\n\n" + jobDescription.trim());
  return parts.join("\n\n");
}

export type TailorResumeResult = {
  docxBuffer: Buffer;
  /** LLM markdown content used to build the DOCX */
  content: string;
  /** How many LLM generate attempts were used (1 = first try succeeded). */
  attempts: number;
};

function formatAttemptLimit(ms: number): string {
  const totalSec = Math.max(1, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, "0")}s` : `${s}s`;
}

export class ResumeAttemptTimeoutError extends Error {
  constructor(attempt: number, maxAttempts: number, timeoutMs: number) {
    super(
      `Resume generation attempt ${attempt}/${maxAttempts} exceeded ${formatAttemptLimit(timeoutMs)} and was terminated`
    );
    this.name = "ResumeAttemptTimeoutError";
  }
}

function isRegenerableResumeError(err: unknown): boolean {
  if (err instanceof ResumeAttemptTimeoutError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /missing a Summary section|missing work experience|missing job titles|Please regenerate|timed out|timeout|exceeded .+ and was terminated/i.test(
    msg
  );
}

/** True when the model/output should be retried (missing Summary, timeout, etc.). */
export function isRegenerableTailorError(err: unknown): boolean {
  return isRegenerableResumeError(err);
}

function buildRetryNudge(previousError: string): string {
  return [
    "=== CORRECTION (previous output was invalid) ===",
    previousError,
    "",
    "Regenerate the FULL tailored resume in markdown.",
    "You MUST include:",
    "1) A clear Summary section headed exactly like: ## Summary",
    "2) Work Experience with each job title and company, plus bullet points",
    "3) Skills section",
    "Do not omit the Summary section. Do not return only keywords or skill groups.",
  ].join("\n");
}

async function runWithTimeout<T>(
  ms: number,
  attempt: number,
  maxAttempts: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ResumeAttemptTimeoutError(attempt, maxAttempts, ms));
    }, ms);
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function tailorResume(input: TailorResumeInput): Promise<TailorResumeResult> {
  const keys = resolveApiKeys(input.apiKey);
  if (keys.length === 0) {
    throw new Error(
      "No OpenRouter API key. Set OPENROUTER_API_KEY on the server or pass apiKey."
    );
  }

  const baseMessage = buildTailorMessage(
    input.tailoringPrompt,
    input.baseResume,
    input.jobDescription
  );
  if (!baseMessage.trim()) {
    throw new Error("Nothing to send. Check prompt, resume, and JD.");
  }

  const { key } = pickRandomApiKey(keys);
  let lastError: Error | null = null;
  const budgetStarted = Date.now();
  const maxAttempts = Math.max(
    1,
    Math.min(MAX_RESUME_GENERATE_ATTEMPTS, input.maxAttempts ?? MAX_RESUME_GENERATE_ATTEMPTS)
  );
  const perAttemptMs = Math.max(
    30_000,
    input.attemptTimeoutMs ?? RESUME_ATTEMPT_TIMEOUT_MS
  );
  const totalBudgetMs = Math.max(
    30_000,
    input.totalBudgetMs ?? perAttemptMs * maxAttempts
  );

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const budgetLeft = totalBudgetMs - (Date.now() - budgetStarted);
    if (budgetLeft <= 5_000) {
      throw lastError ?? new Error("Resume generation exceeded total time budget");
    }

    const attemptTimeoutMs = Math.min(perAttemptMs, budgetLeft);
    const previousError = lastError?.message;
    input.onAttempt?.(attempt, maxAttempts, previousError);

    const message =
      attempt === 1 || !previousError
        ? baseMessage
        : `${baseMessage}\n\n${buildRetryNudge(previousError)}`;

    try {
      const result = await runWithTimeout(
        attemptTimeoutMs,
        attempt,
        maxAttempts,
        async (signal) => {
          const content = await completeChat(key, message, getTailorModel(), {
            reasoning: true,
            maxRetries: 2,
            signal,
          });
          const docxBuffer = fillTemplateDocx(content, input.baseResume);
          return { docxBuffer, content, attempts: attempt };
        }
      );
      return result;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      // Missing Summary / experience / titles → regenerate automatically (up to maxAttempts).
      if (!isRegenerableResumeError(err) || attempt >= maxAttempts) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("Resume generation failed");
}
