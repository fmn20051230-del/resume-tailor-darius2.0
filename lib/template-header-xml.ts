import fs from "fs";
import path from "path";
import PizZip from "pizzip";
import type { ResumeContact, ResumeData } from "./parse-resume-markdown";

const TEMPLATE_DOCX_PATH = path.join(process.cwd(), "lib", "templates", "template2.docx");

/** Template defaults used as replace anchors in template2-header.xml */
const TEMPLATE_NAME_FIRST = "Darius";
const TEMPLATE_NAME_LAST = "Campbell";
const TEMPLATE_PHONE_AREA = "872";
const TEMPLATE_PHONE_PREFIX = "234";
const TEMPLATE_PHONE_LINE = "8844";
const TEMPLATE_EMAIL = "darius19885@outlook.com";
const TEMPLATE_CITY = "Fort Worth";
const TEMPLATE_STATE = "TX";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Extract name + contact paragraphs from template2.docx (everything before SUMMARY). */
function extractHeaderFromTemplateDocx(): string {
  if (!fs.existsSync(TEMPLATE_DOCX_PATH)) {
    throw new Error("template2.docx not found in lib/templates");
  }
  const body = new PizZip(fs.readFileSync(TEMPLATE_DOCX_PATH))
    .file("word/document.xml")!
    .asText();
  const inner = body.slice(body.indexOf("<w:body>") + 8);
  const summaryIdx = inner.search(/<w:t>SUMMARY<\/w:t>/);
  if (summaryIdx < 0) {
    throw new Error("template2.docx missing SUMMARY section");
  }

  let pos = 0;
  let header = "";
  while (pos < summaryIdx) {
    const end = inner.indexOf("</w:p>", pos);
    if (end < 0 || end > summaryIdx) break;
    header += inner.slice(pos, end + 6);
    pos = end + 6;
  }
  if (!header.trim()) {
    throw new Error("Could not extract header from template2.docx");
  }
  return header;
}

function readHeaderTemplate(): string {
  return extractHeaderFromTemplateDocx();
}

function parseUsPhone(phone: string): { area: string; prefix: string; line: string } | null {
  const digits = phone.replace(/\D/g, "");
  let d = digits;
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  if (d.length !== 10) return null;
  return { area: d.slice(0, 3), prefix: d.slice(3, 6), line: d.slice(6) };
}

function parseCityState(location: string): { city: string; state: string } {
  const cleaned = location.replace(/\s*,?\s*USA\s*$/i, "").trim();
  const parts = cleaned.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return { city: parts[0], state: parts[1] };
  return { city: cleaned, state: "" };
}

function replaceTextNode(xml: string, from: string, to: string): string {
  if (!to) return xml;
  return xml.split(`<w:t>${from}</w:t>`).join(`<w:t>${esc(to)}</w:t>`);
}

function fillName(header: string, name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0] ?? TEMPLATE_NAME_FIRST;
  const last = parts.slice(1).join(" ") || TEMPLATE_NAME_LAST;
  let h = replaceTextNode(header, TEMPLATE_NAME_FIRST, first);
  h = replaceTextNode(h, TEMPLATE_NAME_LAST, last);
  return h;
}

function fillPhone(header: string, phone?: string): string {
  if (!phone?.trim()) return header;
  const parsed = parseUsPhone(phone);
  if (!parsed) return header;
  let h = replaceTextNode(header, TEMPLATE_PHONE_AREA, parsed.area);
  h = replaceTextNode(h, TEMPLATE_PHONE_PREFIX, parsed.prefix);
  h = replaceTextNode(h, TEMPLATE_PHONE_LINE, parsed.line);
  return h;
}

function fillEmail(header: string, email?: string): string {
  if (!email?.trim()) return header;
  return replaceTextNode(header, TEMPLATE_EMAIL, email.trim());
}

function fillLocation(header: string, location?: string): string {
  if (!location?.trim()) return header;
  const { city, state } = parseCityState(location);
  let h = header;
  if (city) h = replaceTextNode(h, TEMPLATE_CITY, city);
  if (state) h = replaceTextNode(h, TEMPLATE_STATE, state);
  return h;
}

/** Force Calibri in header XML copied from template (template uses Inter). */
function applyCalibriFonts(xml: string): string {
  return xml
    .replace(/w:ascii="Inter"/g, 'w:ascii="Calibri"')
    .replace(/w:hAnsi="Inter"/g, 'w:hAnsi="Calibri"')
    .replace(/w:cs="Inter"/g, 'w:cs="Calibri"')
    .replace(/w:cstheme="minorHAnsi"/g, 'w:cs="Calibri"');
}

/** Build header XML by copying template2-header.xml and swapping contact fields. */
export function buildTemplateHeaderXml(data: ResumeData): string {
  let header = applyCalibriFonts(readHeaderTemplate());
  if (data.name) header = fillName(header, data.name);
  header = fillPhone(header, data.contact.phone);
  header = fillEmail(header, data.contact.email);
  header = fillLocation(header, data.contact.location);
  return header;
}

export const HEADER_EMAIL_REL = "rId7";
export const HEADER_LINKEDIN_REL = "rId9";

const DEFAULT_HEADER_LINKEDIN_URL = "https://www.linkedin.com/in/darius-c-bb25bb413";

export function headerHyperlinkTargets(contact: ResumeContact): { id: string; url: string }[] {
  const rels: { id: string; url: string }[] = [];
  if (contact.email?.trim()) {
    rels.push({ id: HEADER_EMAIL_REL, url: `mailto:${contact.email.trim()}` });
  }
  rels.push({ id: HEADER_LINKEDIN_REL, url: DEFAULT_HEADER_LINKEDIN_URL });
  return rels;
}
