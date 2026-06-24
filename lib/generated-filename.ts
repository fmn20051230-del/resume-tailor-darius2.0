const INVALID_FILENAME_RE = /[\\/:*?"<>|\x00-\x1f#\[\]{};@!$&'`+=]/gi;

const MAX_BASE_LENGTH = 60;

function stripMarkdownInline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function safeFilenameSegment(text: string, maxLength = 60): string {
  const cleaned = stripMarkdownInline(text)
    .replace(INVALID_FILENAME_RE, " ")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
  if (!cleaned) return "";
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

export const SLOT_JOB_TITLES = [
  "AI Engineer",
  "Data Engineer",
  "Data Scientist",
  "Data Analyst",
] as const;

export function safeFilenameFromFirstLine(firstLine: string): string {
  const cleaned = firstLine
    .replace(INVALID_FILENAME_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  const base = cleaned || "resume";
  return base.length > MAX_BASE_LENGTH ? base.slice(0, MAX_BASE_LENGTH) : base;
}

export function extractJobTitleFromJd(jd: string): string {
  const lines = jd.split(/\n/);
  let inTitleSection = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const heading = line.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      const title = stripMarkdownInline(heading[1]);
      if (/^resume\s*title$/i.test(title)) {
        inTitleSection = true;
        continue;
      }
      if (inTitleSection) break;
      continue;
    }

    if (/^resume\s*title\s*:?\s*$/i.test(stripMarkdownInline(line))) {
      inTitleSection = true;
      continue;
    }

    const inlineTitle = line.match(/^resume\s*title\s*:+\s*(.+)$/i);
    if (inlineTitle?.[1]?.trim()) {
      return stripMarkdownInline(inlineTitle[1]);
    }

    if (inTitleSection) {
      if (/^#{1,6}\s+/.test(line)) break;
      const bold = line.match(/\*\*([^*]+)\*\*/);
      if (bold?.[1]?.trim()) return bold[1].trim();
      const plain = stripMarkdownInline(line);
      if (plain) return plain;
    }
  }

  const topBold = jd.match(/^\s*\*\*([^*]{3,80})\*\*/m);
  if (topBold?.[1]?.trim()) return topBold[1].trim();

  return "";
}

export function resolveJobTitleForFilename(jd: string, slotIndex: number): string {
  const fromJd = extractJobTitleFromJd(jd);
  if (fromJd) return fromJd;
  return SLOT_JOB_TITLES[slotIndex] ?? SLOT_JOB_TITLES[0];
}

/** e.g. darius_campbell_resume_senior_data_engineer */
export function buildGeneratedFileName(nameBase: string, jobTitle: string): string {
  const name = safeFilenameSegment(nameBase.replace(/\s+/g, " "));
  const title = safeFilenameSegment(jobTitle);
  if (!title) return `${name || "resume"}_resume`;
  return `${name || "resume"}_resume_${title}`;
}
