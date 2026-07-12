import fs from "fs";
import os from "os";
import path from "path";
import AdmZip from "adm-zip";

const INVALID_SEGMENT_RE = /[\\/:*?"<>|\x00-\x1f#]/g;

function isServerless(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
}

export function sanitizeFolderSegment(text: string, maxLength = 80): string {
  return text
    .normalize("NFKD")
    // Em/en dashes and similar → underscore (ZIP/Windows path safe)
    .replace(/[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g, "_")
    .replace(/[^\x20-\x7E]/g, "") // strip remaining non-ASCII
    .replace(INVALID_SEGMENT_RE, " ")
    .replace(/[,\s]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, maxLength) || "Unknown";
}

export function sanitizeResumeNamePrefix(text: string): string {
  const cleaned = text
    .trim()
    .replace(INVALID_SEGMENT_RE, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 60);
  return cleaned || "resume";
}

export function buildFolderName(
  urlIndex: number,
  companyName: string,
  positionName: string
): string {
  const num = String(urlIndex).padStart(2, "0");
  const company = sanitizeFolderSegment(companyName);
  const position = sanitizeFolderSegment(positionName);
  return `${num}_${company}_${position}`;
}

/**
 * Local: project `output/` (or absolute path).
 * Vercel/serverless: only `/tmp` is writable — zip download still works in the browser.
 */
export function resolveOutputRoot(outputDir: string): string {
  if (isServerless()) {
    return path.join(os.tmpdir(), "resume-tailor-output");
  }
  const trimmed = outputDir.trim() || "output";
  return path.isAbsolute(trimmed) ? trimmed : path.join(process.cwd(), trimmed);
}

/** Remove all previous batch output before a new run. */
export function clearOutputDirectory(outputDir: string): void {
  const root = resolveOutputRoot(outputDir);
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  fs.mkdirSync(root, { recursive: true });
}

export function ensureUniqueFolder(basePath: string): string {
  if (!fs.existsSync(basePath)) return basePath;
  let counter = 2;
  while (fs.existsSync(`${basePath}_${counter}`)) {
    counter++;
  }
  return `${basePath}_${counter}`;
}

export type SavedJobArtifacts = {
  folderPath: string;
  docxPath: string;
  pdfPath: string | null;
  resumeBaseName: string;
};

export async function saveJobArtifacts(options: {
  outputDir: string;
  folderName: string;
  resumeNamePrefix: string;
  jobUrl: string;
  rawJd: string;
  extractedJd: string;
  resumeMarkdown: string;
  docxBuffer: Buffer;
  pdfBuffer?: Buffer | null;
}): Promise<SavedJobArtifacts> {
  const root = resolveOutputRoot(options.outputDir);
  const folderPath = ensureUniqueFolder(path.join(root, options.folderName));
  fs.mkdirSync(folderPath, { recursive: true });

  const prefix = sanitizeResumeNamePrefix(options.resumeNamePrefix);
  const resumeBaseName = `${prefix}_resume`;

  fs.writeFileSync(path.join(folderPath, "job_url.txt"), options.jobUrl + "\n", "utf8");
  fs.writeFileSync(path.join(folderPath, "raw_jd.txt"), options.rawJd, "utf8");
  fs.writeFileSync(path.join(folderPath, "extracted_jd.txt"), options.extractedJd, "utf8");
  fs.writeFileSync(path.join(folderPath, "updated_resume.md"), options.resumeMarkdown, "utf8");

  const docxPath = path.join(folderPath, `${resumeBaseName}.docx`);
  fs.writeFileSync(docxPath, options.docxBuffer);

  let pdfPath: string | null = null;
  if (options.pdfBuffer?.length) {
    pdfPath = path.join(folderPath, `${resumeBaseName}.pdf`);
    fs.writeFileSync(pdfPath, options.pdfBuffer);
  }

  return { folderPath, docxPath, pdfPath, resumeBaseName };
}

export type ZipFolderEntry = {
  folderName: string;
  files: { name: string; data: Buffer }[];
};

/** Build ZIP from in-memory job folders (preferred on Vercel — does not depend on /tmp lasting). */
export function buildZipFromEntries(entries: ZipFolderEntry[]): Buffer {
  const zip = new AdmZip();
  let added = 0;

  for (const entry of entries) {
    const folder = sanitizeFolderSegment(entry.folderName) || "job";
    for (const file of entry.files) {
      if (!file.data?.length) continue;
      zip.addFile(`${folder}/${file.name}`, file.data);
      added++;
    }
  }

  if (added === 0) {
    throw new Error("No batch files found to zip");
  }
  return zip.toBuffer();
}

/** Build a ZIP of completed job folders from disk (local / same-process /tmp). */
export function buildZipBuffer(folderPaths: string[], outputRoot: string): Buffer {
  const zip = new AdmZip();
  const root = path.resolve(outputRoot);
  let added = 0;

  for (const folderPath of folderPaths) {
    const resolved = path.resolve(folderPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) continue;
    if (resolved !== root && !resolved.startsWith(root + path.sep)) continue;
    zip.addLocalFolder(resolved, path.basename(resolved));
    added++;
  }

  if (added === 0) {
    throw new Error("No batch folders found to zip");
  }
  return zip.toBuffer();
}
