"use client";

/* eslint-disable @next/next/no-img-element */

import { useEffect, useState } from "react";
import {
  buildGeneratedFileName,
  resolveJobTitleForFilename,
  safeFilenameFromFirstLine,
} from "@/lib/generated-filename";

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

const RESUME_MAX = 20000;
const JD_MAX = 20000;
const PROMPT_MAX = 4000;

const THEMES = [
  { id: "gold", label: "Dark Luxury" },
  { id: "emerald", label: "Emerald Noir" },
  { id: "purple", label: "Royal Amethyst" },
  { id: "crimson", label: "Crimson Velvet" },
  { id: "sapphire", label: "Sapphire Night" },
] as const;

const THEME_STORAGE = "resume-tailor-theme";

type IconProps = { className?: string };

const UserIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </svg>
);

const KeyIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="7.5" cy="15.5" r="4.5" />
    <path d="m10.7 12.3 8.3-8.3M17 6l2 2M14 9l2 2" />
  </svg>
);

const SparkleIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
    <path d="M12 1.6c.5 4.4 1.6 6.2 3.4 7.2 1.1.6 2.7 1 5 1.2-2.3.2-3.9.6-5 1.2-1.8 1-2.9 2.8-3.4 7.2-.5-4.4-1.6-6.2-3.4-7.2-1.1-.6-2.7-1-5-1.2 2.3-.2 3.9-.6 5-1.2 1.8-1 2.9-2.8 3.4-7.2z" />
    <path d="M19 14.5c.25 2 .8 2.9 1.7 3.4.55.3 1.35.5 2.3.6-.95.1-1.75.3-2.3.6-.9.5-1.45 1.4-1.7 3.4-.25-2-.8-2.9-1.7-3.4-.55-.3-1.35-.5-2.3-.6.95-.1 1.75-.3 2.3-.6.9-.5 1.45-1.4 1.7-3.4z" />
  </svg>
);

const SlidersIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
  </svg>
);

const BrainIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M9.5 2A2.5 2.5 0 0 0 7 4.5v.5a2.5 2.5 0 0 0-1.5 4.3A2.5 2.5 0 0 0 5 14a2.5 2.5 0 0 0 2 4h.5A2.5 2.5 0 0 0 12 20V4.5A2.5 2.5 0 0 0 9.5 2z" />
    <path d="M14.5 2A2.5 2.5 0 0 1 17 4.5v.5a2.5 2.5 0 0 1 1.5 4.3A2.5 2.5 0 0 1 19 14a2.5 2.5 0 0 1-2 4h-.5A2.5 2.5 0 0 1 12 20" />
  </svg>
);

const DatabaseIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
  </svg>
);

const ChartIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 3v18h18" />
    <path d="m7 14 4-4 3 3 5-6" />
  </svg>
);

const ClockIcon = ({ className }: IconProps) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

