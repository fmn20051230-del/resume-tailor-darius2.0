const MONTH =
  "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)";

const DATE_RANGE_RE = new RegExp(
  `(${MONTH}\\.?\\s+\\d{4}\\s*[-–—]\\s*(?:Present|${MONTH}\\.?\\s+\\d{4})|\\d{4}\\s*[-–—]\\s*(?:Present|\\d{4}))`,
  "i"
);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\+?\d[\d\s().-]{7,}\d/;
const LOCATION_RE = /[A-Za-z .'-]+,\s*(?:[A-Z]{2}|Texas|Tennessee|California|Florida|New York)(?:,\s*USA)?/i;
const LINKEDIN_RE = /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/[^\s|)]+/i;

export type ResumeContact = {
  location?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
};

export type ResumeEducation = {
  university: string;
  period: string;
  degreeLine: string;
};

export type ResumeCertification = {
  text: string;
  url?: string;
};

export type ResumeJob = {
  company: string;
  role: string;
  period: string;
  bullets: string[];
};

export type ResumeSkillGroup = {
  category: string;
  items: string;
};

export type ResumeData = {
  name: string;
  contact: ResumeContact;
  summary: string;
  education: ResumeEducation[];
  certifications: ResumeCertification[];
  experience: ResumeJob[];
  skills: ResumeSkillGroup[];
};

function stripInline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, "$1")
    .trim();
}

function parseLink(line: string): { text: string; url?: string } {
  const m = line.match(/\[([^\]]*)\]\(([^)]+)\)/);
  if (!m) return { text: stripInline(line) };
  let url = m[2].trim();
  if (url && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = "https://" + url;
  return { text: m[1], url };
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function parseLinkedIn(line: string): string | undefined {
  const md = line.match(/\[([^\]]*)\]\(([^)]+)\)/);
  if (md && /linkedin/i.test(md[2])) return normalizeUrl(md[2]);
  const plain = stripInline(line);
  const m = plain.match(LINKEDIN_RE);
  return m ? normalizeUrl(m[0]) : undefined;
}

function mergeContact(a: ResumeContact, b: ResumeContact): ResumeContact {
  return {
    location: a.location || b.location,
    email: a.email || b.email,
    phone: a.phone || b.phone,
    linkedin: a.linkedin || b.linkedin,
  };
}

function isContactLikeLine(line: string): boolean {
  const plain = stripInline(line);
  if (!plain || plain.length > 200) return false;
  if (/^(contact information|contact)$/i.test(plain)) return true;
  if (EMAIL_RE.test(plain)) return true;
  if (PHONE_RE.test(plain)) return true;
  if (LOCATION_RE.test(plain)) return true;
  if (LINKEDIN_RE.test(plain)) return true;
  if (plain.includes("|") && (EMAIL_RE.test(plain) || PHONE_RE.test(plain) || LINKEDIN_RE.test(plain)))
    return true;
  return false;
}

function parseContactLine(line: string): ResumeContact {
  const contact: ResumeContact = {};
  const plain = stripInline(line);

  // Scan whole line first (handles inline mix without pipes)
  const emailMatch = plain.match(EMAIL_RE);
  if (emailMatch) contact.email = emailMatch[0];
  const phoneMatch = plain.match(PHONE_RE);
  if (phoneMatch) contact.phone = phoneMatch[0].replace(/\s+/g, " ").trim();
  const locationMatch = plain.match(LOCATION_RE);
  if (locationMatch) contact.location = locationMatch[0];
  const linkedin = parseLinkedIn(line);
  if (linkedin) contact.linkedin = linkedin;

  const parts = plain
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);

  for (const part of parts) {
    if (!contact.email && EMAIL_RE.test(part)) {
      contact.email = part.match(EMAIL_RE)![0];
      continue;
    }
    if (!contact.phone && PHONE_RE.test(part)) {
      contact.phone = part.match(PHONE_RE)![0].replace(/\s+/g, " ").trim();
      continue;
    }
    if (!contact.location && LOCATION_RE.test(part)) {
      contact.location = part.match(LOCATION_RE)![0];
      continue;
    }
    if (
      !contact.location &&
      !EMAIL_RE.test(part) &&
      !PHONE_RE.test(part) &&
      part.length > 2 &&
      !/linkedin|github|http|www\./i.test(part)
    ) {
      contact.location = part;
    }
  }
  return contact;
}

