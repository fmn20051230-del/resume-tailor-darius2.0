import fs from "fs";
import path from "path";
import {
  DEFAULT_EXTRACTION_PROMPT,
  DEFAULT_TAILORING_PROMPT,
} from "@/lib/default-prompts";

const CONFIG_DIR = path.join(process.cwd(), "config");
const EXTRACTION_PROMPT_PATH = path.join(CONFIG_DIR, "extraction-prompt.txt");
const TAILORING_PROMPT_PATH = path.join(CONFIG_DIR, "tailoring-prompt.txt");
const BASE_RESUMES_DIR = path.join(CONFIG_DIR, "base-resumes");
const DEFAULT_BASE_RESUME_PATH = path.join(process.cwd(), "resume_base.md");

const SLOT_FILES = [
  "slot-0-ai-engineer.md",
  "slot-1-data-engineer.md",
  "slot-2-data-scientist.md",
  "slot-3-data-analyst.md",
] as const;

function readFileIfExists(filePath: string): string {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, "utf8");
    }
  } catch {
    // ignore
  }
  return "";
}

function stripCommentLines(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n")
    .trim();
}

export function loadExtractionPrompt(): string {
  const fromFile = stripCommentLines(readFileIfExists(EXTRACTION_PROMPT_PATH));
  if (fromFile && !fromFile.includes("[Paste your extraction prompt here]")) {
    return fromFile;
  }
  return (
    process.env.EXTRACTION_PROMPT?.trim() || DEFAULT_EXTRACTION_PROMPT
  );
}

export function loadTailoringPrompt(): string {
  const fromFile = stripCommentLines(readFileIfExists(TAILORING_PROMPT_PATH));
  if (fromFile && !fromFile.includes("[Paste your tailoring prompt here]")) {
    return fromFile;
  }
  return (
    process.env.TAILORING_PROMPT?.trim() ||
    process.env.NEXT_PUBLIC_DEFAULT_PROMPT?.trim() ||
    DEFAULT_TAILORING_PROMPT
  );
}

export function loadBaseResumes(): [string, string, string, string] {
  const fallback = readFileIfExists(DEFAULT_BASE_RESUME_PATH);

  return SLOT_FILES.map((file) => {
    const slotPath = path.join(BASE_RESUMES_DIR, file);
    const content = readFileIfExists(slotPath);
    return content.trim() ? content : fallback;
  }) as [string, string, string, string];
}

export function getDefaultOutputDir(): string {
  return process.env.AUTOMATION_OUTPUT_DIR?.trim() || "output";
}
