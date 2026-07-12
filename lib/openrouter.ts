import OpenAI from "openai";

/** Parse keys from env: comma- or newline-separated. */
export function getEnvApiKeys(): string[] {
  const raw = process.env.OPENROUTER_API_KEY;
  if (!raw || !raw.trim()) return [];
  return raw
    .split(/[\n,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

/** User-provided key takes priority over server env keys. */
export function resolveApiKeys(userKey?: string): string[] {
  if (typeof userKey === "string" && userKey.trim()) {
    return [userKey.trim()];
  }
  return getEnvApiKeys();
}

export function pickRandomApiKey(keys: string[]): { key: string; threadIndex: number } {
  const i = Math.floor(Math.random() * keys.length);
  return { key: keys[i], threadIndex: i };
}

export function createOpenRouterClient(apiKey: string): OpenAI {
  return new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey,
  });
}

export const DEFAULT_TAILOR_MODEL = "deepseek/deepseek-v4-flash";
/** OpenRouter slug for Qwen3.5-Flash — used for JD extraction from raw page text. */
export const DEFAULT_EXTRACTION_MODEL = "qwen/qwen3.5-flash-02-23";

export function getTailorModel(): string {
  return process.env.TAILOR_MODEL?.trim() || DEFAULT_TAILOR_MODEL;
}

export function getExtractionModel(): string {
  return process.env.EXTRACTION_MODEL?.trim() || DEFAULT_EXTRACTION_MODEL;
}

/** Transient OpenRouter/network failures that should be retried (up to 3 times). */
export function isRetryableOpenRouterError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /invalid json|Unexpected end of JSON|JSON input|empty content|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket|429|502|503|504|rate limit|overloaded|fetch failed|network|LLM returned empty|Premature close|terminated|other side closed/i.test(
    msg
  );
}

export async function completeChat(
  apiKey: string,
  message: string,
  model: string,
  options?: {
    reasoning?: boolean;
    /** Default 3. Retries transient errors including empty/invalid JSON bodies. */
    maxRetries?: number;
    signal?: AbortSignal;
    /** Optional key pool — each retry picks a random key from this list. */
    keys?: string[];
  }
): Promise<string> {
  const maxRetries = Math.max(1, options?.maxRetries ?? 3);
  const keyPool =
    options?.keys && options.keys.length > 0 ? options.keys : [apiKey];
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (options?.signal?.aborted) {
      throw new Error("Resume generation timed out");
    }

    const { key } = pickRandomApiKey(keyPool);
    const client = createOpenRouterClient(key);
    try {
      if (attempt > 1) {
        console.warn(
          `[openrouter] Retry ${attempt}/${maxRetries}: ${lastError?.message ?? "previous attempt failed"}`
        );
      }

      const response = await client.chat.completions.create(
        {
          model,
          messages: [{ role: "user", content: message }],
          stream: false,
          ...(options?.reasoning ? { reasoning: { enabled: true } } : {}),
        } as Parameters<typeof client.chat.completions.create>[0],
        options?.signal ? { signal: options.signal } : undefined
      );

      const content = (response as { choices?: { message?: { content?: string | null } }[] })
        .choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim()) {
        return content;
      }
      throw new Error("LLM returned empty content");
    } catch (err) {
      if (options?.signal?.aborted) {
        throw new Error("Resume generation timed out");
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (/aborted|timeout|timed out/i.test(msg) && options?.signal?.aborted) {
        throw new Error("Resume generation timed out");
      }
      lastError = err instanceof Error ? err : new Error("LLM request failed");

      const retryable = isRetryableOpenRouterError(err) || /aborted|timeout|timed out/i.test(msg);
      if (!retryable || attempt >= maxRetries) {
        break;
      }
      await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
    }
  }

  throw lastError ?? new Error("LLM request failed");
}
