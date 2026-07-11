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
      "role name",
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
      "slot",
    ],
  },
  {
    key: "title",
    names: ["resume title", "title", "headline", "suggested title"],
  },
  {
    key: "summary",
    names: [
      "summary",
      "summary of the role",
      "role summary",
      "job summary",
      "professional summary",
      "profile",
      "objective",
      "what they are looking for",
    ],
  },
  {
    key: "experience",
    names: [
      "experience",
      "experience group",
      "work experience",
      "professional experience",
      "relevant experience",
      "experiences",
      "domain experience",
      "knowledge",
      "domains",
      "industry",
      "industries",
    ],
  },
  {
    key: "skills",
    names: [
      "skills",
      "skills group",
      "skill group",
      "technical skills",
      "key skills",
      "core skills",
      "hard skills",
      "skill",
      "technologies",
      "tech stack",
      "tools",
    ],
  },
];

const SYNONYM_TO_KEY = new Map<string, FieldKey>();
for (const field of FIELD_SYNONYMS) {
  for (const name of field.names) SYNONYM_TO_KEY.set(name, field.key);
}

/** Longer labels first so "summary of the role" wins over "summary". */
const SORTED_SYNONYMS = [...SYNONYM_TO_KEY.entries()].sort(
  (a, b) => b[0].length - a[0].length
);

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
  summaryoftherole: "summary",
  rolesummary: "summary",
  profile: "summary",
  experience: "experience",
  experiencegroup: "experience",
  workexperience: "experience",
  skills: "skills",
  skillsgroup: "skills",
  technicalskills: "skills",
  hardskills: "skills",
};

function normalizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[_\-]+/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function matchLabelToKey(label: string): FieldKey | null {
  const norm = normalizeLabel(label);
  if (!norm) return null;
  const exact = SYNONYM_TO_KEY.get(norm);
  if (exact) return exact;
  for (const [name, key] of SORTED_SYNONYMS) {
    if (norm === name || norm.startsWith(name + " ") || norm.endsWith(" " + name)) {
      return key;
    }
  }
  return null;
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

/**
 * LLMs often return one blob: "**Resume Type:** 1 **Summary of the Role:** …"
 * Insert newlines before labeled markers so line-based parsing works.
 */
function normalizeExtractionText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/\*\*\s*([^*:\n]{1,80}?)\s*\*\*\s*:/g, "\n**$1:**")
    .replace(/(?:^|[\s.])(-?summary)\s*:/gi, "\n$1:")
    .replace(
      /\b(Resume\s*Type|Summary(?:\s+of\s+the\s+Role)?|Experience(?:\s+Group)?|Skills(?:\s+Group)?|Hard\s*Skills|Title|Company(?:\s+Name)?|Position(?:\s+Name)?)\s*:/gi,
      "\n$1:"
    )
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function parseResumeType(value: string): 1 | 2 | 3 | 4 | null {
  if (!value) return null;
  const trimmed = value.trim();

  const digit = trimmed.match(/\b([1-4])\b/);
  if (digit) return Number(digit[1]) as 1 | 2 | 3 | 4;

  const lower = trimmed.toLowerCase();
  if (/\ba\.?i\.?\s*engineer\b/.test(lower) || lower.includes("ai engineer")) return 1;
  if (/machine learning|ml engineer|applied ai/.test(lower)) return 1;
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
      const label = cleaned.slice(0, colonIdx);
      const key = matchLabelToKey(label);
      if (key) {
        const inline = cleaned.slice(colonIdx + 1).replace(/^[\s:|=\-–—]+/, "").trim();
        headers.push({ key, lineIndex: i, inlineValue: inline || undefined });
        continue;
      }
    }

    const key = matchLabelToKey(cleaned);
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