/** Extract contact fields from any resume text block (used as fallback from base resume). */
export function extractContactFromText(text: string): ResumeContact {
  const lines = text.split(/\n/).slice(0, 25);
  let contact: ResumeContact = {};

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#{1,6}\s/.test(line)) continue;
    if (/^(summary|education|experience|skills|certification)/i.test(stripInline(line))) continue;
    if (isContactLikeLine(line)) {
      contact = mergeContact(contact, parseContactLine(line));
    }
  }

  const block = lines.join("\n");
  if (!contact.email) {
    const m = block.match(EMAIL_RE);
    if (m) contact.email = m[0];
  }
  if (!contact.phone) {
    const m = block.match(PHONE_RE);
    if (m) contact.phone = m[0].replace(/\s+/g, " ").trim();
  }
  if (!contact.location) {
    const m = block.match(LOCATION_RE);
    if (m) contact.location = m[0];
  }
  if (!contact.linkedin) {
    const m = block.match(LINKEDIN_RE);
    if (m) contact.linkedin = normalizeUrl(m[0]);
  }

  return contact;
}

function splitDateLine(line: string): { left: string; right: string } | null {
  const pipeMatch = line.match(/^\*\*([^*]+)\*\*\s*[|–—-]\s*(.+)$/);
  if (pipeMatch && DATE_RANGE_RE.test(pipeMatch[2])) {
    return { left: pipeMatch[1].trim(), right: stripInline(pipeMatch[2]).match(DATE_RANGE_RE)![1] };
  }
  const plain = stripInline(line);
  const match = plain.match(DATE_RANGE_RE);
  if (!match || match.index === undefined) return null;
  const left = plain.slice(0, match.index).replace(/\s*[|–—-]\s*$/, "").trim();
  if (!left || left.length > 90) return null;
  return { left, right: match[1].trim() };
}

function normalizeSection(title: string): string {
  return title.toLowerCase().replace(/[^a-z& ]/g, "").trim();
}

function isSummarySection(section: string): boolean {
  return section.includes("summary") || section.includes("profile");
}

type ParsedSectionHeader = {
  section: string;
  inlineContent?: string;
};

