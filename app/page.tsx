"use client";

import { useEffect, useState } from "react";

type SlotState = {
  resume: string;
  jobDescription: string;
  loading: boolean;
  loadingStartedAt: number | null;
  error: string | null;
  generatedBlobUrl: string | null;
  generatedFileName: string | null;
  hasGeneratedDocx: boolean;
  generatedAt: number | null;
  docxOpened: boolean;
};

const SLOT_COUNT = 4;

const SLOT_TITLES = [
  "1 - AI Engineer",
  "2 - Data Engineer",
  "3 - Data Scientist",
  "4 - Data Analyst",
] as const;

function createEmptySlot(): SlotState {
  return {
    resume: "",
    jobDescription: "",
    loading: false,
    loadingStartedAt: null,
    error: null,
    generatedBlobUrl: null,
    generatedFileName: null,
    hasGeneratedDocx: false,
    generatedAt: null,
    docxOpened: false,
  };
}

function formatTimeAgo(createdAt: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - createdAt) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return mins === 1 ? "1 min ago" : `${mins} mins ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs === 1 ? "1 hr ago" : `${hrs} hrs ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "1 day ago" : `${days} days ago`;
}

function formatElapsed(startedAt: number): string {
  const secs = Math.floor((Date.now() - startedAt) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return m > 0 ? `${m}:${s.toString().padStart(2, "0")}` : `${s}s`;
}

function revokeBlobUrl(url: string | null) {
  if (url) URL.revokeObjectURL(url);
}

async function createTemplateDocxBlob(
  content: string,
  filename: string,
  slot: number,
  baseResume?: string
): Promise<Blob> {
  const res = await fetch("/api/docx", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content,
      baseResume: baseResume ?? "",
      filename,
      slot,
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error ?? "DOCX generation failed");
  }
  return res.blob();
}

function downloadBlob(blobUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  a.click();
}

function isLocalDevHost(): boolean {
  if (typeof window === "undefined") return false;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1";
}

/** Open DOCX in Word via ms-word: protocol (Windows/macOS with Office installed). */
function tryOpenInWord(fileUrl: string): boolean {
  const ua = navigator.userAgent;
  if (!/Windows|Macintosh|Mac OS X/i.test(ua)) return false;
  window.location.href = `ms-word:ofe|u|${encodeURIComponent(fileUrl)}`;
  return true;
}

