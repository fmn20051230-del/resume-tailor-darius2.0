import type {
  ResumeCertification,
  ResumeData,
  ResumeEducation,
  ResumeJob,
  ResumeSkillGroup,
} from "./parse-resume-markdown";
import {
  extractBetweenJobsSpacerShellFromTemplate,
  extractEducationEntryShellFromTemplate,
  extractEducationHeadingFromTemplate,
  extractExperienceBulletShellFromTemplate,
  extractJobLineShellFromTemplate,
  extractPreBulletSpacerShellFromTemplate,
  extractSkillEntryShellFromTemplate,
  extractSkillsHeadingFromTemplate,
  extractSummaryShellFromTemplate,
  extractWorkExperienceHeadingFromTemplate,
} from "./template-sections-xml";
import { headerHyperlinkTargets } from "./template-header-xml";

function esc(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FONT = 'w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi" w:cstheme="majorHAnsi"';
const BODY_SZ = '<w:sz w:val="22"/><w:szCs w:val="22"/>';
const JOB_SZ = '<w:sz w:val="24"/><w:szCs w:val="24"/>';
const RIGHT_TAB = 10197;
const LINE_SPACING = '<w:spacing w:line="276" w:lineRule="auto"/>';

/** Summary uses Heading2 border but normal black text (w:b val="0" overrides blue bold). */
const RPR_SUMMARY = `<w:rPr><w:rFonts ${FONT}/><w:b w:val="0"/><w:color w:val="auto"/>${BODY_SZ}<w:lang w:val="en-US"/></w:rPr>`;
const RPR_BODY = `<w:rPr><w:rFonts ${FONT}/>${BODY_SZ}<w:lang w:val="en-US"/></w:rPr>`;
const RPR_BOLD = `<w:rPr><w:rFonts ${FONT}/><w:b/><w:bCs/>${BODY_SZ}<w:lang w:val="en-US"/></w:rPr>`;
const RPR_JOB = `<w:rPr><w:rFonts ${FONT}/>${JOB_SZ}<w:lang w:val="en-US"/></w:rPr>`;
const RPR_JOB_BOLD = `<w:rPr><w:rFonts ${FONT}/><w:b/><w:bCs/>${JOB_SZ}<w:lang w:val="en-US"/></w:rPr>`;

let cachedSummaryPPr: string | null = null;
let cachedJobPPr: string | null = null;
let cachedBulletPPr: string | null = null;
let cachedSkillPPr: string | null = null;
let cachedEducationPPr: string | null = null;
let cachedPreBulletSpacer: string | null = null;
let cachedBetweenJobsSpacer: string | null = null;
let cachedWorkHeading: string | null = null;
let cachedSkillsHeading: string | null = null;
let cachedEducationHeading: string | null = null;

function paragraphPPr(shell: string): string {
  const match = shell.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
  if (!match) throw new Error("template paragraph missing pPr");
  return match[0];
}

function withParagraphProps(pPr: string, opts: { justify?: boolean } = {}): string {
  // Strip any spacing/jc we injected before, then re-add in schema-valid order (before rPr).
  const base = pPr.replace(/<w:spacing\b[^>]*\/>/g, "").replace(/<w:jc\b[^>]*\/>/g, "");
  const props = LINE_SPACING + (opts.justify ? '<w:jc w:val="both"/>' : "");
  const rPrIdx = base.indexOf("<w:rPr");
  if (rPrIdx >= 0) {
    return base.slice(0, rPrIdx) + props + base.slice(rPrIdx);
  }
  return base.replace("</w:pPr>", `${props}</w:pPr>`);
}

function textRun(text: string, rPr: string): string {
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `<w:r>${rPr}<w:t${preserve}>${esc(text)}</w:t></w:r>`;
}

/** Keep paragraph with the next one so headings/job lines aren't stranded at page bottom. */
const KEEP_TOGETHER = "<w:keepNext/><w:keepLines/>";

function ensureParagraphKeepTogether(pXml: string): string {
  if (/<w:keepNext\b/.test(pXml)) {
    if (!/<w:keepLines\b/.test(pXml)) {
      return pXml.replace(/<w:keepNext\s*\/>/, "<w:keepNext/><w:keepLines/>");
    }
    return pXml;
  }
  return pXml.replace(/<w:pPr>([\s\S]*?)<\/w:pPr>/, (_m, inner: string) => {
    if (/<w:pStyle\b/.test(inner)) {
      return `<w:pPr>${inner.replace(/(<w:pStyle\b[^/]*\/>)/, `$1${KEEP_TOGETHER}`)}</w:pPr>`;
    }
    return `<w:pPr>${KEEP_TOGETHER}${inner}</w:pPr>`;
  });
}

/**
 * If a heading (or job/company line) would land in the last ~4 lines of a page,
 * Word moves it with the following content via keepNext chains.
 */
function applyOrphanHeadingControl(bodyXml: string): string {
  const re = /<w:p\b[\s\S]*?<\/w:p>/g;
  const paragraphs: { start: number; end: number; xml: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(bodyXml)) !== null) {
    paragraphs.push({ start: m.index, end: m.index + m[0].length, xml: m[0] });
  }
  if (!paragraphs.length) return bodyXml;

  const paragraphText = (p: string): string =>
    [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((x) => x[1]).join("");

  const isEmptyParagraph = (p: string): boolean => !paragraphText(p).trim();

  const isSectionHeading = (p: string): boolean => {
    const t = paragraphText(p).trim();
    return (
      /^Work Experience$/i.test(t) ||
      /^Technologies and Languages$/i.test(t) ||
      /^Education and Certifications$/i.test(t)
    );
  };

  const isJobOrEducationLine = (p: string): boolean => {
    if (isSectionHeading(p) || isEmptyParagraph(p)) return false;
    if (/<w:numPr>/.test(p)) return false;
    // Job line / education entry: bold text with tab(s).
    return /<w:tab\s*\/>/.test(p) && /<w:b\s*\/>/.test(p);
  };

  const xmls = paragraphs.map((p) => p.xml);
  const followLines = 3; // heading + 3 following ≈ last-four-lines guard

  const keepFollowing = (start: number, stopAtJobLine: boolean) => {
    let kept = 0;
    for (let j = 1; start + j < xmls.length && kept < followLines; j++) {
      const idx = start + j;
      if (isSectionHeading(xmls[idx])) break;
      if (stopAtJobLine && isJobOrEducationLine(xmls[idx])) break;
      if (isEmptyParagraph(xmls[idx])) {
        xmls[idx] = ensureParagraphKeepTogether(xmls[idx]);
        continue;
      }
      xmls[idx] = ensureParagraphKeepTogether(xmls[idx]);
      kept++;
    }
  };

  for (let i = 0; i < xmls.length; i++) {
    if (isSectionHeading(xmls[i])) {
      xmls[i] = ensureParagraphKeepTogether(xmls[i]);
      keepFollowing(i, false);
      continue;
    }
    if (isJobOrEducationLine(xmls[i])) {
      xmls[i] = ensureParagraphKeepTogether(xmls[i]);
      keepFollowing(i, true);
    }
  }

  let out = "";
  let cursor = 0;
  for (let i = 0; i < paragraphs.length; i++) {
    out += bodyXml.slice(cursor, paragraphs[i].start);
    out += xmls[i];
    cursor = paragraphs[i].end;
  }
  return out + bodyXml.slice(cursor);
}

function noBreak(text: string): string {
  return text.replace(/ /g, "\u00A0");
}

function formatPeriod(period: string): string {
  return period.replace(/\s*-\s*/g, " \u2013 ").trim();
}

function buildPeriodRuns(period: string): string {
  const match = period.trim().match(/^([A-Za-z]{3,9})\s+(\d{4})\s*[–-]\s*([A-Za-z]{3,9})\s+(\d{4}|Present)$/);
  if (!match) {
    return textRun(noBreak(formatPeriod(period)), RPR_JOB);
  }
  const [, startMonth, startYear, endMonth, endYear] = match;
  return (
    textRun(startMonth, RPR_JOB_BOLD) +
    textRun(` ${startYear} – `, RPR_JOB) +
    textRun(endMonth, RPR_JOB_BOLD) +
    textRun(` ${endYear}`, RPR_JOB)
  );
}

function summaryParagraph(text: string): string {
  if (!cachedSummaryPPr) {
    cachedSummaryPPr = withParagraphProps(paragraphPPr(extractSummaryShellFromTemplate()), {
      justify: true,
    });
  }
  return `<w:p>${cachedSummaryPPr}${textRun(text, RPR_SUMMARY)}</w:p>`;
}

function workExperienceHeading(): string {
  if (!cachedWorkHeading) cachedWorkHeading = extractWorkExperienceHeadingFromTemplate();
  return cachedWorkHeading;
}

function skillsHeading(): string {
  if (!cachedSkillsHeading) cachedSkillsHeading = extractSkillsHeadingFromTemplate();
  return cachedSkillsHeading;
}

function educationHeading(): string {
  if (!cachedEducationHeading) cachedEducationHeading = extractEducationHeadingFromTemplate();
  return cachedEducationHeading;
}

function jobLineParagraph(role: string, company: string, period: string): string {
  if (!cachedJobPPr) {
    cachedJobPPr = withParagraphProps(paragraphPPr(extractJobLineShellFromTemplate()));
  }
  return (
    `<w:p>${cachedJobPPr}` +
    textRun(role, RPR_JOB_BOLD) +
    `<w:r>${RPR_JOB_BOLD}<w:tab/></w:r>` +
    textRun(company, RPR_JOB_BOLD) +
    `<w:r>${RPR_JOB}<w:tab/></w:r>` +
    buildPeriodRuns(period) +
    `</w:p>`
  );
}

function bulletParagraph(text: string, numId: number): string {
  if (!cachedBulletPPr && numId === 1) {
    cachedBulletPPr = withParagraphProps(paragraphPPr(extractExperienceBulletShellFromTemplate()), {
      justify: true,
    });
  }
  const pPr =
    numId === 1 && cachedBulletPPr
      ? cachedBulletPPr
      : `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` +
        `<w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="left" w:pos="1440"/><w:tab w:val="left" w:pos="2160"/></w:tabs>` +
        `${RPR_BODY}${LINE_SPACING}</w:pPr>`;
  return `<w:p>${pPr}${textRun(text, RPR_BODY)}</w:p>`;
}

function skillParagraph(group: ResumeSkillGroup): string {
  if (!cachedSkillPPr) {
    cachedSkillPPr = withParagraphProps(paragraphPPr(extractSkillEntryShellFromTemplate()));
  }
  return (
    `<w:p>${cachedSkillPPr}` +
    textRun(group.category, RPR_BOLD) +
    textRun(": ", RPR_BODY) +
    textRun(group.items, RPR_BODY) +
    `</w:p>`
  );
}

function educationEntry(edu: ResumeEducation): string {
  if (!cachedEducationPPr) {
    cachedEducationPPr = withParagraphProps(paragraphPPr(extractEducationEntryShellFromTemplate()));
  }
  const degree = edu.degreeLine?.trim() ?? "";
  const university = edu.university.trim();
  const period = edu.period?.trim() ?? "";
  return (
    `<w:p>${cachedEducationPPr}` +
    (degree ? textRun(`${degree}, `, RPR_BOLD) : "") +
    textRun(university, RPR_BODY) +
    (period ? `<w:r>${RPR_BODY}<w:tab/></w:r>${textRun(noBreak(formatPeriod(period)), RPR_BODY)}` : "") +
    `</w:p>`
  );
}

function preBulletSpacer(): string {
  if (!cachedPreBulletSpacer) {
    cachedPreBulletSpacer = extractPreBulletSpacerShellFromTemplate();
  }
  return cachedPreBulletSpacer;
}

function betweenJobsSpacer(): string {
  if (!cachedBetweenJobsSpacer) {
    cachedBetweenJobsSpacer = extractBetweenJobsSpacerShellFromTemplate();
  }
  return cachedBetweenJobsSpacer;
}

function certEntry(text: string, relId?: string): string {
  const inner = `<w:r>${RPR_BODY}<w:rStyle w:val="Hyperlink"/><w:t>${esc(text)}</w:t></w:r>`;
  const content = relId
    ? `<w:hyperlink r:id="${relId}" w:history="1">${inner}</w:hyperlink>`
    : inner;
  const pPr =
    `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr>` +
    `<w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="left" w:pos="1440"/><w:tab w:val="left" w:pos="2160"/></w:tabs>` +
    `${RPR_BODY}${LINE_SPACING}</w:pPr>`;
  return `<w:p>${pPr}${content}</w:p>`;
}

function experienceBlock(job: ResumeJob): string {
  let xml = jobLineParagraph(job.role, job.company, job.period);
  xml += preBulletSpacer();
  for (const bullet of job.bullets) {
    xml += bulletParagraph(bullet, 1);
  }
  return xml;
}

export type HyperlinkRel = { id: string; url: string };

export function buildHyperlinkRels(data: ResumeData): {
  certLinks: Map<number, string>;
  rels: HyperlinkRel[];
} {
  const rels: HyperlinkRel[] = [...headerHyperlinkTargets(data.contact)];
  const certLinks = new Map<number, string>();
  let nextId = 12;

  data.certifications.forEach((cert, index) => {
    if (!cert.url) return;
    const id = `rId${nextId++}`;
    certLinks.set(index, id);
    rels.push({ id, url: cert.url });
  });

  return { certLinks, rels };
}

export function buildDocumentBodyXml(
  data: ResumeData,
  certLinks: Map<number, string>
): string {
  const parts: string[] = [];

  if (data.summary.trim()) {
    parts.push(summaryParagraph(data.summary.trim()));
  }

  if (data.experience.length) {
    parts.push(workExperienceHeading());
    data.experience.forEach((job, index) => {
      parts.push(experienceBlock(job));
      if (index < data.experience.length - 1) parts.push(betweenJobsSpacer());
    });
  }

  if (data.skills.length) {
    parts.push(skillsHeading());
    for (const group of data.skills) parts.push(skillParagraph(group));
  }

  if (data.education.length || data.certifications.length) {
    parts.push(educationHeading());
    for (const edu of data.education) parts.push(educationEntry(edu));
    data.certifications.forEach((cert, i) => {
      parts.push(certEntry(cert.text, certLinks.get(i)));
    });
  }

  return applyOrphanHeadingControl(parts.join(""));
}

/** @deprecated Use buildHyperlinkRels */
export function buildCertHyperlinks(certs: ResumeCertification[]): {
  linkMap: Map<number, string>;
  rels: HyperlinkRel[];
} {
  const { certLinks, rels } = buildHyperlinkRels({
    name: "",
    contact: {},
    summary: "",
    education: [],
    certifications: certs,
    experience: [],
    skills: [],
  });
  return { linkMap: certLinks, rels };
}
