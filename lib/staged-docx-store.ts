import { randomUUID } from "crypto";

const TTL_SECONDS = 600;
const KEY_PREFIX = "resume-tailor:staged:";

type StagedEntry = {
  data: string;
  filename: string;
};

function getRedisEnv(): { url: string; token: string } | null {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN };
  }
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return { url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN };
  }
  return null;
}

function useRedis(): boolean {
  return getRedisEnv() !== null;
}

const globalForStaged = globalThis as unknown as {
  __stagedDocxStore?: Map<string, { entry: StagedEntry; expiresAt: number }>;
};

function memoryStore(): Map<string, { entry: StagedEntry; expiresAt: number }> {
  if (!globalForStaged.__stagedDocxStore) {
    globalForStaged.__stagedDocxStore = new Map();
  }
  return globalForStaged.__stagedDocxStore;
}

async function getRedisClient() {
  const env = getRedisEnv();
  if (!env) throw new Error("Redis env not configured");
  const { Redis } = await import("@upstash/redis");
  return new Redis({ url: env.url, token: env.token });
}

export async function stageDocx(
  buffer: Buffer,
  filename: string
): Promise<string> {
  const token = randomUUID();
  const entry: StagedEntry = {
    data: buffer.toString("base64"),
    filename,
  };

  if (useRedis()) {
    const redis = await getRedisClient();
    await redis.set(`${KEY_PREFIX}${token}`, JSON.stringify(entry), { ex: TTL_SECONDS });
    return token;
  }

  memoryStore().set(token, {
    entry,
    expiresAt: Date.now() + TTL_SECONDS * 1000,
  });
  return token;
}

export async function getStagedDocx(
  token: string
): Promise<{ buffer: Buffer; filename: string } | null> {
  if (!token || !/^[0-9a-f-]{36}$/i.test(token)) return null;

  if (useRedis()) {
    const redis = await getRedisClient();
    const raw = await redis.get<string>(`${KEY_PREFIX}${token}`);
    if (!raw) return null;
    try {
      const entry = (typeof raw === "string" ? JSON.parse(raw) : raw) as StagedEntry;
      return { buffer: Buffer.from(entry.data, "base64"), filename: entry.filename };
    } catch {
      return null;
    }
  }

  const stored = memoryStore().get(token);
  if (!stored || stored.expiresAt < Date.now()) {
    memoryStore().delete(token);
    return null;
  }
  return {
    buffer: Buffer.from(stored.entry.data, "base64"),
    filename: stored.entry.filename,
  };
}

export function isStagedOpenAvailable(): boolean {
  return useRedis() || process.env.NODE_ENV !== "production";
}
