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

export class ResumeAttemptTimeoutError extends Error {
  constructor(attempt: number, maxAttempts: number) {
    super(
      `Resume generation attempt ${attempt}/${maxAttempts} exceeded 7 minutes and was terminated`
    );
    this.name = "ResumeAttemptTimeoutError";
  }
}

function isRegenerableResumeError(err: unknown): boolean {
  if (err instanceof ResumeAttemptTimeoutError) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /missing a Summary section|missing work experience|missing job titles|Please regenerate|timed out|timeout/i.test(
    msg
  );
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
      reject(new ResumeAttemptTimeoutError(attempt, maxAttempts));
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

  for (let attempt = 1; attempt <= MAX_RESUME_GENERATE_ATTEMPTS; attempt++) {
    const budgetLeft = RESUME_TOTAL_BUDGET_MS - (Date.now() - budgetStarted);
    if (budgetLeft <= 0) {
      throw lastError ?? new Error("Resume generation exceeded 21-minute total budget");
    }

    const attemptTimeoutMs = Math.min(RESUME_ATTEMPT_TIMEOUT_MS, budgetLeft);
    const previousError = lastError?.message;
    input.onAttempt?.(attempt, MAX_RESUME_GENERATE_ATTEMPTS, previousError);

    const message =
      attempt === 1 || !previousError
        ? baseMessage
        : `${baseMessage}\n\n${buildRetryNudge(previousError)}`;

    try {
      const result = await runWithTimeout(
        attemptTimeoutMs,
        attempt,
        MAX_RESUME_GENERATE_ATTEMPTS,
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
      if (!isRegenerableResumeError(err) || attempt >= MAX_RESUME_GENERATE_ATTEMPTS) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("Resume generation failed");
}
