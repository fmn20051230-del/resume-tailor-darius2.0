import type {
  ResumeCertification,
  ResumeData,
  ResumeEducation,
  ResumeJob,
  ResumeSkillGroup,
} from "./parse-resume-markdown";
import { headerHyperlinkTargets } from "./template-header-xml";

function esc(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** rgba(91, 155, 213) */
const ACCENT_COLOR = "5B9BD5";
const FONT = 'w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"';

const RPR_BODY = `<w:rPr><w:rFonts ${FONT}/><w:noProof/><w:color w:val="0D0D0D" w:themeColor="text1" w:themeTint="F2"/></w:rPr>`;

const RPR_BOLD = `<w:rPr><w:rFonts ${FONT}/><w:b/><w:bCs/><w:noProof/><w:color w:val="0D0D0D" w:themeColor="text1" w:themeTint="F2"/></w:rPr>`;

const RPR_SECTION = `<w:rPr><w:rFonts ${FONT}/><w:i/><w:noProof/><w:color w:val="${ACCENT_COLOR}"/><w:sz w:val="24"/></w:rPr>`;

/** Content width twips: letter page (11906) minus 0.5in left/right margins (720 each). */
const RIGHT_TAB_POS = 10466;

function textRun(text: string, rPr: string): string {
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : "";
  return `<w:r>${rPr}<w:t${preserve}>${esc(text)}</w:t></w:r>`;
}

/** Keep date ranges on one line (avoid "Sep" / "2022 - Mar 2026" wrapping at spaces). */
function noBreak(text: string): string {
  return text.replace(/ /g, "\u00A0");
}

function tabAlignedParagraph(left: string, right: string): string {
  const tabs = `<w:tabs><w:tab w:val="right" w:pos="${RIGHT_TAB_POS}"/></w:tabs>`;
  return `<w:p><w:pPr>${RPR_BODY}${tabs}</w:pPr>${textRun(left, RPR_BOLD)}<w:r>${RPR_BOLD}<w:tab/></w:r>${textRun(noBreak(right), RPR_BOLD)}</w:p>`;
}

function sectionHeading(title: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="Heading2"/><w:spacing w:line="276" w:lineRule="auto"/>${RPR_SECTION}</w:pPr>${textRun(title.toUpperCase(), RPR_SECTION)}</w:p>`;
}

function bodyParagraph(text: string): string {
  return `<w:p><w:pPr>${RPR_BODY}</w:pPr>${textRun(text, RPR_BODY)}</w:p>`;
}

function companyParagraph(company: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="Heading3"/>${RPR_BODY}</w:pPr>${textRun(company, RPR_BODY)}</w:p>`;
}

function bulletParagraph(text: string): string {
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>${RPR_BODY}</w:pPr>${textRun(text, RPR_BODY)}</w:p>`;
}

function certBullet(text: string, relId?: string): string {
  const inner = `<w:r>${RPR_BODY}<w:rStyle w:val="Hyperlink"/><w:t>${esc(text)}</w:t></w:r>`;
  const content = relId
    ? `<w:hyperlink r:id="${relId}" w:history="1">${inner}</w:hyperlink>`
    : inner;
  return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr>${RPR_BODY}</w:pPr>${content}</w:p>`;
}

function skillParagraph(group: ResumeSkillGroup): string {
  return `<w:p><w:pPr>${RPR_BODY}</w:pPr>${textRun(group.category, RPR_BOLD)}${textRun(": ", RPR_BOLD)}${textRun(group.items, RPR_BODY)}</w:p>`;
}

function educationBlock(edu: ResumeEducation): string {
  let xml = edu.period
    ? tabAlignedParagraph(edu.university, edu.period)
    : `<w:p><w:pPr>${RPR_BODY}</w:pPr>${textRun(edu.university, RPR_BOLD)}</w:p>`;
  if (edu.degreeLine) xml += bodyParagraph(edu.degreeLine);
  return xml;
}

function experienceBlock(job: ResumeJob): string {
  let xml = companyParagraph(job.company);
  if (job.role || job.period) {
    xml += tabAlignedParagraph(job.role || "", job.period || "");
  }
  for (const bullet of job.bullets) {
    xml += bulletParagraph(bullet);
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

export function buildDocumentBodyXml(
  data: ResumeData,
  certLinks: Map<number, string>
): string {
  const parts: string[] = [];

  if (data.summary) {
    parts.push(sectionHeading("Summary"));
    parts.push(bodyParagraph(data.summary));
  }

  if (data.education.length) {
    parts.push(sectionHeading("Education"));
    for (const edu of data.education) parts.push(educationBlock(edu));
  }

  if (data.certifications.length) {
    parts.push(sectionHeading("Licenses & Certifications"));
    data.certifications.forEach((cert, i) => {
      parts.push(certBullet(cert.text, certLinks.get(i)));
    });
  }

  if (data.experience.length) {
    parts.push(sectionHeading("Work Experience"));
    for (const job of data.experience) parts.push(experienceBlock(job));
  }

  if (data.skills.length) {
    parts.push(sectionHeading("Skills"));
    for (const group of data.skills) parts.push(skillParagraph(group));
  }

  return parts.join("");
}
