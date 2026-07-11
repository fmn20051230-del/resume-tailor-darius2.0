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

export function getTailorModel(): string {
  return process.env.TAILOR_MODEL?.trim() || DEFAULT_TAILOR_MODEL;
}

export function getExtractionModel(): string {
  return process.env.EXTRACTION_MODEL?.trim() || getTailorModel();
}

export async function completeChat(
  apiKey: string,
  message: string,
  model: string,
  options?: { reasoning?: boolean; maxRetries?: number }
): Promise<string> {
  const maxRetries = options?.maxRetries ?? 3;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const client = createOpenRouterClient(apiKey);
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [{ role: "user", content: message }],
        stream: false,
        ...(options?.reasoning ? { reasoning: { enabled: true } } : {}),
      } as Parameters<typeof client.chat.completions.create>[0]);

      const content = (response as { choices?: { message?: { content?: string | null } }[] })
        .choices?.[0]?.message?.content;
      if (typeof content === "string" && content.trim()) {
        return content;
      }
      throw new Error("LLM returned empty content");
    } catch (err) {
      lastError = err instanceof Error ? err : new Error("LLM request failed");
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }
    }
  }

  throw lastError ?? new Error("LLM request failed");
}
