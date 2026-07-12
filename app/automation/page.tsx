"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { parseJobUrls } from "@/lib/automation/parse-urls";
import type {
  AutomationProgressEvent,
  JobGenerateReadyEvent,
  JobNeedRegenerateEvent,
} from "@/lib/automation/types";
import {
  loadSettings,
  mergeServerConfig,
  saveSettings,
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
  const [serverConvertApiConfigured, setServerConvertApiConfigured] = useState(false);
  const [running, setRunning] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [completed, setCompleted] = useState(0);
  const [failed, setFailed] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [copiedFailedUrls, setCopiedFailedUrls] = useState(false);
  const [batchFolderPaths, setBatchFolderPaths] = useState<string[]>([]);
  const [batchStartedAt, setBatchStartedAt] = useState<number | null>(null);
  const [batchElapsedMs, setBatchElapsedMs] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const problemJobs = jobs.filter(
    (j) => j.status === "failed" || j.status === "skipped"
  );

  const stopRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const jobsRef = useRef<JobRow[]>([]);
  /** Full per-job files for browser ZIP fallback (Vercel). */
  const batchFilesRef = useRef<
    {
      folderName: string;
      files: { fileName: string; base64: string }[];
    }[]
  >([]);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  const hasActiveJobs = jobs.some(
    (j) => j.status === "processing" || j.status === "waiting"
  );
  const timerActive = running || hasActiveJobs;

  useEffect(() => {
    if (!batchStartedAt) return;
    if (!timerActive && batchElapsedMs > 0) return;
    const id = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [timerActive, batchStartedAt, batchElapsedMs]);

  const liveBatchElapsed = !batchStartedAt
    ? 0
    : !timerActive && batchElapsedMs > 0
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
      .then((server) => {
        setServerConvertApiConfigured(Boolean(server.convertApiConfigured));
        setSettings(mergeServerConfig(saved, server));
      })
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
    setJobs((prev) => {
      const next = prev.map((j) => {
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
      });
      jobsRef.current = next;
      return next;
    });
  }, []);

  const handleEvent = useCallback(
    (event: AutomationProgressEvent) => {
      if (event.type === "batch_start") {
        setBatchStartedAt(Date.now());
        setBatchElapsedMs(0);
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
      if (event.type === "job_need_regenerate") {
        updateJob(event.index, {
          status: "processing",
          statusLabel: `Resume regenerating (${event.nextAttempt}/${event.maxAttempts})…`,
          error: event.error,
          elapsedMs: event.elapsedMs,
        });
        return;
      }
      if (event.type === "job_generate_ready") {
        updateJob(event.index, {
          status: "processing",
          statusLabel: `Resume generating (attempt ${event.nextAttempt}/${event.maxAttempts})…`,
          company: event.companyName,
          position: event.positionName,
          folderName: event.folderName,
          resumeType: event.resumeType,
        });
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

  /** CRC-32 (ZIP / IEEE) — required; a zero CRC makes Windows report "Checksum error". */
  function crc32Zip(data: Uint8Array): number {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  /** ASCII-safe ZIP entry path (no Unicode dashes/punctuation that break extractors). */
  function zipSafePath(folderName: string, fileName: string): string {
    const folder = folderName
      .normalize("NFKD")
      .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "_")
      .replace(/[^\x20-\x7E]/g, "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/[,\s]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "") || "job";
    const file = fileName.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "_") || "file";
    return `${folder}/${file}`;
  }

  /** Store-only ZIP with correct CRC-32 (browser fallback when server /tmp is empty). */
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
      new DataView(b.buffer).setUint16(0, n & 0xffff, true);
      return b;
    };
    const u32 = (n: number) => {
      const b = new Uint8Array(4);
      new DataView(b.buffer).setUint32(0, n >>> 0, true);
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

      const crc = crc32Zip(data);
      // Bit 11 = UTF-8 filenames (safe even when path is ASCII-only)
      const gpFlag = 0x0800;

      const local = concat([
        u32(0x04034b50),
        u16(20),
        u16(gpFlag),
        u16(0), // store (no compression)
        u16(0),
        u16(0),
        u32(crc),
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
        u16(gpFlag),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
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
        if (!file.base64) continue;
        addFile(zipSafePath(job.folderName, file.fileName), file.base64);
      }
    }

    if (fileCount === 0) {
      throw new Error("No files to zip");
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

  /**
   * For every DOCX in the batch that is missing a PDF, convert DOCX→PDF via API
   * (no OpenRouter). Sequential to avoid ConvertAPI rate limits.
   */
  async function ensurePdfsForBatchFiles(): Promise<{
    failures: number;
    lastError?: string;
  }> {
    const jobs = batchFilesRef.current;
    const convertApiSecret = settings?.convertApiSecret?.trim() || undefined;
    let backfillFailures = 0;
    let lastError: string | undefined;

    for (const job of jobs) {
      const docx = job.files.find((f) => /\.docx$/i.test(f.fileName));
      const hasPdf = job.files.some((f) => /\.pdf$/i.test(f.fileName));
      if (!docx?.base64 || hasPdf) continue;

      try {
        const res = await fetch("/api/automation/convert-pdf", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            docxBase64: docx.base64,
            fileName: docx.fileName,
            convertApiSecret,
          }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          error?: string;
          pdfBase64?: string;
          pdfFileName?: string;
        };
        if (!res.ok) {
          lastError = data.error ?? `HTTP ${res.status}`;
          console.warn(
            `[pdf] Backfill failed for ${job.folderName}:`,
            lastError
          );
          backfillFailures++;
          continue;
        }
        if (!data.pdfBase64) {
          lastError = "Convert API returned no PDF data";
          backfillFailures++;
          continue;
        }
        job.files.push({
          fileName:
            data.pdfFileName || docx.fileName.replace(/\.docx$/i, ".pdf"),
          base64: data.pdfBase64,
        });
        setJobs((prev) =>
          prev.map((row) =>
            row.folderName === job.folderName ? { ...row, hasPdf: true } : row
          )
        );
      } catch (err) {
        backfillFailures++;
        lastError = err instanceof Error ? err.message : String(err);
        console.warn(`[pdf] Backfill error for ${job.folderName}:`, lastError);
      }
    }

    return { failures: backfillFailures, lastError };
  }

  async function downloadZip(prefix?: string, folderPaths?: string[], inlineZip?: { base64: string; fileName: string }) {
    const name = (prefix ?? resumeNamePrefix).trim() || "resume";
    const zipName = `${name}_resumes.zip`;

    if (inlineZip?.base64) {
      downloadBase64Zip(inlineZip.base64, inlineZip.fileName || zipName);
      return;
    }

    // Fill any missing PDFs from DOCX before zipping.
    if (batchFilesRef.current.length > 0) {
      setError(null);
      const missing = batchFilesRef.current.filter(
        (j) =>
          j.files.some((f) => /\.docx$/i.test(f.fileName)) &&
          !j.files.some((f) => /\.pdf$/i.test(f.fileName))
      ).length;
      if (missing > 0) {
        setError(`Converting ${missing} DOCX → PDF via ConvertAPI…`);
      }
      const { failures, lastError } = await ensurePdfsForBatchFiles();
      const stillMissing = batchFilesRef.current.filter(
        (j) =>
          j.files.some((f) => /\.docx$/i.test(f.fileName)) &&
          !j.files.some((f) => /\.pdf$/i.test(f.fileName))
      ).length;
      try {
        triggerBlobDownload(zipFilesFromBatch(batchFilesRef.current), zipName);
        if (stillMissing > 0 || failures > 0) {
          setError(
            `ZIP downloaded, but ${stillMissing || failures} PDF(s) missing. ${
              lastError ||
              "Check your ConvertAPI Production token on the Dashboard."
            }`
          );
        } else {
          setError(null);
        }
        return;
      } catch (err) {
        console.warn("[zip] Client ZIP failed, trying server:", err);
      }
    }

    const paths = folderPaths ?? batchFolderPaths;
    if (settings && paths.length > 0) {
      try {
        const res = await fetch("/api/automation/download-zip", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            outputDir: settings.outputDir,
            zipFileName: zipName,
            folderPaths: paths,
            ensurePdf: true,
          }),
        });
        if (res.ok) {
          const blob = await res.blob();
          triggerBlobDownload(blob, zipName);
          return;
        }
        const data = await res.json().catch(() => ({}));
        setError(
          data.error ??
            "ZIP failed — on Vercel the temp folder is cleared after the run; re-run and use the automatic download."
        );
        return;
      } catch (err) {
        setError(err instanceof Error ? err.message : "Download failed");
        return;
      }
    }

    setError("No completed resumes from this batch to download.");
  }

  function updateConvertApiSecret(value: string) {
    setSettings((prev) => {
      if (!prev) return prev;
      const next = { ...prev, convertApiSecret: value };
      saveSettings(next);
      return next;
    });
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
    const onVercelHost =
      typeof window !== "undefined" &&
      window.location.hostname !== "localhost" &&
      window.location.hostname !== "127.0.0.1";
    const convertApiReady =
      settings.convertApiSecret.trim().length > 4 || serverConvertApiConfigured;
    if (onVercelHost && !convertApiReady) {
      setError(
        "Add your ConvertAPI token below (or set CONVERTAPI_SECRET on Vercel) for Word-matching PDFs."
      );
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
    const startedAt = Date.now();
    setBatchStartedAt(startedAt);
    setBatchElapsedMs(0);
    setNowTick(startedAt);
    setJobs(urls.map((u, i) => createJobRow(i + 1, u)));

    const controller = new AbortController();
    abortRef.current = controller;
    const folderPaths: string[] = [];
    const poolSize = Math.max(1, Math.min(10, concurrency));

    const readJobStream = async (
      res: Response
    ): Promise<{
      pendingRegen: JobNeedRegenerateEvent | null;
      generateReady: JobGenerateReadyEvent | null;
      completedOrFailed: boolean;
    }> => {
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response stream");
      const decoder = new TextDecoder();
      let buffer = "";
      let pendingRegen: JobNeedRegenerateEvent | null = null;
      let generateReady: JobGenerateReadyEvent | null = null;
      let completedOrFailed = false;

      const consumeLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) return;
        const json = trimmed.slice(5).trim();
        if (!json) return;
        const event = JSON.parse(json) as
          | AutomationProgressEvent
          | { type: "error"; message?: string };
        if (event.type === "error") {
          throw new Error(event.message ?? "Job failed");
        }
        if (event.type === "heartbeat") {
          setNowTick(event.at || Date.now());
          return;
        }
        if (event.type === "job_generate_ready") {
          generateReady = event;
          pendingRegen = null;
          handleEvent(event);
          return;
        }
        if (event.type === "job_need_regenerate") {
          pendingRegen = event;
          generateReady = null;
          handleEvent(event);
          return;
        }
        if (event.type === "job_complete") {
          pendingRegen = null;
          generateReady = null;
          completedOrFailed = true;
          folderPaths.push(event.folderPath);
          handleEvent(event);
          return;
        }
        if (event.type === "job_failed" || event.type === "job_skipped") {
          pendingRegen = null;
          generateReady = null;
          completedOrFailed = true;
          handleEvent(event);
          return;
        }
        handleEvent(event);
      };

      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: !done });
          const lines = buffer.split("\n");
          buffer = done ? "" : (lines.pop() ?? "");
          for (const line of lines) consumeLine(line);
          if (done && buffer.trim()) {
            consumeLine(buffer);
            buffer = "";
          }
        }
        if (done || stopRef.current) break;
      }

      return { pendingRegen, generateReady, completedOrFailed };
    };

    const runGenerateAttempt = async (
      regen: JobNeedRegenerateEvent | JobGenerateReadyEvent
    ) => {
      const res = await fetch("/api/automation/generate-attempt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: regen.url,
          index: regen.index,
          total: urls.length,
          nextAttempt: regen.nextAttempt,
          maxAttempts: regen.maxAttempts,
          tailoringPrompt: regen.tailoringPrompt,
          baseResume: regen.baseResume,
          slotIndex: regen.slotIndex,
          tailorJd: regen.tailorJd,
          rawJd: regen.rawJd,
          extractedJd: regen.extractedJd,
          companyName: regen.companyName,
          positionName: regen.positionName,
          resumeType: regen.resumeType,
          folderName: regen.folderName,
          outputDir: regen.outputDir,
          resumeNamePrefix: regen.resumeNamePrefix,
          apiKey: regen.apiKey,
          convertApiSecret:
            settings.convertApiSecret.trim() || regen.convertApiSecret || undefined,
          previousError: "error" in regen ? regen.error : undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        handleEvent({
          type: "job_failed",
          index: regen.index,
          url: regen.url,
          error: data.error ?? `Regenerate failed (${res.status})`,
        });
        return {
          pendingRegen: null as JobNeedRegenerateEvent | null,
          generateReady: null as JobGenerateReadyEvent | null,
          completedOrFailed: true,
        };
      }
      return readJobStream(res);
    };

    const runOneJob = async (url: string, index: number) => {
      if (stopRef.current) return;
      const res = await fetch("/api/automation/run-job", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url,
          index,
          total: urls.length,
          extractionPrompt: settings.extractionPrompt,
          tailoringPrompt: settings.tailoringPrompt,
          baseResumes: settings.baseResumes,
          outputDir: settings.outputDir,
          resumeNamePrefix: resumeNamePrefix.trim(),
          apiKey: settings.apiKey.trim() || undefined,
          convertApiSecret: settings.convertApiSecret.trim() || undefined,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const message = data.error ?? `Request failed (${res.status})`;
        handleEvent({
          type: "job_failed",
          index,
          url,
          error: message,
        });
        return;
      }

      let result = await readJobStream(res);

      // Keep going until this job is terminal. If SSE drops mid-generate, continue
      // via generate-attempt using the saved generateReady / need_regenerate context.
      let continuePasses = 0;
      while (!stopRef.current && !result.completedOrFailed && continuePasses < 3) {
        const cont =
          result.pendingRegen ??
          (result.generateReady
            ? {
                ...result.generateReady,
                type: "job_need_regenerate" as const,
                error:
                  result.generateReady.error ??
                  "Connection closed during resume generate — continuing…",
              }
            : null);
        if (!cont) break;
        continuePasses += 1;

        updateJob(cont.index, {
          status: "processing",
          statusLabel: `Resume generating attempt ${cont.nextAttempt}/${cont.maxAttempts}…`,
        });
        result = await runGenerateAttempt(cont);
      }

      if (!result.completedOrFailed && !stopRef.current) {
        handleEvent({
          type: "job_failed",
          index,
          url,
          error: "Job ended before resume finished (connection closed during generate).",
        });
      }
    };

    try {
      handleEvent({ type: "batch_start", total: urls.length, startedAt });

      await fetch("/api/automation/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outputDir: settings.outputDir }),
        signal: controller.signal,
      }).catch(() => null);

      let next = 0;
      const workers = Array.from({ length: Math.min(poolSize, urls.length) }, async () => {
        while (true) {
          if (stopRef.current) return;
          const i = next++;
          if (i >= urls.length) return;
          try {
            await runOneJob(urls[i], i + 1);
          } catch (err) {
            if (err instanceof Error && err.name === "AbortError") return;
            handleEvent({
              type: "job_failed",
              index: i + 1,
              url: urls[i],
              error: err instanceof Error ? err.message : "Job failed",
            });
          }
        }
      });

      await Promise.all(workers);

      // Yield so React state from the last job_failed/complete is reflected in jobsRef.
      await new Promise((r) => setTimeout(r, 0));

      for (const j of jobsRef.current) {
        if (j.status === "processing" || j.status === "waiting") {
          handleEvent({
            type: "job_failed",
            index: j.index,
            url: j.url,
            error: "Batch finished before this job completed.",
          });
        }
      }

      await new Promise((r) => setTimeout(r, 0));

      const elapsed = Date.now() - startedAt;
      setBatchElapsedMs(elapsed);
      setBatchFolderPaths([...folderPaths]);

      setJobs((prev) => {
        const c = prev.filter((j) => j.status === "completed").length;
        const f = prev.filter((j) => j.status === "failed").length;
        const s = prev.filter((j) => j.status === "skipped").length;
        setCompleted(c);
        setFailed(f);
        setSkipped(s);
        return prev;
      });

      const stillActive = jobsRef.current.some(
        (j) => j.status === "processing" || j.status === "waiting"
      );
      if (
        !stillActive &&
        (folderPaths.length > 0 || batchFilesRef.current.length > 0) &&
        !stopRef.current
      ) {
        await downloadZip(resumeNamePrefix.trim(), folderPaths);
      }
    } catch (err) {
      if (err instanceof Error && err.name !== "AbortError") {
        setError(err.message);
      }
    } finally {
      setBatchElapsedMs((prev) => prev || Date.now() - startedAt);
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

  async function copyFailedUrls() {
    const lines = problemJobs.map((j) => j.url).filter(Boolean);
    if (!lines.length) return;
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopiedFailedUrls(true);
      window.setTimeout(() => setCopiedFailedUrls(false), 2000);
    } catch {
      setError("Could not copy URLs to clipboard.");
    }
  }

  async function copyFailedUrlsWithErrors() {
    const lines = problemJobs.map((j) => {
      const reason = (j.error || j.statusLabel || j.status).replace(/\s+/g, " ").trim();
      return `${j.url}\n  → ${reason}`;
    });
    if (!lines.length) return;
    try {
      await navigator.clipboard.writeText(lines.join("\n\n"));
      setCopiedFailedUrls(true);
      window.setTimeout(() => setCopiedFailedUrls(false), 2000);
    } catch {
      setError("Could not copy URLs to clipboard.");
    }
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
  const convertApiConnected =
    Boolean(settings?.convertApiSecret?.trim() && settings.convertApiSecret.trim().length > 4) ||
    serverConvertApiConfigured;

  return (
    <div className="art-dashboard">
      <header className="art-topbar">
        <div>
          <h1 className="art-page-title">Dashboard</h1>
          <p className="art-page-sub">Paste job URLs → each result saves to its own folder</p>
        </div>
      </header>

      {isProductionHost && !convertApiConnected && (
        <div className="art-banner art-banner--warn" role="status">
          <strong>ConvertAPI required for PDFs:</strong> Paste your token below (from{" "}
          <a href="https://www.convertapi.com/a/auth" target="_blank" rel="noreferrer">
            convertapi.com/a/auth
          </a>
          ) or set <code>CONVERTAPI_SECRET</code> in Vercel Environment Variables. Without it,
          DOCX still works; PDF layout will not match Word.
        </div>
      )}
      {convertApiConnected && (
        <div className="art-banner art-banner--ok" role="status">
          <strong>ConvertAPI connected:</strong> DOCX→PDF on this deploy uses ConvertAPI for
          Word-matching output.
          {serverConvertApiConfigured && !settings?.convertApiSecret?.trim()
            ? " (using Vercel env)"
            : null}
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

            <div className="art-field">
              <label className="art-label" htmlFor="convert-api-dashboard">
                ConvertAPI Token
                {convertApiConnected && <span className="art-connected">Connected</span>}
              </label>
              <input
                id="convert-api-dashboard"
                type="password"
                className="art-input"
                value={settings?.convertApiSecret ?? ""}
                onChange={(e) => updateConvertApiSecret(e.target.value)}
                placeholder="Paste token from convertapi.com/a/auth"
                disabled={running || !settings}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="art-hint">
                Used for Word-matching DOCX→PDF on Vercel. Get a token at{" "}
                <a
                  href="https://www.convertapi.com/a/auth"
                  target="_blank"
                  rel="noreferrer"
                >
                  convertapi.com/a/auth
                </a>
                . Same field is saved under Settings. Or set{" "}
                <code>CONVERTAPI_SECRET</code> in Vercel env (no need to paste here).
              </p>
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

              {!running && problemJobs.length > 0 && (
                <section className="art-card art-failed-urls" aria-live="polite">
                  <div className="art-failed-urls-head">
                    <h2 className="art-card-title">
                      Failed / skipped URLs ({problemJobs.length})
                    </h2>
                    <div className="art-failed-urls-actions">
                      <button
                        type="button"
                        className="art-btn art-btn--ghost art-btn--sm"
                        onClick={copyFailedUrls}
                      >
                        {copiedFailedUrls ? "Copied ✓" : "Copy all URLs"}
                      </button>
                      <button
                        type="button"
                        className="art-btn art-btn--ghost art-btn--sm"
                        onClick={copyFailedUrlsWithErrors}
                      >
                        Copy URLs + errors
                      </button>
                    </div>
                  </div>
                  <p className="art-hint">
                    Paste these back into the URL box to retry, or open them in a browser and paste the JD manually.
                  </p>
                  <ul className="art-failed-urls-list">
                    {problemJobs.map((j) => (
                      <li key={`${j.index}-${j.url}`} className="art-failed-urls-item">
                        <div className="art-failed-urls-meta">
                          <span className="art-failed-urls-idx">
                            #{String(j.index).padStart(2, "0")}
                          </span>
                          <span
                            className={`art-status art-status--${j.status}`}
                          >
                            {j.status}
                          </span>
                        </div>
                        <a
                          className="art-failed-urls-link"
                          href={j.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {j.url}
                        </a>
                        {j.error && (
                          <p className="art-failed-urls-error" title={j.error}>
                            {j.error}
                          </p>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

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
                    {!activeJob.hasPdf && " (PDF converted from DOCX before ZIP)"}
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
