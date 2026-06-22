import {
  Document,
  Paragraph,
  TextRun,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  BorderStyle,
  sectionPageSizeDefaults,
  AlignmentType,
  TabStopType,
  UnderlineType,
} from "docx";

type ParagraphChild = TextRun | ExternalHyperlink;

export type ChatResponse = {
  content: string;
  reasoning_details?: unknown;
  role?: string;
  finish_reason?: string;
};

const RUN_OPTS = { noProof: true } as const;
const FONT = "Calibri";
const SYMBOL_FONT = "Segoe UI Symbol";
const TEXT_COLOR = "0D0D0D";
const HYPERLINK_COLOR = "0563C1";
/** Content width with 0.5in margins on letter page (twips). */
const RIGHT_TAB_TWIPS = 10466;

const MONTH =
  "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)";

const DATE_RANGE_RE = new RegExp(
  `(${MONTH}\\.?\\s+\\d{4}\\s*[-–—]\\s*(?:Present|${MONTH}\\.?\\s+\\d{4}))`,
  "i"
);

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/;
const LOCATION_RE = /[A-Za-z .'-]+,\s*[A-Z]{2}(?:,\s*USA)?/;

type ResumeSection =
  | "header"
  | "summary"
  | "education"
  | "certifications"
  | "experience"
  | "skills"
  | "other";

/** User-adjustable DOCX styling derived from template1.docx */
export type DocxStyleConfig = {
  page: {
    marginTopIn: number;
    marginRightIn: number;
    marginBottomIn: number;
    marginLeftIn: number;
    marginHeaderIn: number;
    marginFooterIn: number;
    orientation: "portrait" | "landscape";
  };
  body: {
    fontSizePt: number;
    fontFamily: string;
    alignment: "left" | "center" | "right" | "both";
  };
  heading1: {
    fontSizePt: number;
    fontFamily: string;
    bold: boolean;
    spacingBeforePt: number;
    spacingAfterPt: number;
    alignment: "left" | "center" | "right" | "both";
  };
  heading2: {
    fontSizePt: number;
    fontFamily: string;
    bold: boolean;
    spacingBeforePt: number;
    spacingAfterPt: number;
    underline: boolean;
  };
  heading3: {
    fontSizePt: number;
    fontFamily: string;
    bold: boolean;
    spacingBeforePt: number;
    spacingAfterPt: number;
  };
  heading4: { fontSizePt: number; fontFamily: string; bold: boolean; spacingBeforePt: number; spacingAfterPt: number };
  heading5: { fontSizePt: number; fontFamily: string; bold: boolean; spacingBeforePt: number; spacingAfterPt: number };
  heading6: { fontSizePt: number; fontFamily: string; bold: boolean; spacingBeforePt: number; spacingAfterPt: number };
};

/** Defaults extracted from public/templates/template1.docx */
export const TEMPLATE_DOCX_STYLE: DocxStyleConfig = {
  page: {
    marginTopIn: 0.5,
    marginRightIn: 0.5,
    marginBottomIn: 0.5,
    marginLeftIn: 0.5,
    marginHeaderIn: 0.3,
    marginFooterIn: 0.3,
    orientation: "portrait",
  },
  body: {
    fontSizePt: 11,
    fontFamily: FONT,
    alignment: "both",
  },
  heading1: {
    fontSizePt: 26,
    fontFamily: FONT,
    bold: true,
    spacingBeforePt: 0,
    spacingAfterPt: 0,
    alignment: "center",
  },
  heading2: {
    fontSizePt: 14,
    fontFamily: FONT,
    bold: true,
    spacingBeforePt: 12,
    spacingAfterPt: 6,
    underline: true,
  },
  heading3: {
    fontSizePt: 14,
    fontFamily: FONT,
    bold: true,
    spacingBeforePt: 10,
    spacingAfterPt: 0,
  },
  heading4: { fontSizePt: 12, fontFamily: FONT, bold: true, spacingBeforePt: 8, spacingAfterPt: 3 },
  heading5: { fontSizePt: 11, fontFamily: FONT, bold: true, spacingBeforePt: 6, spacingAfterPt: 2 },
  heading6: { fontSizePt: 11, fontFamily: FONT, bold: true, spacingBeforePt: 5, spacingAfterPt: 2 },
};

function ptToHalfPoints(pt: number): number {
  return Math.round(pt * 2);
}

function ptToTwips(pt: number): number {
  return Math.round(pt * 20);
}

function run(
  text: string,
  opts: { bold?: boolean; italics?: boolean; underline?: boolean; font?: string; sizePt?: number } = {},
  styleConfig: DocxStyleConfig = TEMPLATE_DOCX_STYLE
): TextRun {
  return new TextRun({
    text,
    font: opts.font ?? styleConfig.body.fontFamily,
    color: TEXT_COLOR,
    bold: opts.bold,
    italics: opts.italics,
    underline: opts.underline ? { type: UnderlineType.SINGLE, color: TEXT_COLOR } : undefined,
    size: opts.sizePt ? ptToHalfPoints(opts.sizePt) : ptToHalfPoints(styleConfig.body.fontSizePt),
    ...RUN_OPTS,
  });
}

function stripMarkdownInline(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]+\)/g, "$1")
    .trim();
}

