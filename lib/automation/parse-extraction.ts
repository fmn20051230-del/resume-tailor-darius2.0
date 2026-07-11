import type { ExtractedJobData } from "./types";
import { resolveCompanyAndPosition } from "./infer-job-meta";

type FieldKey = keyof Omit<ExtractedJobData, "raw">;

/** Canonical field labels and their accepted synonyms (normalized, lowercase). */
const FIELD_SYNONYMS: { key: FieldKey; names: string[] }[] = [
  {
    key: "companyName",
    names: ["company name", "company", "employer", "organization", "organisation"],
  },
  {
    key: "positionName",
    names: [
      "position name",
      "position",
      "job title",
      "role title",
      "job position",
      "role",
    ],
  },
  {
    key: "resumeType",
    names: [
      "resume type",
      "resume slot",
      "resume category",
      "resume number",
      "best resume",
      "recommended resume",
      "closest resume",
      "role type",
      "category",
      "slot",
      "type",
    ],
  },
  {
    key: "title",
    names: ["resume title", "title", "headline"],
  },
  {
    key: "summary",
    names: ["summary", "professional summary", "profile", "objective"],
  },
  {
    key: "experience",
    names: [
      "experience",
      "work experience",
      "professional experience",
      "relevant experience",
      "experiences",
    ],
  },
  {
    key: "skills",
    names: ["skills", "technical skills", "key skills", "core skills", "skill"],
  },
];

const SYNONYM_TO_KEY = new Map<string, FieldKey>();
for (const field of FIELD_SYNONYMS) {
  for (const name of field.names) SYNONYM_TO_KEY.set(name, field.key);
}

/** JSON keys → field, for when the LLM returns structured JSON. */
const JSON_KEY_TO_FIELD: Record<string, FieldKey> = {
  companyname: "companyName",
  company: "companyName",
  employer: "companyName",
  positionname: "positionName",
  position: "positionName",
  jobtitle: "positionName",
  role: "positionName",
  resumetype: "resumeType",
  resumeslot: "resumeType",
  type: "resumeType",
  category: "resumeType",
  slot: "resumeType",
  title: "title",
  resumetitle: "title",
  headline: "title",
  summary: "summary",
  profile: "summary",
  experience: "experience",
  workexperience: "experience",
  skills: "skills",
  technicalskills: "skills",
};

function normalizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\(.*?\)/g, " ") // drop parentheticals like "(closest one)"
    .replace(/[_\-]+/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip markdown decoration so bold/heading/bullet lines parse uniformly. */
function stripDecoration(line: string): string {
  return line
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^\s*[-*•]\s*/, "")
    .replace(/^\s*\d+[.)]\s*/, "")
    .trim();
}

export function parseResumeType(value: string): 1 | 2 | 3 | 4 | null {
  if (!value) return null;
  const trimmed = value.trim();

  const digit = trimmed.match(/\b([1-4])\b/);
  if (digit) return Number(digit[1]) as 1 | 2 | 3 | 4;

  const lower = trimmed.toLowerCase();
  if (/\ba\.?i\.?\s*engineer\b/.test(lower) || lower.includes("ai engineer")) return 1;
  if (/machine learning|ml engineer/.test(lower)) return 1;
  if (lower.includes("data engineer")) return 2;
  if (lower.includes("data scientist") || lower.includes("data science")) return 3;
  if (lower.includes("data analyst") || lower.includes("data analytics")) return 4;
  return null;
}

/** Try to read fields from a JSON object embedded in the response. */
function tryParseJson(raw: string): Partial<Record<FieldKey, string>> | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;

  const candidate = raw.slice(start, end + 1);
  let obj: unknown;
  try {
    obj = JSON.parse(candidate);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;

  const result: Partial<Record<FieldKey, string>> = {};
  for (const [rawKey, rawVal] of Object.entries(obj as Record<string, unknown>)) {
    const normKey = rawKey.toLowerCase().replace(/[^a-z]/g, "");
    const field = JSON_KEY_TO_FIELD[normKey];
    if (!field) continue;
    let value = "";
    if (typeof rawVal === "string" || typeof rawVal === "number") {
      value = String(rawVal);
    } else if (Array.isArray(rawVal)) {
      value = rawVal.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join("\n");
    } else if (rawVal && typeof rawVal === "object") {
      value = Object.values(rawVal as Record<string, unknown>)
        .map((v) => String(v))
        .join("\n");
    }
    if (value.trim() && !result[field]) result[field] = value.trim();
  }
  return Object.keys(result).length ? result : null;
}

