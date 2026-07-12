import {
  completeChat,
  getExtractionModel,
  pickRandomApiKey,
  resolveApiKeys,
} from "@/lib/openrouter";
import { parseExtractionResponse } from "./parse-extraction";
import type { ExtractedJobData } from "./types";

/** Per-attempt wall clock for LLM extraction; timeout → one retry with the same raw JD. */
export const EXTRACTION_ATTEMPT_TIMEOUT_MS = 30_000;

export function buildExtractionMessage(
  extractionPrompt: string,
  rawJobText: string
): string {
  return `${extractionPrompt.trim()}\n\n=== JOB PAGE CONTENT ===\n\n${rawJobText}`;
}

function buildResumeTypeFallbackMessage(rawJobText: string, extractedResponse: string): string {
  return [
    "Determine which resume slot is the closest fit for this job description.",
    "",
    "Return exactly one digit: 1, 2, 3, or 4.",
    "",
    "Slot mapping:",
    "1 = AI Engineer",
    "2 = Data Engineer",
    "3 = Data Scientist",
    "4 = Data Analyst",
    "",
    "Choose the single closest fit even if the job title is not an exact match.",
    "Base your answer primarily on the actual job description responsibilities and requirements.",
    "",
    "=== EXTRACTED RESPONSE ===",
    extractedResponse,
    "",
    "=== JOB PAGE CONTENT ===",
    rawJobText,
  ].join("\n");
}

function parseResumeTypeDigit(raw: string): 1 | 2 | 3 | 4 | null {
  const match = raw.match(/\b([1-4])\b/);
  if (!match) return null;
  return Number(match[1]) as 1 | 2 | 3 | 4;
}

class ExtractionTimeoutError extends Error {
  constructor(timeoutMs: number) {
    const sec = Math.round(timeoutMs / 1000);
    super(`JD extraction exceeded ${sec}s and was terminated`);
    this.name = "ExtractionTimeoutError";
  }
}

async function runWithTimeout<T>(
  ms: number,
  fn: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ExtractionTimeoutError(ms));
    }, ms);
  });

  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function extractJobDataOnce(
  extractionPrompt: string,
  rawJobText: string,
  apiKey: string | undefined,
  jobUrl: string | undefined,
  signal: AbortSignal
): Promise<ExtractedJobData> {
  const keys = resolveApiKeys(apiKey);
  if (keys.length === 0) {
    throw new Error("No OpenRouter API key configured for extraction.");
  }

  const message = buildExtractionMessage(extractionPrompt, rawJobText);
  const { key } = pickRandomApiKey(keys);
  const raw = await completeChat(key, message, getExtractionModel(), {
    maxRetries: 1,
    signal,
  });

  try {
    return parseExtractionResponse(raw, { rawJd: rawJobText, jobUrl });
  } catch (error) {
    const errMessage = error instanceof Error ? error.message : "Extraction parsing failed";
    if (!errMessage.includes("Could not determine Resume Type")) {
      throw error;
    }

    if (signal.aborted) {
      throw new ExtractionTimeoutError(EXTRACTION_ATTEMPT_TIMEOUT_MS);
    }

    const fallbackRaw = await completeChat(
      key,
      buildResumeTypeFallbackMessage(rawJobText, raw),
      getExtractionModel(),
      { maxRetries: 1, signal }
    );
    const fallbackResumeType = parseResumeTypeDigit(fallbackRaw);
    if (!fallbackResumeType) {
      throw error;
    }

    return parseExtractionResponse(`Resume Type: ${fallbackResumeType}\n\n${raw}`, {
      rawJd: rawJobText,
      jobUrl,
    });
  }
}

export type ExtractJobDataOptions = {
  /** Per-attempt timeout (default 30s). */
  attemptTimeoutMs?: number;
  /** Called before the retry that re-sends the same raw JD. */
  onRetry?: (reason: string) => void;
};

export async function extractJobData(
  extractionPrompt: string,
  rawJobText: string,
  apiKey?: string,
  jobUrl?: string,
  options?: ExtractJobDataOptions
): Promise<ExtractedJobData> {
  const attemptTimeoutMs = options?.attemptTimeoutMs ?? EXTRACTION_ATTEMPT_TIMEOUT_MS;

  const runAttempt = () =>
    runWithTimeout(attemptTimeoutMs, async (signal) => {
      try {
        return await extractJobDataOnce(
          extractionPrompt,
          rawJobText,
          apiKey,
          jobUrl,
          signal
        );
      } catch (err) {
        // Abort from the 30s timer often surfaces as a generic OpenAI/abort error.
        if (signal.aborted) throw new ExtractionTimeoutError(attemptTimeoutMs);
        throw err;
      }
    });

  try {
    return await runAttempt();
  } catch (err) {
    const timedOut =
      err instanceof ExtractionTimeoutError ||
      (err instanceof Error && /timed out|aborted|exceeded \d+s/i.test(err.message));
    if (!timedOut) throw err;
    options?.onRetry?.(
      err instanceof Error ? err.message : "extraction timed out"
    );
    // Retry once with the same raw JD after a hung/slow first extraction.
    return runAttempt();
  }
}
