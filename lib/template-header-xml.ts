import type { ResumeContact, ResumeData } from "./parse-resume-markdown";
import { DARIUS_EMAIL, DARIUS_LOCATION, DARIUS_PHONE } from "./darius-profile";
import { extractHeaderFromTemplate } from "./template-sections-xml";

const TEMPLATE_FULL_NAME = "Darius Campbell";
const TEMPLATE_NAME_FIRST = "Darius";
const TEMPLATE_NAME_LAST = "Campbell";
const TEMPLATE_PHONE_AREA = "872";
const TEMPLATE_PHONE_PREFIX = "234";
const TEMPLATE_PHONE_LINE = "8844";
const TEMPLATE_EMAIL = DARIUS_EMAIL;
const TEMPLATE_CITY = "Leander";
const TEMPLATE_STATE = "TX";

function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  const full = name.trim() || TEMPLATE_FULL_NAME;
  let h = replaceTextNode(header, TEMPLATE_FULL_NAME, full);
  const parts = full.split(/\s+/).filter(Boolean);
  const first = parts[0] ?? TEMPLATE_NAME_FIRST;
  const last = parts.slice(1).join(" ") || TEMPLATE_NAME_LAST;
  h = replaceTextNode(h, TEMPLATE_NAME_FIRST, first);
  h = replaceTextNode(h, TEMPLATE_NAME_LAST, last);
  return h;
}

function fillPhone(header: string, phone: string): string {
  const parsed = parseUsPhone(phone);
  if (!parsed) return header;
  let h = replaceTextNode(header, TEMPLATE_PHONE_AREA, parsed.area);
  h = replaceTextNode(h, TEMPLATE_PHONE_PREFIX, parsed.prefix);
  h = replaceTextNode(h, TEMPLATE_PHONE_LINE, parsed.line);
  return h;
}

function fillEmail(header: string, email: string): string {
  return replaceTextNode(header, TEMPLATE_EMAIL, email.trim());
}

function fillLocation(header: string, location: string): string {
  const { city, state } = parseCityState(location);
  let h = header;
  if (city) h = replaceTextNode(h, TEMPLATE_CITY, city);
  if (state) h = replaceTextNode(h, TEMPLATE_STATE, state);
  return h;
}

/** Build header from template 3-column table and apply canonical contact fields. */
export function buildTemplateHeaderXml(data: ResumeData): string {
  let header = extractHeaderFromTemplate();
  if (data.name) header = fillName(header, data.name);
  header = fillPhone(header, DARIUS_PHONE);
  header = fillEmail(header, DARIUS_EMAIL);
  header = fillLocation(header, DARIUS_LOCATION);
  return header;
}

export const HEADER_LINKEDIN_REL = "rId8";

const DEFAULT_HEADER_LINKEDIN_URL = "https://www.linkedin.com/in/darius-c-bb25bb413";

export function headerHyperlinkTargets(_contact: ResumeContact): { id: string; url: string }[] {
  return [{ id: HEADER_LINKEDIN_REL, url: DEFAULT_HEADER_LINKEDIN_URL }];
}