function extractSections(text: string): Partial<Record<FieldKey, string>> {
  const lines = text.split(/\r?\n/);
  const headers: { key: FieldKey; lineIndex: number; inlineValue?: string }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const cleaned = stripDecoration(lines[i]);
    if (!cleaned) continue;

    const colonIdx = cleaned.search(/[:|=\-–—]/);
    if (colonIdx > 0) {
      const label = normalizeLabel(cleaned.slice(0, colonIdx));
      const key = SYNONYM_TO_KEY.get(label);
      if (key) {
        const inline = cleaned.slice(colonIdx + 1).replace(/^[\s:|=\-–—]+/, "").trim();
        headers.push({ key, lineIndex: i, inlineValue: inline || undefined });
        continue;
      }
    }

    const label = normalizeLabel(cleaned);
    const key = SYNONYM_TO_KEY.get(label);
    if (key) headers.push({ key, lineIndex: i });
  }

  const result: Partial<Record<FieldKey, string>> = {};
  const sorted = [...headers].sort((a, b) => a.lineIndex - b.lineIndex);

  for (let h = 0; h < sorted.length; h++) {
    const current = sorted[h];
    const nextLine = sorted[h + 1]?.lineIndex ?? lines.length;
    const bodyLines: string[] = [];
    if (current.inlineValue) bodyLines.push(current.inlineValue);
    for (let i = current.lineIndex + 1; i < nextLine; i++) {
      const line = lines[i].trimEnd();
      if (line.trim()) bodyLines.push(line);
    }
    if (!result[current.key]) result[current.key] = bodyLines.join("\n").trim();
  }

  return result;
}

/** Last-resort scan of the whole response for a resume type value. */
function findResumeTypeAnywhere(raw: string): 1 | 2 | 3 | 4 | null {
  const labelled = raw.match(
    /resume\s*[_\- ]*(?:type|slot|category|number)[^\n0-9a-z]*([1-4])\b/i
  );
  if (labelled) return Number(labelled[1]) as 1 | 2 | 3 | 4;

  const labelledRole = raw.match(
    /resume\s*[_\- ]*(?:type|slot|category)[^\n]*?(ai engineer|machine learning|ml engineer|data engineer|data scientist|data science|data analyst|data analytics)/i
  );
  if (labelledRole) return parseResumeType(labelledRole[1]);

  // Absolute last resort: first role mention in the response.
  return parseResumeType(raw);
}

export function parseExtractionResponse(
  raw: string,
  context?: { rawJd?: string; jobUrl?: string }
): ExtractedJobData {
  const json = tryParseJson(raw);
  const sections = json ?? extractSections(raw);

  let resumeType = parseResumeType(sections.resumeType ?? "");
  if (!resumeType) resumeType = findResumeTypeAnywhere(raw);

  if (!resumeType) {
    const snippet = raw.trim().slice(0, 240).replace(/\s+/g, " ");
    throw new Error(
      `Could not determine Resume Type (expected 1-4 = AI Engineer / Data Engineer / Data Scientist / Data Analyst). The extraction response did not contain a recognizable resume type. Response starts with: "${snippet}${raw.length > 240 ? "…" : ""}"`
    );
  }

  const companyNameParsed = (sections.companyName ?? "").trim();
  const positionNameParsed = (sections.positionName ?? "").trim();
  const summary = (sections.summary ?? "").trim();
  const experience = (sections.experience ?? "").trim();
  const skills = (sections.skills ?? "").trim();
  const titleParsed = (sections.title ?? "").trim();

  if (!summary && !experience && !skills) {
    const snippet = raw.trim().slice(0, 240).replace(/\s+/g, " ");
    throw new Error(
      `Extraction response is missing Summary, Experience, and Skills sections. Response starts with: "${snippet}${raw.length > 240 ? "…" : ""}"`
    );
  }

  const { companyName, positionName } = resolveCompanyAndPosition({
    parsedCompany: companyNameParsed,
    parsedPosition: positionNameParsed,
    parsedTitle: titleParsed,
    rawExtraction: raw,
    rawJd: context?.rawJd,
    jobUrl: context?.jobUrl,
  });

  return {
    companyName,
    positionName,
    resumeType,
    title: titleParsed,
    summary,
    experience,
    skills,
    raw,
  };
}

export function buildTailorJobDescription(extracted: ExtractedJobData): string {
  const parts: string[] = [];
  if (extracted.summary) parts.push("**Summary**\n\n" + extracted.summary);
  if (extracted.experience) parts.push("**Experience**\n\n" + extracted.experience);
  if (extracted.skills) parts.push("**Skills**\n\n" + extracted.skills);

  // Some prompts return Groups / Mentorship instead of Experience + Skills.
  // In that case send the full extraction so the tailor model still has the JD.
  if ((!extracted.experience || !extracted.skills) && extracted.raw.trim()) {
    return extracted.raw.trim();
  }

  return parts.join("\n\n");
}
