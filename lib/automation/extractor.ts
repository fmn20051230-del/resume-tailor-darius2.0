import {
  completeChat,
  getExtractionModel,
  pickRandomApiKey,
  resolveApiKeys,
} from "@/lib/openrouter";
import { parseExtractionResponse } from "./parse-extraction";
import type { ExtractedJobData } from "./types";

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

export async function extractJobData(
  extractionPrompt: string,
  rawJobText: string,
  apiKey?: string,
  jobUrl?: string
): Promise<ExtractedJobData> {
  const keys = resolveApiKeys(apiKey);
  if (keys.length === 0) {
    throw new Error("No OpenRouter API key configured for extraction.");
  }

  const message = buildExtractionMessage(extractionPrompt, rawJobText);
  const { key } = pickRandomApiKey(keys);
  const raw = await completeChat(key, message, getExtractionModel(), {
    maxRetries: 3,
  });

  try {
    return parseExtractionResponse(raw, { rawJd: rawJobText, jobUrl });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Extraction parsing failed";
    if (!message.includes("Could not determine Resume Type")) {
      throw error;
    }

    const fallbackRaw = await completeChat(
      key,
      buildResumeTypeFallbackMessage(rawJobText, raw),
      getExtractionModel(),
      { maxRetries: 2 }
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