/** Pull Group 1/2/3 style blocks into experience/skills when labeled sections are thin. */
function extractGroupsFallback(raw: string): Partial<Record<FieldKey, string>> {
  const result: Partial<Record<FieldKey, string>> = {};
  const groupBlocks = [
    ...raw.matchAll(
      /(?:^|\n)\s*(?:\*\*)?(?:group\s*[1-9]|experience(?:\s+group)?|skills?(?:\s+group)?|hard\s*skills)(?:\*\*)?\s*[:\-–—]\s*([^\n]+(?:\n(?!\s*(?:\*\*)?(?:group\s*[1-9]|resume\s*type|summary|title|mentorship|leadership)\b)[^\n]+)*)/gi
    ),
  ];

  const chunks: string[] = [];
  for (const m of groupBlocks) {
    const label = m[0].split(/[:\-–—]/)[0] ?? "";
    const body = (m[1] ?? "").trim();
    if (!body) continue;
    const key = matchLabelToKey(label);
    if (key === "skills" || /skill/i.test(label)) {
      result.skills = result.skills ? `${result.skills}, ${body}` : body;
    } else if (key === "experience" || /experience|group\s*1/i.test(label)) {
      result.experience = result.experience ? `${result.experience}, ${body}` : body;
    } else {
      chunks.push(body);
    }
  }

  if (chunks.length) {
    if (!result.experience) result.experience = chunks[0];
    if (!result.skills && chunks.length > 1) result.skills = chunks.slice(1).join(", ");
    else if (!result.skills) result.skills = chunks.join(", ");
  }

  return result;
}

/** Last-resort scan of the whole response for a resume type value. */
function findResumeTypeAnywhere(raw: string): 1 | 2 | 3 | 4 | null {
  const labelled = raw.match(
    /resume\s*[_\- ]*(?:type|slot|category|number)[^\n0-9a-z]{0,40}([1-4])\b/i
  );
  if (labelled) return Number(labelled[1]) as 1 | 2 | 3 | 4;

  const labelledRole = raw.match(
    /resume\s*[_\- ]*(?:type|slot|category)[^\n]*?(ai engineer|machine learning|ml engineer|applied ai|data engineer|data scientist|data science|data analyst|data analytics)/i
  );
  if (labelledRole) return parseResumeType(labelledRole[1]);

  return parseResumeType(raw);
}

function mergeSections(
  ...parts: Array<Partial<Record<FieldKey, string>> | null | undefined>
): Partial<Record<FieldKey, string>> {
  const out: Partial<Record<FieldKey, string>> = {};
  for (const part of parts) {
    if (!part) continue;
    for (const [k, v] of Object.entries(part) as [FieldKey, string][]) {
      if (v?.trim() && !out[k]?.trim()) out[k] = v.trim();
    }
  }
  return out;
}

export function parseExtractionResponse(
  raw: string,
  context?: { rawJd?: string; jobUrl?: string }
): ExtractedJobData {
  const normalized = normalizeExtractionText(raw);
  const json = tryParseJson(raw);
  const sections = mergeSections(
    json,
    extractSections(normalized),
    extractSections(raw),
    extractGroupsFallback(normalized)
  );

  let resumeType = parseResumeType(sections.resumeType ?? "");
  if (!resumeType) resumeType = findResumeTypeAnywhere(raw);

  if (!resumeType) {
    const snippet = raw.trim().slice(0, 240).replace(/\s+/g, " ");
    throw new Error(
      `Could not determine Resume Type (expected 1-4 = AI Engineer / Data Engineer / Data Scientist / Data Analyst). The extraction response did not contain a recognizable resume type. Response starts with: "${snippet}${raw.length > 240 ? "…" : ""}"`
    );
  }

  let companyNameParsed = (sections.companyName ?? "").trim();
  let positionNameParsed = (sections.positionName ?? "").trim();
  let summary = (sections.summary ?? "").trim();
  let experience = (sections.experience ?? "").trim();
  let skills = (sections.skills ?? "").trim();
  let titleParsed = (sections.title ?? "").trim();

  // Salvage: enough signal to continue — tailor uses full raw when sections are thin.
  if (!summary && !experience && !skills && raw.trim().length > 80) {
    summary = raw.trim();
  }

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