function parseInlineToRuns(text: string, styleConfig: DocxStyleConfig): TextRun[] {
  const runs: TextRun[] = [];
  if (!text.length) return [run("", {}, styleConfig)];

  const re = /\*\*([^*\n]+)\*\*|__([^_\n]+)__|\*([^*\n]+)\*|_([^_\n]+)_|`([^`\n]+)`/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastEnd) {
      runs.push(run(text.slice(lastEnd, m.index), {}, styleConfig));
    }
    if (m[1] !== undefined || m[2] !== undefined) {
      runs.push(run((m[1] ?? m[2])!, { bold: true }, styleConfig));
    } else if (m[3] !== undefined || m[4] !== undefined) {
      runs.push(run((m[3] ?? m[4])!, { italics: true }, styleConfig));
    } else if (m[5] !== undefined) {
      runs.push(run(m[5], {}, styleConfig));
    }
    lastEnd = re.lastIndex;
  }
  if (lastEnd < text.length) {
    runs.push(run(text.slice(lastEnd), {}, styleConfig));
  }
  return runs.length ? runs : [run(text, {}, styleConfig)];
}

function parseInlineToParagraphChildren(text: string, styleConfig: DocxStyleConfig): ParagraphChild[] {
  if (!text.length) return [run("", {}, styleConfig)];

  const result: ParagraphChild[] = [];
  const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(text)) !== null) {
    if (m.index > lastEnd) {
      result.push(...parseInlineToRuns(text.slice(lastEnd, m.index), styleConfig));
    }
    const linkText = m[1];
    let url = m[2].trim();
    if (url && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) url = "https://" + url;
    result.push(
      new ExternalHyperlink({
        children: [
          new TextRun({
            text: linkText,
            style: "Hyperlink",
            font: styleConfig.body.fontFamily,
            color: HYPERLINK_COLOR,
            underline: { type: UnderlineType.SINGLE, color: HYPERLINK_COLOR },
            size: ptToHalfPoints(styleConfig.body.fontSizePt),
            ...RUN_OPTS,
          }),
        ],
        link: url || "#",
      })
    );
    lastEnd = linkRe.lastIndex;
  }
  if (lastEnd < text.length) {
    result.push(...parseInlineToRuns(text.slice(lastEnd), styleConfig));
  }
  return result.length ? result : [run(text, {}, styleConfig)];
}

function normalizeSectionTitle(title: string): ResumeSection {
  const t = title.toLowerCase().replace(/[^a-z& ]/g, "").trim();
  if (t.includes("summary") || t.includes("profile")) return "summary";
  if (t.includes("education")) return "education";
  if (t.includes("license") || t.includes("certification")) return "certifications";
  if (t.includes("experience") || t.includes("employment")) return "experience";
  if (t.includes("skill")) return "skills";
  return "other";
}

function isContactLabel(line: string): boolean {
  const plain = stripMarkdownInline(line).toLowerCase();
  return plain === "contact information" || plain === "contact";
}

function isLikelyContactLine(line: string): boolean {
  const plain = stripMarkdownInline(line);
  if (EMAIL_RE.test(plain)) return true;
  if (PHONE_RE.test(plain) && plain.length < 100) return true;
  if (plain.includes("|") && (EMAIL_RE.test(plain) || PHONE_RE.test(plain) || LOCATION_RE.test(plain))) {
    return true;
  }
  return false;
}

type ContactParts = { location?: string; email?: string; phone?: string };

function parseContactLine(line: string): ContactParts {
  const parts = stripMarkdownInline(line)
    .split("|")
    .map((p) => p.trim())
    .filter(Boolean);

  const result: ContactParts = {};
  for (const part of parts) {
    if (!result.email && EMAIL_RE.test(part)) {
      result.email = part.match(EMAIL_RE)![0];
      continue;
    }
    if (!result.phone && PHONE_RE.test(part)) {
      result.phone = part.match(PHONE_RE)![0].trim();
      continue;
    }
    if (!result.location && LOCATION_RE.test(part)) {
      result.location = part.match(LOCATION_RE)![0];
      continue;
    }
    if (
      !result.location &&
      !EMAIL_RE.test(part) &&
      !PHONE_RE.test(part) &&
      part.length > 2 &&
      !/linkedin|github|http|www\./i.test(part)
    ) {
      result.location = part;
    }
  }
  return result;
}

/** Template header: centered name (26pt bold Calibri). */
function buildNameParagraph(name: string, styleConfig: DocxStyleConfig): Paragraph {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { after: 0 },
    children: [
      run(name, { bold: true, sizePt: styleConfig.heading1.fontSizePt, font: styleConfig.heading1.fontFamily }, styleConfig),
    ],
  });
}

/** Template header: centered contact row with icon prefixes. */
function buildContactParagraph(parts: ContactParts, fallbackLine: string, styleConfig: DocxStyleConfig): Paragraph {
  const children: ParagraphChild[] = [];
  const sizePt = styleConfig.body.fontSizePt;
  const bodyFont = styleConfig.body.fontFamily;

  if (parts.location) {
    children.push(run("🏠 ", { font: SYMBOL_FONT, sizePt }, styleConfig));
    children.push(run(`${parts.location}       `, { font: bodyFont, sizePt }, styleConfig));
  }
  if (parts.email) {
    children.push(run("✉", { font: SYMBOL_FONT, sizePt }, styleConfig));
    children.push(run(" ", { font: bodyFont, sizePt }, styleConfig));
    children.push(run(parts.email, { font: bodyFont, sizePt, underline: true }, styleConfig));
    children.push(run("      ", { font: bodyFont, sizePt }, styleConfig));
  }
  if (parts.phone) {
    children.push(run("📞", { font: SYMBOL_FONT, sizePt }, styleConfig));
    children.push(run(parts.phone, { font: bodyFont, sizePt }, styleConfig));
  }

  if (!children.length) {
    return new Paragraph({
      alignment: AlignmentType.CENTER,
      children: parseInlineToParagraphChildren(fallbackLine, styleConfig),
    });
  }

  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children,
  });
}

/** Split "University Name Sep 2004 - Apr 2010" or "**Title** Sep 2022 - Mar 2026" into left/right. */
function extractDateRangeFromLine(line: string): { left: string; right: string } | null {
  const pipeMatch = line.match(/^\*\*([^*]+)\*\*\s*[|–—-]\s*(.+)$/);
  if (pipeMatch) {
    const right = stripMarkdownInline(pipeMatch[2]);
    if (DATE_RANGE_RE.test(right)) {
      return { left: pipeMatch[1].trim(), right: right.match(DATE_RANGE_RE)![1] };
    }
  }

  const plain = stripMarkdownInline(line);
  const match = plain.match(DATE_RANGE_RE);
  if (!match || match.index === undefined) return null;

  const right = match[1].trim();
  const left = plain
    .slice(0, match.index)
    .replace(/\s*[|–—-]\s*$/, "")
    .trim();

  if (!left || left.length > 90) return null;
  return { left, right };
}

/** Template education/experience line: role/university left, period right-aligned. */
function buildTabAlignedParagraph(left: string, right: string, styleConfig: DocxStyleConfig): Paragraph {
  return new Paragraph({
    tabStops: [{ type: TabStopType.RIGHT, position: RIGHT_TAB_TWIPS }],
    children: [
      run(left, { bold: true }, styleConfig),
      run("\t", {}, styleConfig),
      run(right, { bold: true }, styleConfig),
    ],
  });
}

function buildSectionHeading(title: string, styleConfig: DocxStyleConfig): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    children: [run(title.toUpperCase(), { bold: true, sizePt: styleConfig.heading2.fontSizePt }, styleConfig)],
  });
}

function buildCompanyHeading(company: string, styleConfig: DocxStyleConfig): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    children: [run(company, { bold: true, sizePt: styleConfig.heading3.fontSizePt }, styleConfig)],
  });
}

function buildBulletParagraph(content: string, styleConfig: DocxStyleConfig): Paragraph {
  return new Paragraph({
    children: parseInlineToParagraphChildren(content, styleConfig),
    numbering: { reference: "template-bullet", level: 0 },
  });
}

function buildStylesFromConfig(cfg: DocxStyleConfig) {
  return {
    default: {
      document: {
        run: { size: ptToHalfPoints(cfg.body.fontSizePt), font: cfg.body.fontFamily, color: TEXT_COLOR },
        paragraph: { alignment: cfg.body.alignment as "left" | "center" | "right" | "both" },
      },
      heading1: {
        run: {
          size: ptToHalfPoints(cfg.heading1.fontSizePt),
          bold: cfg.heading1.bold,
          font: cfg.heading1.fontFamily,
          color: TEXT_COLOR,
        },
        paragraph: {
          alignment: cfg.heading1.alignment as "left" | "center" | "right" | "both",
          spacing: {
            before: ptToTwips(cfg.heading1.spacingBeforePt),
            after: ptToTwips(cfg.heading1.spacingAfterPt),
          },
        },
      },
      heading2: {
        run: {
          size: ptToHalfPoints(cfg.heading2.fontSizePt),
          bold: cfg.heading2.bold,
          font: cfg.heading2.fontFamily,
          color: TEXT_COLOR,
        },
        paragraph: {
          ...(cfg.heading2.underline
            ? { border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: TEXT_COLOR } } }
            : {}),
          spacing: {
            before: ptToTwips(cfg.heading2.spacingBeforePt),
            after: ptToTwips(cfg.heading2.spacingAfterPt),
          },
        },
      },
      heading3: {
        run: {
          size: ptToHalfPoints(cfg.heading3.fontSizePt),
          bold: cfg.heading3.bold,
          font: cfg.heading3.fontFamily,
          color: TEXT_COLOR,
        },
        paragraph: {
          spacing: {
            before: ptToTwips(cfg.heading3.spacingBeforePt),
            after: ptToTwips(cfg.heading3.spacingAfterPt),
          },
        },
      },
      heading4: {
        run: {
          size: ptToHalfPoints(cfg.heading4.fontSizePt),
          bold: cfg.heading4.bold,
          font: cfg.heading4.fontFamily,
          color: TEXT_COLOR,
        },
        paragraph: {
          spacing: { before: ptToTwips(cfg.heading4.spacingBeforePt), after: ptToTwips(cfg.heading4.spacingAfterPt) },
        },
      },
      heading5: {
        run: {
          size: ptToHalfPoints(cfg.heading5.fontSizePt),
          bold: cfg.heading5.bold,
          font: cfg.heading5.fontFamily,
          color: TEXT_COLOR,
        },
        paragraph: {
          spacing: { before: ptToTwips(cfg.heading5.spacingBeforePt), after: ptToTwips(cfg.heading5.spacingAfterPt) },
        },
      },
      heading6: {
        run: {
          size: ptToHalfPoints(cfg.heading6.fontSizePt),
          bold: cfg.heading6.bold,
          font: cfg.heading6.fontFamily,
          color: TEXT_COLOR,
        },
        paragraph: {
          spacing: { before: ptToTwips(cfg.heading6.spacingBeforePt), after: ptToTwips(cfg.heading6.spacingAfterPt) },
        },
      },
    },
    paragraphStyles: [
      {
        id: "Hyperlink",
        name: "Hyperlink",
        basedOn: "Normal",
        run: {
          font: cfg.body.fontFamily,
          color: HYPERLINK_COLOR,
          underline: { type: UnderlineType.SINGLE, color: HYPERLINK_COLOR },
        },
      },
    ],
  };
}

/** Convert markdown string to docx Paragraph[] using template1 layout rules. */
export function markdownToParagraphs(md: string, styleConfig: DocxStyleConfig = TEMPLATE_DOCX_STYLE): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = md.split(/\n/);
  let section: ResumeSection = "header";
  let expectContact = false;
  let expectRoleLine = false;
  let educationDateLineUsed = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimEnd();
    if (trimmed === "") continue;

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const rawContent = headingMatch[2].trim();

      if (level === 1) {
        expectContact = true;
        expectRoleLine = false;
        educationDateLineUsed = false;
        section = "header";
        paragraphs.push(buildNameParagraph(stripMarkdownInline(rawContent), styleConfig));
        continue;
      }

      if (level === 2) {
        section = normalizeSectionTitle(stripMarkdownInline(rawContent));
        expectContact = false;
        expectRoleLine = false;
        educationDateLineUsed = false;
        paragraphs.push(buildSectionHeading(stripMarkdownInline(rawContent), styleConfig));
        continue;
      }

      if (level === 3) {
        const company = stripMarkdownInline(rawContent.split("|")[0] ?? rawContent);
        expectRoleLine = section === "experience";
        educationDateLineUsed = false;
        paragraphs.push(buildCompanyHeading(company, styleConfig));
        continue;
      }

      paragraphs.push(
        new Paragraph({
          children: parseInlineToParagraphChildren(rawContent, styleConfig),
          heading:
            level === 4 ? HeadingLevel.HEADING_4 : level === 5 ? HeadingLevel.HEADING_5 : HeadingLevel.HEADING_6,
        })
      );
      continue;
    }

    if (expectContact) {
      if (isContactLabel(trimmed)) continue;
      if (isLikelyContactLine(trimmed)) {
        const contact = parseContactLine(trimmed);
        paragraphs.push(buildContactParagraph(contact, stripMarkdownInline(trimmed), styleConfig));
        expectContact = false;
        section = "summary";
        continue;
      }
      expectContact = false;
    }

    const ulMatch = trimmed.match(/^[\s]*[-*]\s+(.*)$/);
    if (ulMatch) {
      expectRoleLine = false;
      paragraphs.push(buildBulletParagraph(ulMatch[1], styleConfig));
      continue;
    }

    const tabLine = extractDateRangeFromLine(trimmed);
    if (tabLine) {
      if (section === "education" && !educationDateLineUsed) {
        paragraphs.push(buildTabAlignedParagraph(tabLine.left, tabLine.right, styleConfig));
        educationDateLineUsed = true;
        continue;
      }
      if (section === "experience" || expectRoleLine) {
        paragraphs.push(buildTabAlignedParagraph(tabLine.left, tabLine.right, styleConfig));
        expectRoleLine = false;
        continue;
      }
    }

    expectRoleLine = false;
    paragraphs.push(
      new Paragraph({
        children: parseInlineToParagraphChildren(trimmed, styleConfig),
      })
    );
  }

  return paragraphs;
}

export function buildDocFromResponse(data: ChatResponse, styleConfig: DocxStyleConfig = TEMPLATE_DOCX_STYLE): Document {
  const content = (data.content ?? "").trim();
  const children: Paragraph[] =
    content.length > 0
      ? markdownToParagraphs(content, styleConfig)
      : [new Paragraph({ children: [run("(No content)", {}, styleConfig)] })];

  const page = styleConfig.page;
  const marginIn = (v: number): `${number}in` => `${v}in` as `${number}in`;
  const isLandscape = page.orientation === "landscape";
  const pageWidth = isLandscape ? sectionPageSizeDefaults.HEIGHT : sectionPageSizeDefaults.WIDTH;
  const pageHeight = isLandscape ? sectionPageSizeDefaults.WIDTH : sectionPageSizeDefaults.HEIGHT;

  return new Document({
    styles: buildStylesFromConfig(styleConfig),
    numbering: {
      config: [
        {
          reference: "template-bullet",
          levels: [
            {
              level: 0,
              format: LevelFormat.BULLET,
              text: "•",
              alignment: AlignmentType.LEFT,
              style: {
                paragraph: {
                  indent: { left: 360, hanging: 180 },
                },
                run: {
                  font: styleConfig.body.fontFamily,
                  size: ptToHalfPoints(styleConfig.body.fontSizePt),
                  color: TEXT_COLOR,
                },
              },
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: pageWidth,
              height: pageHeight,
              orientation: sectionPageSizeDefaults.ORIENTATION,
            },
            margin: {
              top: marginIn(page.marginTopIn),
              right: marginIn(page.marginRightIn),
              bottom: marginIn(page.marginBottomIn),
              left: marginIn(page.marginLeftIn),
              header: marginIn(page.marginHeaderIn),
              footer: marginIn(page.marginFooterIn),
              gutter: "0in" as const,
            },
          },
        },
        children,
      },
    ],
  });
}
