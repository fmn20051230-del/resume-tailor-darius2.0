import fs from "fs";
import path from "path";
import PizZip from "pizzip";

export const TEMPLATE_DOCX_PATH = path.join(
  process.cwd(),
  "public",
  "templates",
  "template.docx"
);

const LIB_TEMPLATE_PATH = path.join(process.cwd(), "lib", "templates", "template.docx");

export function resolveTemplatePath(): string {
  if (fs.existsSync(TEMPLATE_DOCX_PATH)) return TEMPLATE_DOCX_PATH;
  if (fs.existsSync(LIB_TEMPLATE_PATH)) return LIB_TEMPLATE_PATH;
  throw new Error("template.docx not found in public/templates or lib/templates");
}

function getBodyInner(): string {
  const body = new PizZip(fs.readFileSync(resolveTemplatePath()))
    .file("word/document.xml")!
    .asText();
  const start = body.indexOf("<w:body>") + 8;
  const end = body.indexOf("<w:sectPr");
  if (start < 8 || end < 0) throw new Error("template.docx missing body");
  return body.slice(start, end);
}

function getParagraphs(): string[] {
  return getBodyInner().match(/<w:p[\s\S]*?<\/w:p>/g) ?? [];
}

function firstContentIndex(inner: string): number {
  const afterTable = inner.indexOf("</w:tbl>");
  const searchFrom = afterTable >= 0 ? afterTable : 0;
  const heading2 = inner.indexOf('<w:pStyle w:val="Heading2"', searchFrom);
  if (heading2 < 0) throw new Error("template.docx missing content sections");
  const paraStart = inner.lastIndexOf("<w:p ", heading2);
  return paraStart >= 0 ? paraStart : heading2;
}

/** Full 3-column header table from template.docx (location | name | phone/email). */
export function extractHeaderFromTemplate(): string {
  const inner = getBodyInner();
  const headerEnd = firstContentIndex(inner);
  const before = inner.slice(0, headerEnd);
  const tableMatch = before.match(/<w:tbl[\s\S]*?<\/w:tbl>/);
  if (tableMatch) return tableMatch[0];

  const paragraphs = before.match(/<w:p[\s\S]*?<\/w:p>/g) ?? [];
  if (!paragraphs.length) throw new Error("Could not extract header from template.docx");
  return paragraphs.join("");
}

/** Summary paragraph shell (Heading2 border, normal black body text — not blue bold). */
export function extractSummaryShellFromTemplate(): string {
  const inner = getBodyInner();
  const contentStart = firstContentIndex(inner);
  const close = inner.indexOf("</w:p>", contentStart);
  if (close < 0) throw new Error("template.docx missing summary paragraph");
  return inner.slice(contentStart, close + 6);
}

/** Work Experience section heading shell from template.docx. */
export function extractWorkExperienceHeadingFromTemplate(): string {
  const inner = getBodyInner();
  const idx = inner.search(/<w:t>Work Experience<\/w:t>/);
  if (idx < 0) throw new Error("template.docx missing Work Experience heading");
  const start = inner.lastIndexOf("<w:p ", idx);
  const close = inner.indexOf("</w:p>", idx);
  if (start < 0 || close < 0) throw new Error("template.docx missing Work Experience paragraph");
  return inner.slice(start, close + 6);
}

/** First job line shell (role | company | dates tabs) from template.docx. */
export function extractJobLineShellFromTemplate(): string {
  const inner = getBodyInner();
  const idx = inner.search(/<w:t>Position1<\/w:t>/);
  if (idx < 0) throw new Error("template.docx missing job line placeholder");
  const start = inner.lastIndexOf("<w:p ", idx);
  const close = inner.indexOf("</w:p>", idx);
  if (start < 0 || close < 0) throw new Error("template.docx missing job line paragraph");
  return inner.slice(start, close + 6);
}

/** Bullet paragraph shell (numId 1) from template.docx. */
export function extractExperienceBulletShellFromTemplate(): string {
  const inner = getBodyInner();
  const idx = inner.search(/<w:t>bullet<\/w:t>/);
  if (idx < 0) throw new Error("template.docx missing bullet placeholder");
  const start = inner.lastIndexOf("<w:p ", idx);
  const close = inner.indexOf("</w:p>", idx);
  if (start < 0 || close < 0) throw new Error("template.docx missing bullet paragraph");
  return inner.slice(start, close + 6);
}

/** Empty paragraph after the job line and before bullets. */
export function extractPreBulletSpacerShellFromTemplate(): string {
  const paragraphs = getParagraphs();
  const idx = paragraphs.findIndex((paragraph) => /<w:t>Position1<\/w:t>/.test(paragraph));
  if (idx < 0 || idx + 1 >= paragraphs.length) {
    throw new Error("template.docx missing pre-bullet spacer paragraph");
  }
  return paragraphs[idx + 1];
}

/** Empty paragraph between one experience block and the next. */
export function extractBetweenJobsSpacerShellFromTemplate(): string {
  const paragraphs = getParagraphs();
  const idx = paragraphs.findIndex((paragraph) => /<w:t>bullet<\/w:t>/.test(paragraph));
  if (idx < 0 || idx + 1 >= paragraphs.length) {
    throw new Error("template.docx missing between-jobs spacer paragraph");
  }
  return paragraphs[idx + 1];
}

/** Skill entry shell from template.docx (Group Name: Skill1, Skill2). */
export function extractSkillEntryShellFromTemplate(): string {
  const inner = getBodyInner();
  const idx = inner.search(/<w:t>Group Name<\/w:t>/);
  if (idx < 0) throw new Error("template.docx missing skill entry paragraph");
  const start = inner.lastIndexOf("<w:p ", idx);
  const close = inner.indexOf("</w:p>", idx);
  if (start < 0 || close < 0) throw new Error("template.docx missing skill entry paragraph");
  return inner.slice(start, close + 6);
}

/** Technologies and Languages heading from template.docx. */
export function extractSkillsHeadingFromTemplate(): string {
  const inner = getBodyInner();
  const idx = inner.search(/<w:t>Technologies and Languages<\/w:t>/);
  if (idx < 0) throw new Error("template.docx missing skills heading");
  const start = inner.lastIndexOf("<w:p ", idx);
  const close = inner.indexOf("</w:p>", idx);
  return inner.slice(start, close + 6);
}

/** Education and Certifications heading from template.docx. */
export function extractEducationHeadingFromTemplate(): string {
  const inner = getBodyInner();
  const idx = inner.search(/<w:t>Education and Certifications<\/w:t>/);
  if (idx < 0) throw new Error("template.docx missing education heading");
  const start = inner.lastIndexOf("<w:p ", idx);
  const close = inner.indexOf("</w:p>", idx);
  return inner.slice(start, close + 6);
}

/** Education entry shell from template.docx. */
export function extractEducationEntryShellFromTemplate(): string {
  const inner = getBodyInner();
  const idx = inner.search(/<w:t xml:space="preserve">M\.Sc\. <\/w:t>|<w:t>M\.Sc\.<\/w:t>/);
  if (idx < 0) throw new Error("template.docx missing education entry paragraph");
  const start = inner.lastIndexOf("<w:p ", idx);
  const close = inner.indexOf("</w:p>", idx);
  if (start < 0 || close < 0) throw new Error("template.docx missing education entry paragraph");
  return inner.slice(start, close + 6);
}
