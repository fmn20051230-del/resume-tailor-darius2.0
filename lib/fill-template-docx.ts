import fs from "fs";
import path from "path";
import PizZip from "pizzip";
import { parseResumeMarkdown } from "./parse-resume-markdown";
import { buildDocumentBodyXml, buildHyperlinkRels, type HyperlinkRel } from "./template-docx-xml";
import { buildTemplateHeaderXml } from "./template-header-xml";

const TEMPLATE_PATH = path.join(process.cwd(), "lib", "templates", "template2.docx");

const HYPERLINK_TYPE =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";

function escapeTarget(url: string): string {
  return url
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildRelsXml(originalXml: string, hyperlinks: HyperlinkRel[]): string {
  const updates = new Map(hyperlinks.map((h) => [h.id, h.url]));
  const usedIds = new Set<string>();

  const kept = Array.from(
    originalXml.matchAll(/<Relationship Id="([^"]+)" Type="([^"]+)" Target="([^"]+)"(?: TargetMode="([^"]+)")?\/>/g)
  )
    .map((m) => {
      if (m[2].includes("hyperlink")) {
        if (updates.has(m[1])) {
          usedIds.add(m[1]);
          return `<Relationship Id="${m[1]}" Type="${HYPERLINK_TYPE}" Target="${escapeTarget(updates.get(m[1])!)}" TargetMode="External"/>`;
        }
        // Keep template hyperlinks still referenced by the header (e.g. rId9 LinkedIn).
        return `<Relationship Id="${m[1]}" Type="${m[2]}" Target="${m[3]}"${m[4] ? ` TargetMode="${m[4]}"` : ""}/>`;
      }
      return `<Relationship Id="${m[1]}" Type="${m[2]}" Target="${m[3]}"${m[4] ? ` TargetMode="${m[4]}"` : ""}/>`;
    });

  const newLinks = hyperlinks
    .filter((h) => !usedIds.has(h.id))
    .map(
      (h) =>
        `<Relationship Id="${h.id}" Type="${HYPERLINK_TYPE}" Target="${escapeTarget(h.url)}" TargetMode="External"/>`
    );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${kept.join("")}${newLinks.join("")}</Relationships>`;
}

function injectBody(templateDocXml: string, bodyInner: string): string {
  const sectMatch = templateDocXml.match(/<w:sectPr[\s\S]*?<\/w:sectPr>/);
  if (!sectMatch) throw new Error("Template missing sectPr");
  const openMatch = templateDocXml.match(/^[\s\S]*?<w:body>/);
  if (!openMatch) throw new Error("Template missing body");
  return `${openMatch[0]}${bodyInner}${sectMatch[0]}</w:body></w:document>`;
}

export function fillTemplateDocx(markdown: string, baseResume?: string): Buffer {
  if (!fs.existsSync(TEMPLATE_PATH)) {
    throw new Error("template2.docx not found in lib/templates");
  }

  const zip = new PizZip(fs.readFileSync(TEMPLATE_PATH));
  const data = parseResumeMarkdown(markdown, baseResume);
  const { certLinks, rels } = buildHyperlinkRels(data);
  const headerXml = buildTemplateHeaderXml(data);
  const contentXml = buildDocumentBodyXml(data, certLinks);
  const bodyInner = headerXml + contentXml;

  const templateDoc = zip.file("word/document.xml")!.asText();
  zip.file("word/document.xml", injectBody(templateDoc, bodyInner));

  const relsPath = "word/_rels/document.xml.rels";
  zip.file(relsPath, buildRelsXml(zip.file(relsPath)!.asText(), rels));

  return zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}
