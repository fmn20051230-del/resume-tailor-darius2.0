import { sanitizeFolderSegment } from "./folder-output";

/** Turn slug/tenant into readable folder segment. */
export function humanizeSlug(text: string): string {
  return text
    .replace(/[_]+/g, " ")
    .replace(/-/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanTitleSuffix(value: string): string {
  return value
    .replace(/\s*[-|]\s*(careers?|jobs?|apply now|job details?).*$/i, "")
    .replace(/\s+at\s+.+$/i, "")
    .trim();
}

function extractPageTitle(rawJd: string): string {
  const match = rawJd.match(/^Page Title:\s*(.+)$/im);
  return match?.[1]?.trim() ?? "";
}

function splitPageTitle(pageTitle: string): { company: string; position: string } {
  if (!pageTitle) return { company: "", position: "" };

  const cleaned = pageTitle
    .replace(/\s+/g, " ")
    .replace(/\s*[-|]\s*(careers?|jobs?|apply now|job details?)\s*$/i, "")
    .trim();

  const patterns: RegExp[] = [
    /^(.+?)\s+at\s+(.+)$/i,
    /^(.+?)\s*[-|]\s*(.+?)\s*(?:careers?|jobs?|apply now|job details?)?$/i,
  ];

  for (const pattern of patterns) {
    const match = cleaned.match(pattern);
    if (!match) continue;
    const left = cleanTitleSuffix(match[1]);
    const right = cleanTitleSuffix(match[2]);
    if (left && right) {
      return {
        position: left,
        company: right,
      };
    }
  }

  return { company: "", position: cleanTitleSuffix(cleaned) };
}

export function extractCompanyFromRawJd(rawJd: string): string {
  const patterns = [
    /^Company:\s*(.+)$/im,
    /^Employer:\s*(.+)$/im,
    /^Organization:\s*(.+)$/im,
    /^Company Name:\s*(.+)$/im,
    /Company:\s*([^|\n]+?)(?:\s+Job Description|\s*\||\s*$)/im,
  ];
  for (const re of patterns) {
    const m = rawJd.match(re);
    const val = m?.[1]?.trim();
    if (val && val.length >= 2 && val.length <= 120) return val.split(/\||\n/)[0].trim();
  }
  const fromPageTitle = splitPageTitle(extractPageTitle(rawJd)).company;
  if (fromPageTitle && fromPageTitle.length <= 120) return fromPageTitle;
  return "";
}

export function extractPositionFromRawJd(rawJd: string): string {
  const pageTitle = extractPageTitle(rawJd);
  const splitTitle = splitPageTitle(pageTitle).position;
  if (splitTitle && splitTitle.length >= 3 && splitTitle.length <= 120) return splitTitle;

  const patterns = [
    /^Job Title:\s*(.+)$/im,
    /^Page Title:\s*(.+)$/im,
    /^Position:\s*(.+)$/im,
    /^Role:\s*(.+)$/im,
    /^Position Name:\s*(.+)$/im,
  ];
  for (const re of patterns) {
    const m = rawJd.match(re);
    let val = m?.[1]?.trim();
    if (!val) continue;
    val = val.split(/\||\n/)[0].trim();
    val = cleanTitleSuffix(val);
    if (val.length >= 3 && val.length <= 120) return val;
  }
  return "";
}

export function extractFromJobUrl(url: string): { company: string; position: string } {
  let company = "";
  let position = "";
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (host.includes("myworkdayjobs.com")) {
      const tenant = host.split(".")[0];
      if (tenant && tenant !== "www") {
        company = humanizeSlug(tenant);
      }
      const jobIdx = segments.indexOf("job");
      if (jobIdx >= 0 && segments[jobIdx + 2]) {
        const slug = segments[jobIdx + 2];
        position = humanizeSlug(slug.replace(/_[A-Z]{2}_[0-9]+$/i, "").replace(/_JR_[0-9]+$/i, ""));
      }
    } else if (host.includes("greenhouse.io") && segments[0]) {
      company = humanizeSlug(segments[0]);
      const jobsIdx = segments.indexOf("jobs");
      if (jobsIdx >= 0 && segments[jobsIdx + 1]) {
        position = "Job " + segments[jobsIdx + 1];
      }
    } else if (host.includes("lever.co") && segments[0]) {
      company = humanizeSlug(segments[0]);
      if (segments[1]) position = humanizeSlug(segments[1]);
    } else if (host.includes("linkedin.com")) {
      const titleIdx = segments.indexOf("view");
      if (titleIdx >= 0 && segments[titleIdx + 1]) {
        position = humanizeSlug(decodeURIComponent(segments[titleIdx + 1]));
      }
    } else {
      const hostParts = host.replace(/^www\./, "").split(".");
      if (hostParts.length >= 2) {
        company = humanizeSlug(hostParts[0]);
      }
    }
  } catch {
    // ignore
  }
  return { company, position };
}

/** Scan full extraction response for labelled company / position values. */
export function scanExtractionTextForMeta(raw: string): { company: string; position: string } {
  let company = "";
  let position = "";

  const companyPatterns = [
    /(?:company\s*name|company|employer)\s*[:|=\-–—]\s*([^\n]+)/i,
    /(?:company\s*name|company)\s*\n+\s*([^\n#*]+)/i,
  ];
  const positionPatterns = [
    /(?:position\s*name|job\s*title|position|role\s*title)\s*[:|=\-–—]\s*([^\n]+)/i,
    /(?:position\s*name|job\s*title|position)\s*\n+\s*([^\n#*]+)/i,
  ];

  for (const re of companyPatterns) {
    const m = raw.match(re);
    const val = m?.[1]?.trim().replace(/^\*\*|\*\*$/g, "");
    if (val && val.length >= 2 && val.length <= 120 && !/^(unknown|n\/a)$/i.test(val)) {
      company = val.split(/\n/)[0].trim();
      break;
    }
  }

  for (const re of positionPatterns) {
    const m = raw.match(re);
    const val = m?.[1]?.trim().replace(/^\*\*|\*\*$/g, "");
    if (val && val.length >= 3 && val.length <= 120 && !/^(unknown|n\/a)$/i.test(val)) {
      position = val.split(/\n/)[0].trim();
      break;
    }
  }

  return { company, position };
}

export function resolveCompanyAndPosition(options: {
  parsedCompany?: string;
  parsedPosition?: string;
  parsedTitle?: string;
  rawExtraction?: string;
  rawJd?: string;
  jobUrl?: string;
}): { companyName: string; positionName: string } {
  const isUnknown = (s: string) =>
    !s.trim() ||
    /^unknown[_\s-]*(company|position)?$/i.test(s.trim()) ||
    /^n\/a$/i.test(s.trim());

  let company = (options.parsedCompany ?? "").trim();
  let position = (options.parsedPosition ?? "").trim();

  if (isUnknown(company) || isUnknown(position)) {
    const scanned = scanExtractionTextForMeta(options.rawExtraction ?? "");
    if (isUnknown(company) && scanned.company) company = scanned.company;
    if (isUnknown(position) && scanned.position) position = scanned.position;
  }

  if (isUnknown(company) || isUnknown(position)) {
    const fromJd = {
      company: extractCompanyFromRawJd(options.rawJd ?? ""),
      position: extractPositionFromRawJd(options.rawJd ?? ""),
    };
    if (isUnknown(company) && fromJd.company) company = fromJd.company;
    if (isUnknown(position) && fromJd.position) position = fromJd.position;
  }

  if (isUnknown(position) && options.parsedTitle?.trim()) {
    position = options.parsedTitle.trim();
  }

  if (isUnknown(company) || isUnknown(position)) {
    const fromUrl = extractFromJobUrl(options.jobUrl ?? "");
    if (isUnknown(company) && fromUrl.company) company = fromUrl.company;
    if (isUnknown(position) && fromUrl.position) position = fromUrl.position;
  }

  return {
    companyName: sanitizeFolderSegment(company || "Company", 60) || "Company",
    positionName: sanitizeFolderSegment(position || "Position", 60) || "Position",
  };
}
