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

/** Max LLM generate attempts when output fails DOCX validation (missing Summary, etc.). */
export const MAX_RESUME_GENERATE_ATTEMPTS = 3;

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

function isRegenerableResumeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /missing a Summary section|missing work experience|missing job titles|Please regenerate/i.test(
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

  for (let attempt = 1; attempt <= MAX_RESUME_GENERATE_ATTEMPTS; attempt++) {
    const previousError = lastError?.message;
    input.onAttempt?.(attempt, MAX_RESUME_GENERATE_ATTEMPTS, previousError);

    const message =
      attempt === 1 || !previousError
        ? baseMessage
        : `${baseMessage}\n\n${buildRetryNudge(previousError)}`;

    const content = await completeChat(key, message, getTailorModel(), {
      reasoning: true,
      maxRetries: 3,
    });

    try {
      const docxBuffer = fillTemplateDocx(content, input.baseResume);
      return { docxBuffer, content, attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (!isRegenerableResumeError(err) || attempt >= MAX_RESUME_GENERATE_ATTEMPTS) {
        throw lastError;
      }
    }
  }

  throw lastError ?? new Error("Resume generation failed");
}
