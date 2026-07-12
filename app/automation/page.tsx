"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseJobUrls } from "@/lib/automation/parse-urls";
import type { AutomationProgressEvent } from "@/lib/automation/types";
import {
  loadSettings,
  mergeServerConfig,
  type AutomationSettings,
} from "@/lib/automation/settings";

type JobRow = {
  index: number;
  url: string;
  company: string;
  position: string;
  slotType: string;
  resumeType: number;
  status: "waiting" | "processing" | "completed" | "failed" | "skipped";
  statusLabel: string;
  updatedAt: number | null;
  startedAt?: number | null;
  elapsedMs?: number | null;
  stepTimings: Record<string, number>;
  stepStartedAt?: number | null;
  folderPath?: string;
  folderName?: string;
  resumeBaseName?: string;
  hasPdf?: boolean;
  error?: string;
  rawJd?: string;
  extractedJd?: string;
  updatedResume?: string;
  steps: Record<string, boolean>;
};

type PreviewTab = "raw" | "extracted" | "resume";

const RESUME_NAME_STORAGE = "auto-resume-tailor-resume-name";
const URLS_TEXT_STORAGE = "auto-resume-tailor-job-urls";
const CONCURRENCY_STORAGE = "auto-resume-tailor-concurrency";
const DEFAULT_CONCURRENCY = 4;

const PIPELINE_STEPS = [
  { id: "url_loaded", label: "URL opened" },
  { id: "jd_extracted", label: "Raw JD extracted" },
  { id: "resume_type", label: "OpenRouter extraction completed" },
  { id: "resume_generating", label: "Resume generating" },
  { id: "resume_generated", label: "Resume generated" },
  { id: "folder_created", label: "Folder created & files saved" },
] as const;

const SLOT_COLORS = ["#34d399", "#60a5fa", "#c084fc", "#fb923c"];