function detectSectionHeader(line: string): ParsedSectionHeader | null {
  const trimmed = line.trim();
  if (!trimmed || /^#{1,6}\s+/.test(trimmed)) return null;

  const boldOnly = trimmed.match(/^\*\*([^*]+)\*\*\s*:?\s*$/);
  if (boldOnly) {
    return { section: normalizeSection(boldOnly[1]) };
  }

  const boldInline = trimmed.match(/^\*\*([^*]+)\*\*\s*:+\s*(.+)$/);
  if (boldInline) {
    return {
      section: normalizeSection(boldInline[1]),
      inlineContent: boldInline[2],
    };
  }

  const plain = stripInline(trimmed);
  if (/^(professional\s+)?summary(\s+of\s+qualifications)?$/i.test(plain)) {
    return { section: "summary" };
  }
  if (/^profile$/i.test(plain)) return { section: "profile" };
  if (/^education$/i.test(plain)) return { section: "education" };
  if (/^(work\s+)?experience$/i.test(plain) || /^professional\s+experience$/i.test(plain)) {
    return { section: "experience" };
  }
  if (/^skills$/i.test(plain) || /^technical\s+skills$/i.test(plain)) {
    return { section: "skills" };
  }
  if (/^(licenses?\s*&?\s*)?certifications?$/i.test(plain)) {
    return { section: "certifications" };
  }

  return null;
}

function applySectionHeader(
  header: ParsedSectionHeader,
  ctx: {
    flushSummary: () => void;
    flushJob: () => void;
    flushContact: () => void;
    flushEducation: () => void;
    setSection: (s: string) => void;
    setExpectRoleLine: (v: boolean) => void;
    summaryLines: string[];
  }
): void {
  ctx.flushSummary();
  ctx.flushJob();
  ctx.flushContact();
  ctx.flushEducation();
  ctx.setSection(header.section);
  ctx.setExpectRoleLine(false);
  if (header.inlineContent && isSummarySection(header.section)) {
    ctx.summaryLines.push(stripInline(header.inlineContent));
  }
}

/** Scan markdown for summary text when the main parser misses it. */
export function extractSummaryFromText(text: string): string {
  const lines = text.split(/\n/);
  let inSummary = false;
  const summaryLines: string[] = [];

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      if (inSummary && summaryLines.length) continue;
      continue;
    }

    const mdHeading = trimmed.match(/^#{1,6}\s+(.*)$/);
    if (mdHeading) {
      const sec = normalizeSection(stripInline(mdHeading[1]));
      if (isSummarySection(sec)) {
        inSummary = true;
        continue;
      }
      if (inSummary) break;
      continue;
    }

    const header = detectSectionHeader(raw);
    if (header) {
      if (isSummarySection(header.section)) {
        inSummary = true;
        if (header.inlineContent) summaryLines.push(stripInline(header.inlineContent));
        continue;
      }
      if (inSummary) break;
      continue;
    }

    if (inSummary) {
      if (detectSectionHeader(raw)) break;
      summaryLines.push(stripInline(trimmed));
    }
  }

  return summaryLines.join(" ").trim();
}

const DEGREE_HINT_RE =
  /\b(?:bachelor|master|associate|doctor|ph\.?d\.?|b\.?s\.?|b\.?a\.?|m\.?s\.?|m\.?a\.?|mba|degree|diploma|gpa)\b/i;

function splitSchoolAndDegree(text: string): { school: string; degree: string } | null {
  const plain = stripInline(text).trim();
  if (!plain) return null;

  const pipeParts = plain.split(/\s*[|]\s*/);
  if (pipeParts.length >= 2) {
    const school = pipeParts[0].trim();
    const rest = pipeParts.slice(1).join(" | ").trim();
    if (school && rest && !DATE_RANGE_RE.test(rest) && DEGREE_HINT_RE.test(rest)) {
      return { school, degree: rest };
    }
  }

  const commaIdx = plain.indexOf(",");
  if (commaIdx > 0) {
    const school = plain.slice(0, commaIdx).trim();
    const degree = plain.slice(commaIdx + 1).trim();
    if (school && degree && DEGREE_HINT_RE.test(degree) && school.length <= 90) {
      return { school, degree };
    }
  }

  return null;
}

function normalizeEducationEntry(edu: ResumeEducation): ResumeEducation {
  if (edu.degreeLine.trim()) return edu;
  const split = splitSchoolAndDegree(edu.university);
  if (!split) return edu;
  return { ...edu, university: split.school, degreeLine: split.degree };
}

function parseSkillLine(line: string): ResumeSkillGroup | null {
  const text = line.trim().replace(/^[-*]\s+/, "");
  const m = text.match(/^\*\*([^*]+)\*\*\s*:+\s*(.+)$/);
  if (m) return { category: m[1].trim(), items: m[2].trim() };
  const plain = stripInline(text);
  const idx = plain.indexOf(":");
  if (idx > 0) return { category: plain.slice(0, idx).trim(), items: plain.slice(idx + 1).trim() };
  return null;
}