const SLOT_META = [
  { label: "AI Engineer", Icon: BrainIcon },
  { label: "Data Engineer", Icon: DatabaseIcon },
  { label: "Data Scientist", Icon: ChartIcon },
  { label: "Data Analyst", Icon: ClockIcon },
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
  const [theme, setTheme] = useState<string>("gold");
  const [slots, setSlots] = useState<SlotState[]>(() =>
    Array.from({ length: SLOT_COUNT }, createEmptySlot)
  );
  const [, setTick] = useState(0);

  useEffect(() => {
    const saved = localStorage.getItem(OPENROUTER_KEY_STORAGE);
    if (saved) setApiKey(saved);
    const savedUser = localStorage.getItem(USERNAME_STORAGE);
    if (savedUser) setUsername(savedUser);
    const savedTheme = localStorage.getItem(THEME_STORAGE);
    if (savedTheme) setTheme(savedTheme);
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem(THEME_STORAGE, theme);
  }, [theme]);

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
    const jobTitle = resolveJobTitleForFilename(jobDescription, slotIndex);
    const generatedFileName = `${buildGeneratedFileName(nameBase, jobTitle)}.docx`;

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
        <div className="rt-comet" aria-hidden />
        <div className="rt-brand">
          <img src="/logo_cut.png" alt="Darius" className="rt-logo" />
          <div className="rt-brand-text">
            <h1 className="rt-title">Resume Tailor</h1>
            <p className="rt-subtitle">
              AI-powered resumes, perfectly tailored.
              <br />
              Generate up to {SLOT_COUNT} tailored resumes in parallel — one shared
              prompt, separate resume and JD per slot.
            </p>
          </div>
        </div>

        <div className="rt-theme-select">
          <select
            aria-label="Theme"
            value={theme}
            onChange={(e) => setTheme(e.target.value)}
          >
            {THEMES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </div>
      </header>

      <section className="rt-controls rt-panel">
        <div className="rt-field rt-field--user">
          <label className="rt-flabel" htmlFor="username">
            <UserIcon /> Username
          </label>
          <input
            id="username"
            type="text"
            className="rt-input"
            value={username}
            onChange={(e) => handleUsernameChange(e.target.value)}
            placeholder="Your name"
            autoComplete="username"
            spellCheck={false}
          />
        </div>

        <div className="rt-field rt-field--key">
          <label className="rt-flabel" htmlFor="openrouter-key">
            <KeyIcon /> OpenRouter key
          </label>
          <div className="rt-input-row">
            <input
              id="openrouter-key"
              type={showApiKey ? "text" : "password"}
              className="rt-input"
              value={apiKey}
              onChange={(e) => handleApiKeyChange(e.target.value)}
              placeholder="sk-or-v1-…"
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className="rt-show-btn"
              onClick={() => setShowApiKey((v) => !v)}
              aria-label={showApiKey ? "Hide API key" : "Show API key"}
            >
              {showApiKey ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        <div className="rt-field rt-field--prompt">
          <label className="rt-flabel" htmlFor="shared-prompt">
            <SparkleIcon /> Shared prompt
          </label>
          <div className="rt-area">
            <textarea
              id="shared-prompt"
              className="rt-textarea rt-textarea--prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Enter your shared prompt here…"
              maxLength={PROMPT_MAX}
            />
            <span
              className={`rt-counter rt-counter--inset${prompt.length >= PROMPT_MAX ? " rt-counter--full" : ""}`}
            >
              {prompt.length} / {PROMPT_MAX}
            </span>
          </div>
        </div>

        <aside className="rt-secure">
          <img
            src="/assets/security_shield_check.png"
            alt=""
            className="rt-secure-shield rt-shield-img"
          />
          <div className="rt-secure-text">
            <span className="rt-secure-title">Your Key is Secure</span>
            <span className="rt-secure-sub">
              Your data is encrypted and never stored.
            </span>
          </div>
          <img
            src="/assets/security_shield_plain.png"
            alt=""
            className="rt-secure-shield rt-secure-shield--ghost rt-shield-img"
          />
        </aside>
      </section>

      <div className="rt-section-head">
        <SlidersIcon /> Generated Resumes ({SLOT_COUNT} slots)
      </div>

      <div className="rt-grid">
        {slots.map((slot, index) => {
          const meta = SLOT_META[index];
          const SlotIcon = meta.Icon;
          return (
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
              <div className="rt-slot-head">
                <span className="rt-slot-num">{index + 1}</span>
                <span className="rt-slot-icon">
                  <SlotIcon />
                </span>
                <h2 className="rt-slot-title">{meta.label}</h2>
              </div>

              <div className="rt-field">
                <label className="rt-flabel" htmlFor={`resume-${index}`}>
                  Resume{" "}
                  <span className="rt-hint">(Paste your base resume in Markdown)</span>
                </label>
                <div className="rt-area">
                  <textarea
                    id={`resume-${index}`}
                    className="rt-textarea rt-textarea--slot rt-textarea--resume"
                    value={slot.resume}
                    onChange={(e) => updateSlot(index, { resume: e.target.value })}
                    placeholder="Paste your resume in Markdown format here…"
                    disabled={slot.loading}
                    maxLength={RESUME_MAX}
                  />
                  <span
                    className={`rt-counter rt-counter--inset${slot.resume.length >= RESUME_MAX ? " rt-counter--full" : ""}`}
                  >
                    {slot.resume.length} / {RESUME_MAX}
                  </span>
                </div>
              </div>

              <div className="rt-field">
                <label className="rt-flabel" htmlFor={`jd-${index}`}>
                  Job description{" "}
                  <span className="rt-hint">(Paste the job description)</span>
                </label>
                <div className="rt-area">
                  <textarea
                    id={`jd-${index}`}
                    className="rt-textarea rt-textarea--slot"
                    value={slot.jobDescription}
                    onChange={(e) => updateSlot(index, { jobDescription: e.target.value })}
                    placeholder="Paste the job description here…"
                    disabled={slot.loading}
                    maxLength={JD_MAX}
                  />
                  <span
                    className={`rt-counter rt-counter--inset${slot.jobDescription.length >= JD_MAX ? " rt-counter--full" : ""}`}
                  >
                    {slot.jobDescription.length} / {JD_MAX}
                  </span>
                </div>
              </div>

              <button
                type="button"
                className={`rt-btn rt-btn--primary${slot.loading ? " rt-btn--loading" : ""}`}
                onClick={() => handleGenerate(index)}
                disabled={slot.loading}
              >
                {slot.loading && slot.loadingStartedAt ? (
                  <>
                    <span className="rt-spinner" aria-hidden />
                    {formatElapsed(slot.loadingStartedAt)}
                  </>
                ) : (
                  <>
                    <SparkleIcon /> Generate
                  </>
                )}
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
          );
        })}
      </div>

      {anyLoading && (
        <p className="rt-status">
          {slots.filter((s) => s.loading).length} generation
          {slots.filter((s) => s.loading).length === 1 ? "" : "s"} in progress…
        </p>
      )}

      <footer className="rt-footer">
        <span className="rt-footer-line" />
        <span className="rt-footer-inner">
          <img
            src="/assets/security_shield_check.png"
            alt=""
            className="rt-footer-shield rt-shield-img"
          />{" "}
          Tailored. Optimized. Outstanding.
        </span>
        <span className="rt-footer-line" />
      </footer>
    </main>
  );
}