/** Characters not allowed in filenames (Windows / cross‑platform). */
const INVALID_FILENAME_RE = /[\\/:*?"<>|\x00-\x1f#\[\]{};@!$&'`+=]/gi;

const MAX_BASE_LENGTH = 60;

/** Build a safe filename base from the first line of resume text. */
function safeFilenameFromFirstLine(firstLine: string): string {
  const cleaned = firstLine
    .replace(INVALID_FILENAME_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const base = cleaned || "resume";
  return base.length > MAX_BASE_LENGTH ? base.slice(0, MAX_BASE_LENGTH) : base;
}

const CATEGORY_A = [
  "Recent",
  "2026",
  "Updated",
  "RecentUpdated",
  "Recent_updated",
  "Recent updated",
  "Latest",
  "Latest_updated",
  "Latest updated",
  "LatestUpdated",
  "Current",
  "Final",
  "2026 updated",
  "2026_updated",
  "2026Updated",
] as const;

const CATEGORY_B = ["Resume", "CV", "Profile"] as const;

const SEPARATORS = ["-", "_", " ", ""] as const;

const TOTAL_COMBOS =
  2 *
  SEPARATORS.length *
  SEPARATORS.length *
  CATEGORY_A.length *
  CATEGORY_B.length;

let downloadCounter = 0;

/**
 * Next DOCX filename: name + sep1 + part1 + sep2 + part2.
 * Two separators: one between name and first part (A or B), one between first and second part.
 */
function getNextDocxSuffix(nameBase: string): string {
  const index = downloadCounter % TOTAL_COMBOS;
  downloadCounter += 1;

  const order = index % 2;
  const sep1Index = Math.floor(index / 2) % SEPARATORS.length;
  const sep2Index =
    Math.floor(index / (2 * SEPARATORS.length)) % SEPARATORS.length;
  const aIndex =
    Math.floor(index / (2 * SEPARATORS.length * SEPARATORS.length)) %
    CATEGORY_A.length;
  const bIndex =
    Math.floor(
      index / (2 * SEPARATORS.length * SEPARATORS.length * CATEGORY_A.length)
    ) % CATEGORY_B.length;

  const sep1 = SEPARATORS[sep1Index];
  const sep2 = SEPARATORS[sep2Index];
  const a = CATEGORY_A[aIndex];
  const b = CATEGORY_B[bIndex];

  const part1 = order === 0 ? a : b;
  const part2 = order === 0 ? b : a;

  return `${nameBase}${sep1}${part1}${sep2}${part2}`;
}

const BUILTIN_DEFAULT_PROMPT = `prompt here`;

const envPrompt = process.env.NEXT_PUBLIC_DEFAULT_PROMPT?.trim();
const DEFAULT_PROMPT = envPrompt || BUILTIN_DEFAULT_PROMPT;

const OPENROUTER_KEY_STORAGE = "resume-tailor-openrouter-key";
const USERNAME_STORAGE = "resume-tailor-username";
const SOURCE_APP = "darius";

async function reportCentralLog(payload: {
  username: string;
  jobDescription: string;
  resumeContent: string;
  filename?: string;
  slotTitle: string;
  errorMessage?: string;
}) {
  try {
    await fetch("/api/central-log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, sourceApp: SOURCE_APP }),
    });
  } catch {
    // non-blocking
  }
}

export default function Home() {
  const [prompt, setPrompt] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [username, setUsername] = useState("");
  const [showApiKey, setShowApiKey] = useState(false);
  const [slots, setSlots] = useState<SlotState[]>(() =>
    Array.from({ length: SLOT_COUNT }, createEmptySlot)
  );
  const [, setTick] = useState(0);

  useEffect(() => {
    const saved = localStorage.getItem(OPENROUTER_KEY_STORAGE);
    if (saved) setApiKey(saved);
    const savedUser = localStorage.getItem(USERNAME_STORAGE);
    if (savedUser) setUsername(savedUser);
  }, []);

  function handleUsernameChange(value: string) {
    setUsername(value);
    const trimmed = value.trim();
    if (trimmed) {
      localStorage.setItem(USERNAME_STORAGE, trimmed);
    } else {
      localStorage.removeItem(USERNAME_STORAGE);
    }
  }

  function handleApiKeyChange(value: string) {
    setApiKey(value);
    const trimmed = value.trim();
    if (trimmed) {
      localStorage.setItem(OPENROUTER_KEY_STORAGE, trimmed);
    } else {
      localStorage.removeItem(OPENROUTER_KEY_STORAGE);
    }
  }

  const anyLoading = slots.some((s) => s.loading);
  const anyGenerated = slots.some((s) => s.generatedAt !== null);

  useEffect(() => {
    if (!anyLoading) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [anyLoading]);

  useEffect(() => {
    if (!anyGenerated) return;
    const id = setInterval(() => setTick((t) => t + 1), 60_000);
    return () => clearInterval(id);
  }, [anyGenerated]);

  function updateSlot(index: number, patch: Partial<SlotState>) {
    setSlots((prev) =>
      prev.map((slot, i) => {
        if (i !== index) return slot;
        if (
          patch.generatedBlobUrl !== undefined &&
          patch.generatedBlobUrl !== slot.generatedBlobUrl
        ) {
          revokeBlobUrl(slot.generatedBlobUrl);
        }
        return { ...slot, ...patch };
      })
    );
  }

  async function openGeneratedDocx(index: number) {
    const slot = slots[index];
    if (!slot.hasGeneratedDocx || !slot.generatedBlobUrl) return;

    if (isLocalDevHost()) {
      try {
        const res = await fetch("/api/docx/open-local", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slot: index }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          updateSlot(index, { error: data.error ?? "Could not open file" });
          return;
        }
        updateSlot(index, { docxOpened: true, error: null });
      } catch (err) {
        updateSlot(index, {
          error: err instanceof Error ? err.message : "Could not open file",
        });
      }
      return;
    }

    try {
      const blob = await fetch(slot.generatedBlobUrl).then((r) => r.blob());
      const filename = slot.generatedFileName ?? "resume.docx";
      const formData = new FormData();
      formData.append("file", blob, filename);

      const stageRes = await fetch("/api/docx/stage", { method: "POST", body: formData });
      const stageData = await stageRes.json().catch(() => ({}));
      if (!stageRes.ok) {
        updateSlot(index, {
          error: stageData.error ?? "Could not prepare file for Word",
        });
        return;
      }

      const fileUrl = typeof stageData.fileUrl === "string" ? stageData.fileUrl : "";
      if (!fileUrl) {
        updateSlot(index, { error: "Could not prepare file for Word" });
        return;
      }

      if (tryOpenInWord(fileUrl)) {
        updateSlot(index, { docxOpened: true, error: null });
        return;
      }

      downloadBlob(slot.generatedBlobUrl, filename);
      updateSlot(index, {
        docxOpened: true,
        error: null,
      });
    } catch (err) {
      updateSlot(index, {
        error: err instanceof Error ? err.message : "Could not open file",
      });
    }
  }

  async function fetchWithRetry(
    url: string,
    options: RequestInit,
    maxRetries = 3
  ): Promise<Response> {
    const retryableStatuses = [408, 429, 502, 503, 504];
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, options);
        if (res.ok || !retryableStatuses.includes(res.status) || attempt === maxRetries) {
          return res;
        }
        await res.text();
        lastError = new Error(`HTTP ${res.status}`);
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") throw err;
        lastError = err instanceof Error ? err : new Error("Request failed");
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        } else {
          throw lastError;
        }
      }
    }
    throw lastError ?? new Error("Request failed");
  }

  async function readStreamedChatResponse(
    res: Response,
    slotIndex: number,
    generatedFileName: string,
    baseResume: string,
    jobDescription: string,
    logUsername: string
  ): Promise<void> {
    const slotTitle = SLOT_TITLES[slotIndex] ?? `Slot ${slotIndex + 1}`;
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("ndjson")) {
      const data = await res.json();
      const errMsg = data.error ?? `Request failed (${res.status})`;
      updateSlot(slotIndex, { error: errMsg });
      void reportCentralLog({
        username: logUsername,
        jobDescription,
        resumeContent: "",
        filename: generatedFileName,
        slotTitle,
        errorMessage: errMsg,
      });
      return;
    }
    const reader = res.body?.getReader();
    if (!reader) {
      updateSlot(slotIndex, { error: "No response body" });
      void reportCentralLog({
        username: logUsername,
        jobDescription,
        resumeContent: "",
        filename: generatedFileName,
        slotTitle,
        errorMessage: "No response body",
      });
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let obj: { content?: string; done?: boolean; error?: string };
          try {
            obj = JSON.parse(trimmed) as typeof obj;
          } catch {
            continue;
          }
          if (obj.error) {
            updateSlot(slotIndex, { error: obj.error });
            void reportCentralLog({
              username: logUsername,
              jobDescription,
              resumeContent: content,
              filename: generatedFileName,
              slotTitle,
              errorMessage: obj.error,
            });
            return;
          }
          if (obj.content !== undefined) content += obj.content;
        }
      }
      if (!content.trim()) {
        updateSlot(slotIndex, { error: "LLM returned empty content" });
        void reportCentralLog({
          username: logUsername,
          jobDescription,
          resumeContent: "",
          filename: generatedFileName,
          slotTitle,
          errorMessage: "LLM returned empty content",
        });
        return;
      }
      const blob = await createTemplateDocxBlob(
        content,
        generatedFileName,
        slotIndex,
        baseResume
      );
      const blobUrl = URL.createObjectURL(blob);
      updateSlot(slotIndex, {
        generatedBlobUrl: blobUrl,
        generatedFileName,
        hasGeneratedDocx: true,
        generatedAt: Date.now(),
        docxOpened: false,
        error: null,
      });
      downloadBlob(blobUrl, generatedFileName);
      void reportCentralLog({
        username: logUsername,
        jobDescription,
        resumeContent: content,
        filename: generatedFileName,
        slotTitle,
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Stream read failed";
      updateSlot(slotIndex, { error: errMsg });
      void reportCentralLog({
        username: logUsername,
        jobDescription,
        resumeContent: "",
        filename: generatedFileName,
        slotTitle,
        errorMessage: errMsg,
      });
    }
  }

  async function handleGenerate(slotIndex: number) {
    const slot = slots[slotIndex];
    if (!slot) return;

    if (!slot.resume.trim()) {
      updateSlot(slotIndex, { error: "Please paste a resume." });
      return;
    }
    if (!slot.jobDescription.trim()) {
      updateSlot(slotIndex, { error: "Please paste a job description." });
      return;
    }
    if (!username.trim()) {
      updateSlot(slotIndex, { error: "Please enter your username." });
      return;
    }

    const logUsername = username.trim();
    const jobDescription = slot.jobDescription.trim();

    updateSlot(slotIndex, {
      error: null,
      generatedBlobUrl: null,
      generatedFileName: null,
      hasGeneratedDocx: false,
      generatedAt: null,
      docxOpened: false,
    });

    const parts: string[] = [];
    const effectivePrompt = prompt.trim() || DEFAULT_PROMPT;
    if (effectivePrompt) parts.push(effectivePrompt);
    parts.push("=== RESUME ===\n\n" + slot.resume.trim());
    parts.push("=== JD (Job Description) ===\n\n" + jobDescription);
    const merged = parts.join("\n\n");
    if (!merged.trim()) {
      updateSlot(slotIndex, { error: "Nothing to send. Check prompt, resume, and JD." });
      return;
    }

    updateSlot(slotIndex, { loading: true, loadingStartedAt: Date.now() });

    const firstLine = slot.resume.split(/\r?\n/)[0]?.trim() ?? "";
    const nameBase = safeFilenameFromFirstLine(firstLine);
    const filenameBase = getNextDocxSuffix(nameBase);
    const generatedFileName = `${filenameBase}.docx`;

    try {
      const res = await fetchWithRetry("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: merged,
          generatedFileName,
          ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const errMsg = data.error ?? `Request failed (${res.status})`;
        updateSlot(slotIndex, { error: errMsg });
        void reportCentralLog({
          username: logUsername,
          jobDescription,
          resumeContent: "",
          filename: generatedFileName,
          slotTitle: SLOT_TITLES[slotIndex] ?? `Slot ${slotIndex + 1}`,
          errorMessage: errMsg,
        });
        return;
      }
      await readStreamedChatResponse(
        res,
        slotIndex,
        generatedFileName,
        slot.resume,
        jobDescription,
        logUsername
      );
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : "Request failed";
      updateSlot(slotIndex, { error: errMsg });
      void reportCentralLog({
        username: logUsername,
        jobDescription,
        resumeContent: "",
        filename: generatedFileName,
        slotTitle: SLOT_TITLES[slotIndex] ?? `Slot ${slotIndex + 1}`,
        errorMessage: errMsg,
      });
    } finally {
      updateSlot(slotIndex, { loading: false, loadingStartedAt: null });
    }
  }

  return (
    <main className="rt-main">
      <header className="rt-header">
        <div className="rt-header-top">
          <div>
            <h1 className="rt-title">Resume Tailor - Darius</h1>
            <p className="rt-subtitle">
              LLM content is inserted directly into template2.docx. Generate up to{" "}
              {SLOT_COUNT} tailored resumes in parallel — one shared prompt, separate
              resume and JD per slot.
            </p>
          </div>

          <div className="rt-header-controls">
            <div className="rt-key-bar rt-key-bar--inline">
              <div className="rt-inline-field rt-inline-field--user">
                <div className="rt-key-bar-head">
                  <span
                    className={`rt-key-dot${username.trim() ? " rt-key-dot--active" : ""}`}
                    aria-hidden
                  />
                  <label className="rt-key-label" htmlFor="username">
                    Username
                  </label>
                </div>
                <div className="rt-key-input-row">
                  <input
                    id="username"
                    type="text"
                    className="rt-key-input"
                    value={username}
                    onChange={(e) => handleUsernameChange(e.target.value)}
                    placeholder="Your name"
                    autoComplete="username"
                    spellCheck={false}
                  />
                </div>
              </div>

              <div className="rt-inline-field rt-inline-field--key">
                <div className="rt-key-bar-head">
                  <span
                    className={`rt-key-dot${apiKey.trim() ? " rt-key-dot--active" : ""}`}
                    aria-hidden
                  />
                  <label className="rt-key-label" htmlFor="openrouter-key">
                    OpenRouter key
                  </label>
                  <span className="rt-key-badge">
                    {apiKey.trim() ? "Your key" : "Server key"}
                  </span>
                </div>
                <div className="rt-key-input-row">
                  <input
                    id="openrouter-key"
                    type={showApiKey ? "text" : "password"}
                    className="rt-key-input"
                    value={apiKey}
                    onChange={(e) => handleApiKeyChange(e.target.value)}
                    placeholder="sk-or-v1-…"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="rt-key-toggle"
                    onClick={() => setShowApiKey((v) => !v)}
                    aria-label={showApiKey ? "Hide API key" : "Show API key"}
                    title={showApiKey ? "Hide" : "Show"}
                  >
                    {showApiKey ? "Hide" : "Show"}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section className="rt-prompt-panel">
        <label className="rt-label" htmlFor="shared-prompt">
          Prompt (shared)
        </label>
        <textarea
          id="shared-prompt"
          className="rt-textarea rt-textarea--prompt"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={DEFAULT_PROMPT}
        />
      </section>

      <div className="rt-grid">
        {slots.map((slot, index) => (
          <section
            key={index}
            className={`rt-slot${slot.loading ? " rt-slot--loading" : ""}${
              slot.hasGeneratedDocx && !slot.error
                ? slot.docxOpened
                  ? " rt-slot--opened"
                  : " rt-slot--ready"
                : ""
            }`}
          >
            <h2 className="rt-slot-title">{SLOT_TITLES[index]}</h2>

            <label className="rt-label" htmlFor={`resume-${index}`}>
              Resume
            </label>
            <textarea
              id={`resume-${index}`}
              className="rt-textarea rt-textarea--slot rt-textarea--resume"
              value={slot.resume}
              onChange={(e) => updateSlot(index, { resume: e.target.value })}
              placeholder="Paste resume text here..."
              disabled={slot.loading}
            />

            <label className="rt-label" htmlFor={`jd-${index}`}>
              Job description
            </label>
            <textarea
              id={`jd-${index}`}
              className="rt-textarea rt-textarea--slot"
              value={slot.jobDescription}
              onChange={(e) => updateSlot(index, { jobDescription: e.target.value })}
              placeholder="Paste job description here..."
              disabled={slot.loading}
            />

            <button
              type="button"
              className={`rt-btn rt-btn--primary${slot.loading ? " rt-btn--loading" : ""}`}
              onClick={() => handleGenerate(index)}
              disabled={slot.loading}
            >
              {slot.loading && slot.loadingStartedAt
                ? formatElapsed(slot.loadingStartedAt)
                : "Generate"}
            </button>

            {slot.error && (
              <p role="alert" className="rt-error">
                {slot.error}
              </p>
            )}

            {slot.hasGeneratedDocx && !slot.error && (
              <div className="rt-open-row rt-fade-in">
                <button
                  type="button"
                  className="rt-btn rt-btn--secondary rt-open-btn"
                  onClick={() => openGeneratedDocx(index)}
                >
                  Open
                </button>
                {slot.generatedAt !== null && (
                  <span className="rt-created-at" title="Created at">
                    {formatTimeAgo(slot.generatedAt)}
                  </span>
                )}
              </div>
            )}
          </section>
        ))}
      </div>

      {anyLoading && (
        <p className="rt-status">
          {slots.filter((s) => s.loading).length} generation
          {slots.filter((s) => s.loading).length === 1 ? "" : "s"} in progress…
        </p>
      )}
    </main>
  );
}