function parseResumeMarkdownCore(md: string): ResumeData {
  const data: ResumeData = {
    name: "",
    contact: {},
    summary: "",
    education: [],
    certifications: [],
    experience: [],
    skills: [],
  };

  const lines = md.split(/\n/);
  let section = "header";
  let expectContact = false;
  let contactLines: string[] = [];
  let expectRoleLine = false;
  let currentJob: ResumeJob | null = null;
  let summaryLines: string[] = [];
  let educationPending: Partial<ResumeEducation> | null = null;

  const flushSummary = () => {
    if (summaryLines.length) {
      data.summary = summaryLines.join(" ").trim();
      summaryLines = [];
    }
  };

  const flushJob = () => {
    if (currentJob) {
      data.experience.push(currentJob);
      currentJob = null;
    }
  };

  const flushContact = () => {
    for (const cl of contactLines) {
      data.contact = mergeContact(data.contact, parseContactLine(cl));
    }
    contactLines = [];
    expectContact = false;
  };

  const flushEducation = () => {
    if (!educationPending?.university) {
      educationPending = null;
      return;
    }
    data.education.push(
      normalizeEducationEntry({
        university: educationPending.university,
        period: educationPending.period ?? "",
        degreeLine: educationPending.degreeLine ?? "",
      })
    );
    educationPending = null;
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;

    const heading = line.trim().match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const content = heading[2].trim();

      if (level === 1) {
        flushSummary();
        flushJob();
        flushContact();
        data.name = stripInline(content);
        expectContact = true;
        section = "header";
        continue;
      }

      if (level === 2) {
        flushSummary();
        flushJob();
        flushContact();
        flushEducation();
        section = normalizeSection(stripInline(content));
        expectRoleLine = false;
        continue;
      }

      if (level === 3) {
        const secNorm = normalizeSection(stripInline(content));
        if (isSummarySection(secNorm)) {
          flushSummary();
          flushJob();
          flushContact();
          flushEducation();
          section = secNorm;
          expectRoleLine = false;
          continue;
        }
      }

      if (level === 3 && section.includes("education")) {
        flushEducation();
        const parts = content.split("|").map((s) => s.trim());
        educationPending = {
          university: stripInline(parts[0] ?? content),
          period: "",
          degreeLine: "",
        };
        if (parts[1]) {
          const periodMatch = stripInline(parts[1]).match(DATE_RANGE_RE);
          if (periodMatch) educationPending.period = periodMatch[1];
        }
        continue;
      }

      if (level === 3 && (section.includes("experience") || section.includes("employment"))) {
        flushJob();
        currentJob = {
          company: stripInline(content.split("|")[0] ?? content),
          role: "",
          period: "",
          bullets: [],
        };
        expectRoleLine = true;
        continue;
      }
    }

    if (expectContact) {
      const lower = stripInline(line).toLowerCase();
      if (lower === "contact" || lower === "contact information") continue;
      if (isContactLikeLine(line)) {
        contactLines.push(line);
        continue;
      }
      flushContact();
    }

    const sectHeader = detectSectionHeader(line);
    if (sectHeader) {
      applySectionHeader(sectHeader, {
        flushSummary,
        flushJob,
        flushContact,
        flushEducation,
        setSection: (s) => {
          section = s;
        },
        setExpectRoleLine: (v) => {
          expectRoleLine = v;
        },
        summaryLines,
      });
      continue;
    }

    if (section === "header" && !expectContact) {
      const plain = stripInline(line);
      if (
        plain.length >= 50 &&
        !isContactLikeLine(line) &&
        !DATE_RANGE_RE.test(plain) &&
        !/^[-*]\s/.test(line.trim()) &&
        !DEGREE_HINT_RE.test(plain)
      ) {
        section = "summary";
        summaryLines.push(plain);
        continue;
      }
    }

    if (isSummarySection(section)) {
      summaryLines.push(stripInline(line));
      continue;
    }

    if (section.includes("education")) {
      const boldPipe = line.match(/^\*\*([^*]+)\*\*\s*[|–—-]\s*(.+)$/);
      if (boldPipe) {
        if (DATE_RANGE_RE.test(boldPipe[2])) {
          const periodMatch = stripInline(boldPipe[2]).match(DATE_RANGE_RE);
          educationPending = {
            university: boldPipe[1].trim(),
            period: periodMatch?.[1] ?? "",
            degreeLine: "",
          };
          continue;
        }
        const split = splitSchoolAndDegree(line);
        if (split) {
          flushEducation();
          data.education.push(
            normalizeEducationEntry({
              university: split.school,
              period: "",
              degreeLine: split.degree,
            })
          );
          continue;
        }
        educationPending = {
          university: boldPipe[1].trim(),
          period: "",
          degreeLine: stripInline(boldPipe[2]),
        };
        flushEducation();
        continue;
      }

      const dated = splitDateLine(line);
      if (dated && !educationPending) {
        educationPending = { university: dated.left, period: dated.right, degreeLine: "" };
        continue;
      }
      if (!educationPending) {
        const split = splitSchoolAndDegree(line);
        if (split) {
          data.education.push(
            normalizeEducationEntry({
              university: split.school,
              period: "",
              degreeLine: split.degree,
            })
          );
          continue;
        }
        const boldOnly = line.match(/^\*\*([^*]+)\*\*\s*$/);
        if (boldOnly) {
          educationPending = { university: boldOnly[1].trim(), period: "", degreeLine: "" };
          continue;
        }
        if (!/^[-*]\s/.test(line.trim())) {
          const plainUni = stripInline(line);
          if (plainUni && plainUni.length <= 120) {
            educationPending = { university: plainUni, period: "", degreeLine: "" };
            continue;
          }
        }
      }
      if (educationPending && !educationPending.degreeLine) {
        const degreeDated = splitDateLine(line);
        if (degreeDated && !educationPending.period) {
          educationPending.degreeLine = degreeDated.left;
          educationPending.period = degreeDated.right;
        } else {
          educationPending.degreeLine = stripInline(line);
        }
        flushEducation();
        continue;
      }
      continue;
    }

    if (section.includes("license") || section.includes("certification")) {
      const bullet = line.trim().match(/^[-*]\s+(.*)$/);
      const certLine = bullet ? bullet[1] : line;
      const link = parseLink(certLine);
      data.certifications.push({ text: link.text, url: link.url });
      continue;
    }

    if (section.includes("experience") || section.includes("employment")) {
      const bullet = line.trim().match(/^[-*]\s+(.*)$/);
      if (bullet && currentJob) {
        currentJob.bullets.push(stripInline(bullet[1]));
        expectRoleLine = false;
        continue;
      }

      if (expectRoleLine && currentJob) {
        const dated = splitDateLine(line);
        if (dated) {
          currentJob.role = dated.left;
          currentJob.period = dated.right;
        } else {
          currentJob.role = stripInline(line);
        }
        expectRoleLine = false;
        continue;
      }

      if (!currentJob) {
        const dated = splitDateLine(line);
        if (dated) {
          currentJob = { company: dated.left, role: "", period: dated.right, bullets: [] };
        }
      }
      continue;
    }

    if (section.includes("skill")) {
      const skill = parseSkillLine(line);
      if (skill) data.skills.push(skill);
      continue;
    }
  }

  flushSummary();
  flushJob();
  flushContact();
  flushEducation();

  data.education = data.education.map(normalizeEducationEntry);

  return data;
}

export function parseResumeMarkdown(md: string, baseResume?: string): ResumeData {
  const data = parseResumeMarkdownCore(md);
  if (!data.summary.trim()) {
    data.summary = extractSummaryFromText(md);
  }

  if (!baseResume?.trim()) return data;

  const base = parseResumeMarkdownCore(baseResume);
  data.contact = mergeContact(data.contact, base.contact);
  if (data.education.length === 0 && base.education.length > 0) {
    data.education = base.education;
  }
  if (!data.contact.linkedin) {
    data.contact.linkedin = base.contact.linkedin ?? extractContactFromText(baseResume).linkedin;
  }
  if (!data.summary.trim()) {
    data.summary = extractSummaryFromText(baseResume);
  }
  return data;
}