function formatAgo(ts: number | null): string {
  if (!ts) return "—";
  const mins = Math.floor((Date.now() - ts) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  return `${hrs} hr${hrs === 1 ? "" : "s"} ago`;
}

function formatElapsed(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function companyInitials(name: string): string {
  const parts = name.replace(/_/g, " ").split(/\s+/).filter(Boolean);
  if (!parts.length) return "?";
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

function createJobRow(index: number, url: string): JobRow {
  return {
    index,
    url,
    company: "—",
    position: "—",
    slotType: "—",
    resumeType: 0,
    status: "waiting",
    statusLabel: "Waiting",
    updatedAt: null,
    stepTimings: {},
    steps: {},
  };
}

function statusFromJob(job: JobRow): string {
  if (job.status === "completed") return "Done";
  if (job.status === "failed") return "Failed";
  if (job.status === "skipped") return "Skipped";
  if (job.steps.resume_generating && !job.steps.resume_generated) return "Generating";
  if (job.steps.jd_extracted && !job.steps.resume_type) return "Extracting JD";
  if (job.status === "processing") return "Processing";
  return "Waiting";
}

// Per-job progress milestones (matches the pipeline stages).
const STEP_PROGRESS: Record<string, number> = {
  url_loaded: 0.1, // scraped JD from URL
  jd_extracted: 0.2, // extracted JD via OpenRouter
  resume_type: 0.25, // slot selected
  resume_generating: 0.3, // tailoring started
  resume_generated: 0.9, // resume updated
  folder_created: 1, // downloaded & saved
};

/** Fraction (0–1) of how far a single job has progressed. */
function jobFraction(job: JobRow): number {
  if (job.status === "completed") return 1;
  if (job.status === "failed" || job.status === "skipped") return 1;
  let frac = 0;
  for (const [step, value] of Object.entries(STEP_PROGRESS)) {
    if (job.steps[step]) frac = Math.max(frac, value);
  }
  return frac;
}

function sanitizeResumeDisplayName(name: string): string {
  const cleaned = name.trim().replace(/[^\w.\-]+/g, "_").replace(/_+/g, "_");
  return cleaned ? `${cleaned}_resume` : "resume_resume";
}

export default function AutomationDashboard() {
  const [urlsText, setUrlsText] = useState(() => {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(URLS_TEXT_STORAGE) ?? "";
  });
  const [resumeNamePrefix, setResumeNamePrefix] = useState("resume");
  const [concurrency, setConcurrency] = useState(DEFAULT_CONCURRENCY);
  const [previewTab, setPreviewTab] = useState<PreviewTab>("raw");
  const [settings, setSettings] = useState<AutomationSettings | null>(null);
  const [running, setRunning] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [completed, setCompleted] = useState(0);
  const [failed, setFailed] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [batchFolderPaths, setBatchFolderPaths] = useState<string[]>([]);
  const [batchStartedAt, setBatchStartedAt] = useState<number | null>(null);
  const [batchElapsedMs, setBatchElapsedMs] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const stopRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  /** Full per-job files for browser ZIP fallback (Vercel). */
  const batchFilesRef = useRef<
    {
      folderName: string;
      files: { fileName: string; base64: string }[];
    }[]
  >([]);

  useEffect(() => {
    if (!batchStartedAt) return;
    // Keep ticking while running, or until we freeze elapsed on batch_complete.
    if (!running && batchElapsedMs > 0) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [running, batchStartedAt, batchElapsedMs]);

  const liveBatchElapsed = !batchStartedAt
    ? 0
    : !running && batchElapsedMs > 0
      ? batchElapsedMs
      : Math.max(0, nowTick - batchStartedAt);

  useEffect(() => {
    const saved = loadSettings();
    const savedName = localStorage.getItem(RESUME_NAME_STORAGE);
    if (savedName) setResumeNamePrefix(savedName);
    const savedConcurrency = Number(localStorage.getItem(CONCURRENCY_STORAGE));
    if (Number.isFinite(savedConcurrency) && savedConcurrency >= 1 && savedConcurrency <= 10) {
      setConcurrency(Math.floor(savedConcurrency));
    }
    fetch("/api/automation/config")
      .then((r) => r.json())
      .then((server) => setSettings(mergeServerConfig(saved, server)))
      .catch(() => setSettings(saved));
  }, []);

  useEffect(() => {
    localStorage.setItem(URLS_TEXT_STORAGE, urlsText);
  }, [urlsText]);

  const urlCount = parseJobUrls(urlsText).length;
  const total = jobs.length || urlCount;
  const processing = jobs.filter((j) => j.status === "processing").length;
  const remaining = Math.max(0, total - completed - failed - skipped - processing);
  const progressPct =
    jobs.length > 0
      ? Math.round(
          (jobs.reduce((sum, j) => sum + jobFraction(j), 0) / jobs.length) * 100
        )
      : 0;

  const updateJob = useCallback((index: number, patch: Partial<JobRow>) => {
    setJobs((prev) =>
      prev.map((j) => {
        if (j.index !== index) return j;
        const resetting =
          patch.status === "processing" &&
          patch.stepTimings !== undefined &&
          Object.keys(patch.stepTimings).length === 0;
        return {
          ...j,
          ...patch,
          steps: resetting
            ? {}
            : patch.steps
              ? { ...j.steps, ...patch.steps }
              : j.steps,
          stepTimings: resetting
            ? {}
            : patch.stepTimings
              ? { ...j.stepTimings, ...patch.stepTimings }
              : j.stepTimings,
          updatedAt: Date.now(),
        };
      })
    );
  }, []);

  const handleEvent = useCallback(
    (event: AutomationProgressEvent) => {
      if (event.type === "batch_start") {
        setBatchStartedAt(Date.now());
        setBatchElapsedMs(0);
        setNowTick(Date.now());
        return;
      }
      if (event.type === "heartbeat") {
        setNowTick(event.at || Date.now());
        return;
      }
      if (event.type === "job_start") {
        setActiveIndex(event.index);
        updateJob(event.index, {
          status: "processing",
          statusLabel: "Processing",
          url: event.url,
          startedAt: Date.now(),
          elapsedMs: 0,
          steps: {},
          stepTimings: {},
          stepStartedAt: Date.now(),
          error: undefined,
          rawJd: undefined,
          extractedJd: undefined,
          updatedResume: undefined,
        });
        return;
      }
      if (event.type === "job_meta") {
        updateJob(event.index, {
          company: event.companyName,
          position: event.positionName,
          slotType: `${event.resumeType} — ${event.slotLabel}`,
          resumeType: event.resumeType,
          folderName: event.folderName,
        });
        return;
      }
      if (event.type === "step") {
        setActiveIndex(event.index);
        const stepPatch: Partial<JobRow> = {
          steps: { [event.step]: true },
          statusLabel: event.message,
          elapsedMs: event.elapsedMs ?? undefined,
          stepStartedAt: Date.now(),
        };
        if (event.stepElapsedMs != null) {
          stepPatch.stepTimings = { [event.step]: event.stepElapsedMs };
        }
        updateJob(event.index, stepPatch);
        return;
      }
      if (event.type === "job_raw_jd") {
        setActiveIndex(event.index);
        setPreviewTab("raw");
        updateJob(event.index, { rawJd: event.rawJd });
        return;
      }
      if (event.type === "job_extracted_jd") {
        setActiveIndex(event.index);
        setPreviewTab("extracted");
        updateJob(event.index, { extractedJd: event.extractedJd });
        return;
      }
      if (event.type === "job_resume_content") {
        setActiveIndex(event.index);
        setPreviewTab("resume");
        updateJob(event.index, { updatedResume: event.resumeMarkdown });
        return;
      }
      if (event.type === "job_complete") {
        if (event.artifacts) {
          const a = event.artifacts;
          const files: { fileName: string; base64: string }[] = [
            {
              fileName: "job_url.txt",
              base64: btoa(unescape(encodeURIComponent(a.jobUrl + "\n"))),
            },
            {
              fileName: "raw_jd.txt",
              base64: btoa(unescape(encodeURIComponent(a.rawJd))),
            },
            {
              fileName: "extracted_jd.txt",
              base64: btoa(unescape(encodeURIComponent(a.extractedJd))),
            },
            {
              fileName: "updated_resume.md",
              base64: btoa(unescape(encodeURIComponent(a.resumeMarkdown))),
            },
            { fileName: a.resumeFileName, base64: a.docxBase64 },
          ];
          if (a.pdfBase64) {
            files.push({
              fileName: a.resumeFileName.replace(/\.docx$/i, ".pdf"),
              base64: a.pdfBase64,
            });
          }
          batchFilesRef.current.push({ folderName: event.folderName, files });
        }
        updateJob(event.index, {
          status: "completed",
          statusLabel: `Done (${formatElapsed(event.elapsedMs)})`,
          folderPath: event.folderPath,
          folderName: event.folderName,
          company: event.companyName,
          position: event.positionName,
          slotType: event.slotLabel,
          hasPdf: event.hasPdf,
          elapsedMs: event.elapsedMs,
        });
        setCompleted((c) => c + 1);
        return;
      }
      if (event.type === "job_failed") {
        updateJob(event.index, {
          status: "failed",
          statusLabel: event.elapsedMs
            ? `Failed (${formatElapsed(event.elapsedMs)})`
            : "Failed",
          error: event.error,
          elapsedMs: event.elapsedMs,
        });
        setFailed((f) => f + 1);
        return;
      }
      if (event.type === "job_skipped") {
        updateJob(event.index, {
          status: "skipped",
          statusLabel: event.elapsedMs
            ? `Skipped (${formatElapsed(event.elapsedMs)})`
            : "Skipped",
          error: event.error,
          elapsedMs: event.elapsedMs,
        });
        setSkipped((s) => s + 1);
        return;
      }
      if (event.type === "batch_complete") {
        setCompleted(event.completed);
        setFailed(event.failed);
        setSkipped(event.skipped);
        setBatchFolderPaths(event.folderPaths);
        setBatchElapsedMs(event.elapsedMs);
        setActiveIndex(null);
      }
    },
    [updateJob]
  );

  function triggerBlobDownload(blob: Blob, filename: string) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function downloadBase64Zip(zipBase64: string, zipFileName: string) {
    const binary = atob(zipBase64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    triggerBlobDownload(new Blob([bytes], { type: "application/zip" }), zipFileName);
  }

  /** Minimal store-only ZIP so Vercel can still download when the API zip route has empty /tmp. */
  function zipFilesFromBatch(
    jobs: { folderName: string; files: { fileName: string; base64: string }[] }[]
  ): Blob {
    const encoder = new TextEncoder();
    const parts: Uint8Array[] = [];
    const central: Uint8Array[] = [];
    let offset = 0;
    let fileCount = 0;

    const u16 = (n: number) => {
      const b = new Uint8Array(2);
      new DataView(b.buffer).setUint16(0, n, true);
      return b;
    };
    const u32 = (n: number) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, n, true);
      return b;
    };
    const concat = (chunks: Uint8Array[]) => {
      const len = chunks.reduce((s, c) => s + c.length, 0);
      const out = new Uint8Array(len);
      let o = 0;
      for (const c of chunks) {
        out.set(c, o);
        o += c.length;
      }
      return out;
    };

    const addFile = (pathName: string, base64: string) => {
      const nameBytes = encoder.encode(pathName);
      const dataBinary = atob(base64);
      const data = new Uint8Array(dataBinary.length);
      for (let i = 0; i < dataBinary.length; i++) data[i] = dataBinary.charCodeAt(i);

      const local = concat([
        u32(0x04034b50),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        nameBytes,
        data,
      ]);
      parts.push(local);

      const cen = concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(data.length),
        u32(data.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        nameBytes,
      ]);
      central.push(cen);
      offset += local.length;
      fileCount++;
    };

    for (const job of jobs) {
      for (const file of job.files) {
        addFile(`${job.folderName}/${file.fileName}`, file.base64);
      }
    }

    const centralDir = concat(central);
    const end = concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(fileCount),
      u16(fileCount),
      u32(centralDir.length),
      u32(offset),
      u16(0),
    ]);

    return new Blob([concat([...parts, centralDir, end])], { type: "application/zip" });
  }

  async function downloadZip(prefix?: string, folderPaths?: string[], inlineZip?: { base64: string; fileName: string }) {
    const name = (prefix ?? resumeNamePrefix).trim() || "resume";
    const zipName = `${name}_resumes.zip`;

    if (inlineZip?.base64) {
      downloadBase64Zip(inlineZip.base64, inlineZip.fileName || zipName);
      return;
    }

    if (batchFilesRef.current.length > 0) {
      try {
        triggerBlobDownload(zipFilesFromBatch(batchFilesRef.current), zipName);
        return;
      } catch {
        // fall through to API
      }
    }

    if (!settings) return;
    const paths = folderPaths ?? batchFolderPaths;
    if (!paths.length) {
      setError("No completed resumes from this batch to download.");
      return;
    }
    try {
      const res = await fetch("/api/automation/download-zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          outputDir: settings.outputDir,
          zipFileName: zipName,
          folderPaths: paths,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(
          data.error ??
            "ZIP failed — on Vercel the temp folder is cleared after the run; re-run and use the automatic download."
        );
      }
      const blob = await res.blob();
      triggerBlobDownload(blob, zipName);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Download failed");
    }
  }

  async function handleStart() {
    if (running || !settings) return;
    const urls = parseJobUrls(urlsText);
    if (!urls.length) {
      setError("Paste at least one job URL.");
      return;
    }
    if (!settings.extractionPrompt.trim()) {
      setError("Set your extraction prompt in Settings first.");
      return;
    }
    if (!resumeNamePrefix.trim()) {
      setError("Enter a resume name prefix (e.g. darius).");
      return;
    }

    localStorage.setItem(RESUME_NAME_STORAGE, resumeNamePrefix.trim());
    localStorage.setItem(CONCURRENCY_STORAGE, String(concurrency));

    setError(null);
    setRunning(true);
    setStopRequested(false);
    stopRef.current = false;
    setCompleted(0);
    setFailed(0);
    setSkipped(0);
    setBatchFolderPaths([]);
    batchFilesRef.current = [];
    setBatchStartedAt(Date.now());
    setBatchElapsedMs(0);
    setJobs(urls.map((u, i) => createJobRow(i + 1, u)));

    const controller = new AbortController();
    abortRef.current = controller;
    let batchCompleted = 0;
    let batchFolders: string[] = [];
    let inlineZip: { base64: string; fileName: string } | undefined;
    let sawBatchComplete = false;
    const startedAt = Date.now();

    const failIncompleteJobs = (reason: string) => {
      setJobs((prev) =>
        prev.map((j) => {
          if (
            j.status === "completed" ||
            j.status === "failed" ||
            j.status === "skipped"
          ) {
            return j;
          }
          return {
            ...j,
            status: "failed",
            statusLabel: "Interrupted",
            error: reason,
            updatedAt: Date.now(),
          };
        })
      );
    };

    try {
      const res = await fetch("/api/automation/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          urlsText,
          extractionPrompt: settings.extractionPrompt,
          tailoringPrompt: settings.tailoringPrompt,
          baseResumes: settings.baseResumes,
          outputDir: settings.outputDir,
          resumeNamePrefix: resumeNamePrefix.trim(),
          apiKey: settings.apiKey.trim() || undefined,
          concurrency:
            typeof window !== "undefined" &&
            window.location.hostname !== "localhost" &&
            window.location.hostname !== "127.0.0.1"
              ? 1
              : concurrency,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `Request failed (${res.status})`);
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");

      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done || stopRef.current) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const json = trimmed.slice(5).trim();
          if (!json) continue;
          const event = JSON.parse(json) as AutomationProgressEvent | { type: "error"; message?: string };
          if (event.type === "error") throw new Error(event.message ?? "Pipeline error");
          if (event.type === "batch_complete") {
            sawBatchComplete = true;
            batchCompleted = event.completed;
            batchFolders = event.folderPaths;
            if (event.zipBase64) {
              inlineZip = {
                base64: event.zipBase64,
                fileName: event.zipFileName || `${resumeNamePrefix.trim() || "resume"}_resumes.zip`,
              };
            }
          }
          handleEvent(event);
        }
      }

      if (!sawBatchComplete && !stopRef.current) {
        const reason =
          "Connection ended before the batch finished (common on Vercel after ~5 minutes). Incomplete jobs were stopped — use localhost or run 2–3 URLs at a time.";
        failIncompleteJobs(reason);
        setError(reason);
        setBatchElapsedMs(Date.now() - startedAt);
      }

      if (batchCompleted > 0 && !stopRef.current) {
        await downloadZip(resumeNamePrefix.trim(), batchFolders, inlineZip);
      }
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        setError(err.message);
        if (!sawBatchComplete) {
          failIncompleteJobs(err.message);
          setBatchElapsedMs(Date.now() - startedAt);
        }
      }
    } finally {
      setJobs((prev) => {
        const c = prev.filter((j) => j.status === "completed").length;
        const f = prev.filter((j) => j.status === "failed").length;
        const s = prev.filter((j) => j.status === "skipped").length;
        setCompleted(c);
        setFailed(f);
        setSkipped(s);
        return prev;
      });
      if (!sawBatchComplete) {
        setBatchElapsedMs((prev) => prev || Date.now() - startedAt);
      }
      setRunning(false);
      abortRef.current = null;
    }
  }

  function handleStop() {
    stopRef.current = true;
    setStopRequested(true);
    abortRef.current?.abort();
  }

  async function handleDownloadZip() {
    await downloadZip();
  }

  async function openFolder(folderPath: string) {
    try {
      const res = await fetch("/api/automation/open-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderPath }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Could not open folder");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open folder");
    }
  }

  const activeJob = activeIndex !== null ? jobs.find((j) => j.index === activeIndex) : null;
  const activeJobPct = activeJob ? Math.round(jobFraction(activeJob) * 100) : 0;
  const previewContent =
    previewTab === "raw"
      ? activeJob?.rawJd
      : previewTab === "extracted"
        ? activeJob?.extractedJd
        : activeJob?.updatedResume;
  const resumeFileBase = sanitizeResumeDisplayName(resumeNamePrefix);
  const numberedUrls = urlsText.split(/\n/).filter((l) => l.trim());
  const isProductionHost =
    typeof window !== "undefined" &&
    window.location.hostname !== "localhost" &&
    window.location.hostname !== "127.0.0.1";

  return (
    <div className="art-dashboard">
      <header className="art-topbar">
        <div>
          <h1 className="art-page-title">Dashboard</h1>
          <p className="art-page-sub">Paste job URLs → each result saves to its own folder</p>
        </div>
      </header>

      {isProductionHost && (
        <div className="art-banner art-banner--warn" role="status">
          <strong>Vercel hard-stops batches after ~5 minutes.</strong> Only a few
          jobs can finish per run (no Playwright, concurrency forced to 1). Jobs
          that cannot start are marked failed instead of spinning forever. For
          10+ URLs use <code>npm run dev</code> on localhost, or run small batches
          of 2–3 URLs on Vercel. PDF still requires local Word/LibreOffice.
        </div>
      )}

      <div className="art-dashboard-grid">
        <div className="art-main-col">
          <section className="art-card">
            <h2 className="art-card-title">1. Paste Job URLs (one per line)</h2>
            <div className="art-url-editor">
              <div className="art-url-gutter">
                {numberedUrls.map((_, i) => (
                  <span key={i}>{i + 1}</span>
                ))}
                {numberedUrls.length === 0 && <span>1</span>}
              </div>
              <textarea
                className="art-url-input"
                value={urlsText}
                onChange={(e) => setUrlsText(e.target.value)}
                placeholder={"https://company1.com/job/12345\nhttps://company2.com/job/67890"}
                disabled={running}
                spellCheck={false}
              />
            </div>
            <p className="art-url-count">Total URLs: {urlCount}</p>

            <div className="art-field art-field--inline">
              <label className="art-label" htmlFor="resume-name-prefix">
                Resume name prefix (files saved as <code>{resumeFileBase}.docx</code>)
              </label>
              <input
                id="resume-name-prefix"
                className="art-input"
                value={resumeNamePrefix}
                onChange={(e) => setResumeNamePrefix(e.target.value)}
                placeholder="e.g. darius"
                disabled={running}
                spellCheck={false}
              />
            </div>

            <div className="art-field art-field--inline">
              <label className="art-label" htmlFor="concurrency">
                Parallel jobs (same OpenRouter key) — scrape/extract/tailor run together; PDF stays one-at-a-time
              </label>
              <input
                id="concurrency"
                className="art-input"
                type="number"
                min={1}
                max={10}
                value={concurrency}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (!Number.isFinite(n)) return;
                  setConcurrency(Math.max(1, Math.min(10, Math.floor(n))));
                }}
                disabled={running}
              />
            </div>

            <div className="art-actions">
              <button
                type="button"
                className="art-btn art-btn--start"
                onClick={handleStart}
                disabled={running || !settings}
              >
                ▶ Start Generate
              </button>
              <button type="button" className="art-btn art-btn--ghost" disabled>
                ⏸ Pause
              </button>
              <button
                type="button"
                className="art-btn art-btn--ghost"
                onClick={handleStop}
                disabled={!running}
              >
                ⏹ Stop
              </button>
              <button
                type="button"
                className="art-btn art-btn--ghost"
                onClick={handleDownloadZip}
                disabled={running || completed === 0}
              >
                ⬇ Download ZIP
              </button>
            </div>
            {error && <p className="art-error">{error}</p>}
            {stopRequested && !running && (
              <p className="art-hint">Stopped — partial results saved in output folders.</p>
            )}
          </section>

          {(running || jobs.length > 0) && (
            <>
              <section className="art-card art-timing-banner">
                <div className="art-timing-banner-item">
                  <span className="art-timing-banner-label">Batch time</span>
                  <span className="art-timing-banner-value">
                    {formatElapsed(liveBatchElapsed)}
                  </span>
                </div>
                <div className="art-timing-banner-item">
                  <span className="art-timing-banner-label">Current job</span>
                  <span className="art-timing-banner-value">
                    {activeJob
                      ? formatElapsed(
                          activeJob.status === "processing" && activeJob.startedAt
                            ? nowTick - activeJob.startedAt
                            : activeJob.elapsedMs
                        )
                      : "—"}
                  </span>
                </div>
                <div className="art-timing-banner-item art-timing-banner-item--muted">
                  <span className="art-timing-banner-label">Progress</span>
                  <span className="art-timing-banner-value art-timing-banner-value--sm">
                    {progressPct}% · {completed}/{total} done
                  </span>
                </div>
              </section>

              <section className="art-card art-stats-row">
                <div className="art-stat-card">
                  <span className="art-stat-label">Total URLs</span>
                  <span className="art-stat-value">{total}</span>
                </div>
                <div className="art-stat-card art-stat-card--ok">
                  <span className="art-stat-label">Completed</span>
                  <span className="art-stat-value">✓ {completed}</span>
                </div>
                <div className="art-stat-card art-stat-card--proc">
                  <span className="art-stat-label">Processing</span>
                  <span className="art-stat-value">↻ {processing}</span>
                </div>
                <div className="art-stat-card art-stat-card--fail">
                  <span className="art-stat-label">Failed</span>
                  <span className="art-stat-value">✕ {failed}</span>
                </div>
                <div className="art-stat-card">
                  <span className="art-stat-label">Skipped</span>
                  <span className="art-stat-value">{skipped}</span>
                </div>
                <div className="art-stat-card">
                  <span className="art-stat-label">Remaining</span>
                  <span className="art-stat-value">{remaining}</span>
                </div>
                <div className="art-stat-card art-stat-card--time">
                  <span className="art-stat-label">Total time</span>
                  <span className="art-stat-value">{formatElapsed(liveBatchElapsed)}</span>
                </div>
              </section>

              <div className="art-progress-wrap">
                <div className="art-progress-bar">
                  <div className="art-progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
                <span className="art-progress-text">
                  {progressPct}% overall ({completed} / {total} done) · {formatElapsed(liveBatchElapsed)}
                </span>
              </div>

              <section className="art-card art-preview-card">
                <div className="art-preview-head">
                  <h2 className="art-card-title">Job Content Preview</h2>
                  {activeJob && (
                    <span className="art-muted">
                      Job #{String(activeJob.index).padStart(2, "0")}
                    </span>
                  )}
                </div>
                <div className="art-preview-tabs">
                  <button
                    type="button"
                    className={`art-preview-tab${previewTab === "raw" ? " art-preview-tab--active" : ""}`}
                    onClick={() => setPreviewTab("raw")}
                  >
                    Raw JD
                    {activeJob?.rawJd ? " ✓" : ""}
                  </button>
                  <button
                    type="button"
                    className={`art-preview-tab${previewTab === "extracted" ? " art-preview-tab--active" : ""}`}
                    onClick={() => setPreviewTab("extracted")}
                  >
                    Extracted JD
                    {activeJob?.extractedJd ? " ✓" : ""}
                  </button>
                  <button
                    type="button"
                    className={`art-preview-tab${previewTab === "resume" ? " art-preview-tab--active" : ""}`}
                    onClick={() => setPreviewTab("resume")}
                  >
                    Updated Resume
                    {activeJob?.updatedResume ? " ✓" : ""}
                  </button>
                </div>
                <div className="art-preview-body">
                  {previewContent ? (
                    <pre className="art-preview-text">{previewContent}</pre>
                  ) : (
                    <p className="art-muted art-preview-empty">
                      {activeJob
                        ? previewTab === "raw"
                          ? "Waiting for scraped job page text…"
                          : previewTab === "extracted"
                            ? "Waiting for OpenRouter extraction…"
                            : "Waiting for tailored resume…"
                        : "Select a job from the table to preview content."}
                    </p>
                  )}
                </div>
              </section>

              <section className="art-card art-table-card">
                <h2 className="art-card-title">All Jobs</h2>
                <div className="art-table-wrap">
                  <table className="art-table">
                    <thead>
                      <tr>
                        <th>#</th>
                        <th>Company</th>
                        <th>Position</th>
                        <th>Type / Slot</th>
                        <th>Status</th>
                        <th>Time</th>
                        <th>Updated</th>
                        <th></th>
                      </tr>
                    </thead>
                    <tbody>
                      {jobs.map((job) => (
                        <tr
                          key={job.index}
                          className={activeIndex === job.index ? "art-row--active" : ""}
                          onClick={() => setActiveIndex(job.index)}
                        >
                          <td>{String(job.index).padStart(2, "0")}</td>
                          <td>
                            <span className="art-company">
                              <span
                                className="art-avatar"
                                style={{
                                  background:
                                    SLOT_COLORS[(job.resumeType - 1 + 4) % 4] ?? "#555",
                                }}
                              >
                                {companyInitials(job.company)}
                              </span>
                              {job.company}
                            </span>
                          </td>
                          <td>{job.position}</td>
                          <td>
                            {job.resumeType > 0 && (
                              <span
                                className="art-slot-badge"
                                style={{
                                  borderColor:
                                    SLOT_COLORS[(job.resumeType - 1) % 4] ?? "#888",
                                  color: SLOT_COLORS[(job.resumeType - 1) % 4] ?? "#ccc",
                                }}
                              >
                                {job.slotType}
                              </span>
                            )}
                          </td>
                          <td>
                            <span
                              className={`art-status art-status--${job.status}`}
                              title={job.error ?? undefined}
                            >
                              {job.statusLabel}
                            </span>
                            {job.error &&
                              (job.status === "failed" || job.status === "skipped") && (
                                <span className="art-row-error" title={job.error}>
                                  {job.error}
                                </span>
                              )}
                          </td>
                          <td className="art-time-cell">
                            {formatElapsed(
                              job.status === "processing" && job.startedAt
                                ? nowTick - job.startedAt
                                : job.elapsedMs
                            )}
                          </td>
                          <td className="art-muted">{formatAgo(job.updatedAt)}</td>
                          <td>
                            {job.folderPath && (
                              <button
                                type="button"
                                className="art-icon-btn"
                                title="Open folder"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openFolder(job.folderPath!);
                                }}
                              >
                                📁
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>

        <aside className="art-side-col">
          <section className="art-card art-current">
            <h2 className="art-card-title">Current Job</h2>
            {activeJob ? (
              <>
                <div className="art-current-head">
                  <span className="art-current-num">#{String(activeJob.index).padStart(2, "0")}</span>
                  <div>
                    <div className="art-current-co">{activeJob.company}</div>
                    <div className="art-current-pos">{activeJob.position}</div>
                  </div>
                </div>
                {activeJob.slotType !== "—" && (
                  <p className="art-current-slot">
                    Resume Slot: <strong>{activeJob.slotType}</strong>
                  </p>
                )}
                <p className="art-current-url" title={activeJob.url}>
                  {activeJob.url}
                </p>
                <div className="art-jobprogress">
                  <div className="art-jobprogress-bar">
                    <div
                      className={`art-jobprogress-fill art-jobprogress-fill--${activeJob.status}`}
                      style={{ width: `${activeJobPct}%` }}
                    />
                  </div>
                  <span className="art-jobprogress-text">{activeJobPct}%</span>
                </div>
                <p className="art-job-time-line">
                  <span>
                    Job{" "}
                    <strong>
                      {formatElapsed(
                        activeJob.status === "processing" && activeJob.startedAt
                          ? nowTick - activeJob.startedAt
                          : activeJob.elapsedMs
                      )}
                    </strong>
                  </span>
                  <span>
                    Batch <strong>{formatElapsed(liveBatchElapsed)}</strong>
                  </span>
                </p>
              </>
            ) : (
              <p className="art-muted">No job selected. Start generation to see progress.</p>
            )}
          </section>

          <section className="art-card">
            <h2 className="art-card-title">Process Steps</h2>
            <ul className="art-stepper">
              {PIPELINE_STEPS.map((step) => {
                const done = Boolean(activeJob?.steps[step.id]);
                const active =
                  running &&
                  activeJob?.status === "processing" &&
                  !done &&
                  PIPELINE_STEPS.findIndex((s) => s.id === step.id) ===
                    PIPELINE_STEPS.findIndex((s) => !activeJob?.steps[s.id]);
                const storedMs = activeJob?.stepTimings[step.id];
                const liveMs =
                  active && activeJob?.stepStartedAt
                    ? nowTick - activeJob.stepStartedAt
                    : null;
                const timeLabel =
                  storedMs != null
                    ? formatElapsed(storedMs)
                    : liveMs != null
                      ? formatElapsed(liveMs)
                      : null;
                return (
                  <li
                    key={step.id}
                    className={`art-stepper-item${done ? " art-stepper-item--done" : ""}${active ? " art-stepper-item--active" : ""}`}
                  >
                    <span className="art-stepper-dot">{done ? "✓" : active ? "↻" : "○"}</span>
                    <span className="art-stepper-label">{step.label}</span>
                    <span className="art-stepper-time">{timeLabel ?? "—"}</span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="art-card art-output-preview">
            <h2 className="art-card-title">Output Folder Preview</h2>
            {activeJob?.folderName ? (
              <>
                <div className="art-folder-name">📁 {activeJob.folderName}</div>
                <ul className="art-file-list">
                  <li>📄 {resumeFileBase}.docx</li>
                  <li>
                    {activeJob.hasPdf ? "📄" : "⚠"} {resumeFileBase}.pdf
                    {!activeJob.hasPdf && " (needs LibreOffice)"}
                  </li>
                  <li>🔗 job_url.txt</li>
                  <li>📝 raw_jd.txt</li>
                  <li>📝 extracted_jd.txt</li>
                  <li>📝 updated_resume.md</li>
                </ul>
                {activeJob.folderPath && (
                  <button
                    type="button"
                    className="art-btn art-btn--open"
                    onClick={() => openFolder(activeJob.folderPath!)}
                  >
                    Open Folder
                  </button>
                )}
              </>
            ) : (
              <p className="art-muted">
                Each completed job creates{" "}
                <code>NN_Company_Position/</code> with Word, PDF, URL, and extracted JD files.
              </p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
