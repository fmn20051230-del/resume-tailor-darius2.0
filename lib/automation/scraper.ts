import * as cheerio from "cheerio";
import { execFile } from "child_process";
import { unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
import { fetchIcimsJobHtml, renderPage, scrapeWorkdayJob } from "./browser";

const execFileAsync = promisify(execFile);

const NOT_FOUND_MARKERS = [
  "the page you are looking for doesn't exist",
  "job posting is no longer",
  "no longer accepting applications",
  "this job is no longer available",
  "position has been filled",
  "posting has expired",
  "404 not found",
];

function looksLikeNotFound(text: string): boolean {
  const lower = text.toLowerCase();
  return NOT_FOUND_MARKERS.some((m) => lower.includes(m));
}

const BOT_CHALLENGE_MARKERS = [
  "human verification",
  "confirm you are human",
  "verify you are human",
  "complete the security check",
  "please try again.before proceeding",
  "let's confirm you are human",
  "checking if the site connection is secure",
  "attention required",
  "cf-browser-verification",
  "cf-challenge",
  "just a moment...",
  "enable javascript and cookies to continue",
  "hcaptcha",
  "recaptcha",
];

function looksLikeBotChallenge(text: string): boolean {
  // Real job pages often embed reCAPTCHA widgets for Apply — don't treat those as blocks.
  if (
    text.includes("JobPosting") ||
    text.includes("iCIMS_Expandable_Text") ||
    text.includes("job_description")
  ) {
    return false;
  }

  const lower = text.toLowerCase();
  if (lower.includes("human verification") && lower.includes("complete the security check")) {
    return true;
  }
  if (/<title>\s*(human verification|just a moment\.{0,3})\s*<\/title>/i.test(text)) {
    return true;
  }
  return BOT_CHALLENGE_MARKERS.some((m) => lower.includes(m));
}

function isIcimsHost(hostname: string): boolean {
  return /(?:^|\.)icims\.com$/i.test(hostname);
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_BODY_CHARS = 80_000;
const FETCH_RETRIES = 1;

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

// iCIMS blocks the legacy Chrome/122 UA used by older scraper builds.
const ICIMS_HEADERS: Record<string, string> = {
  ...BROWSER_HEADERS,
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

const REMOVE_SELECTORS = [
  "script",
  "style",
  "noscript",
  "iframe",
  "svg",
  "nav",
  "footer",
  "header",
  "aside",
  ".cookie",
  ".cookies",
  "#cookie",
  "[class*='cookie']",
  "[id*='cookie']",
  "[class*='banner']",
  "[class*='popup']",
  "[class*='modal']",
].join(", ");

function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function htmlToText(html: string): string {
  if (!html) return "";
  const $ = cheerio.load(html);
  $("script, style").remove();
  return collapseWhitespace($.root().text());
}

function truncate(text: string): string {
  return text.length > MAX_BODY_CHARS ? text.slice(0, MAX_BODY_CHARS) : text;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= FETCH_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        ...init,
        headers: {
          ...BROWSER_HEADERS,
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
      clearTimeout(timeout);
      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastError =
        err instanceof Error && err.name === "AbortError"
          ? new Error(`Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`)
          : err instanceof Error
            ? err
            : new Error("Network request failed");
      if (attempt < FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
      }
    }
  }
  throw lastError ?? new Error("Network request failed");
}

// ---------- Fast API paths (no browser needed) ----------

// Greenhouse (boards.greenhouse.io / job-boards.greenhouse.io)
async function scrapeGreenhouse(parsed: URL): Promise<string | null> {
  if (!/greenhouse\.io$/i.test(parsed.hostname)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const jobsIdx = segments.indexOf("jobs");
  const board = segments[0];
  const jobId = jobsIdx >= 0 ? segments[jobsIdx + 1] : segments[segments.length - 1];
  if (!board || !jobId || !/^\d+$/.test(jobId)) return null;
  try {
    const api = `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${jobId}`;
    const res = await fetchWithTimeout(api, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      title?: string;
      location?: { name?: string };
      content?: string;
    };
    if (!data.content) return null;
    const decoded = data.content
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
    const text = collapseWhitespace(
      [
        data.title ? `Job Title: ${data.title}` : "",
        data.location?.name ? `Location: ${data.location.name}` : "",
        htmlToText(decoded),
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    return text.length >= 80 ? truncate(text) : null;
  } catch {
    return null;
  }
}

// Lever (jobs.lever.co)
async function scrapeLever(parsed: URL): Promise<string | null> {
  if (!/lever\.co$/i.test(parsed.hostname)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const company = segments[0];
  const postingId = segments[1];
  if (!company || !postingId) return null;
  try {
    const api = `https://api.lever.co/v0/postings/${company}/${postingId}`;
    const res = await fetchWithTimeout(api, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      text?: string;
      categories?: { location?: string };
      descriptionPlain?: string;
      description?: string;
      lists?: { text?: string; content?: string }[];
    };
    const lists = (data.lists ?? [])
      .map((l) => `${l.text ? l.text + ":\n" : ""}${htmlToText(l.content ?? "")}`)
      .join("\n\n");
    const body = [data.descriptionPlain || htmlToText(data.description ?? ""), lists]
      .filter(Boolean)
      .join("\n\n");
    if (!body.trim()) return null;
    const text = collapseWhitespace(
      [
        data.text ? `Job Title: ${data.text}` : "",
        data.categories?.location ? `Location: ${data.categories.location}` : "",
        body,
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    return text.length >= 80 ? truncate(text) : null;
  } catch {
    return null;
  }
}

// Ashby (jobs.ashbyhq.com or embedded ?ashby_jid= on company sites)
function formatAshbyJob(job: {
  title?: string;
  location?: string;
  department?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
}): string | null {
  const body = job.descriptionPlain || htmlToText(job.descriptionHtml ?? "");
  if (!body.trim()) return null;
  const text = collapseWhitespace(
    [
      job.title ? `Job Title: ${job.title}` : "",
      job.department ? `Department: ${job.department}` : "",
      job.location ? `Location: ${job.location}` : "",
      body,
    ]
      .filter(Boolean)
      .join("\n\n")
  );
  return text.length >= 80 ? truncate(text) : null;
}

async function fetchAshbyBoardJobs(board: string): Promise<
  {
    id?: string;
    title?: string;
    jobUrl?: string;
    location?: string;
    department?: string;
    descriptionPlain?: string;
    descriptionHtml?: string;
    isListed?: boolean;
  }[]
> {
  type AshbyJob = {
    id?: string;
    title?: string;
    jobUrl?: string;
    location?: string;
    department?: string;
    descriptionPlain?: string;
    descriptionHtml?: string;
    isListed?: boolean;
  };
  const api = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`;
  const res = await fetchWithTimeout(api, {
    headers: { ...BROWSER_HEADERS, Accept: "application/json" },
  });
  if (!res.ok) return [];
  const data = (await res.json()) as { jobs?: AshbyJob[] };
  return (data.jobs ?? []).filter((j) => j.isListed !== false);
}

function findAshbyJob(
  jobs: Awaited<ReturnType<typeof fetchAshbyBoardJobs>>,
  jobKey: string
) {
  const keyLower = jobKey.toLowerCase();
  return (
    jobs.find((job) => {
      if (job.id?.toLowerCase() === keyLower) return true;
      if (job.jobUrl?.toLowerCase().includes(keyLower)) return true;
      try {
        return new URL(job.jobUrl ?? "").pathname.toLowerCase().includes(keyLower);
      } catch {
        return false;
      }
    }) ?? null
  );
}

async function discoverAshbyBoardFromPage(pageUrl: string): Promise<string | null> {
  try {
    const html =
      (await fetchHtmlWithCurl(pageUrl)) ||
      (await (async () => {
        const res = await fetchWithTimeout(pageUrl);
        return res.ok ? await res.text() : null;
      })());
    if (!html) return null;
    const match =
      html.match(/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i) ||
      html.match(/ashbyBaseJobBoardUrl["']?\s*[:=]\s*["']https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_-]+)/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function scrapeAshby(parsed: URL, rawUrl = parsed.toString()): Promise<string | null> {
  const ashbyJid =
    parsed.searchParams.get("ashby_jid") ||
    parsed.searchParams.get("ashbyId") ||
    parsed.searchParams.get("jid");

  // Direct Ashby host: /{board}/{jobId}
  if (/ashbyhq\.com$/i.test(parsed.hostname)) {
    const segments = parsed.pathname.split("/").filter(Boolean);
    const board = segments[0];
    const jobKey = segments[1] || ashbyJid;
    if (!board || !jobKey) return null;
    try {
      const jobs = await fetchAshbyBoardJobs(board);
      const match = findAshbyJob(jobs, jobKey);
      return match ? formatAshbyJob(match) : null;
    } catch {
      return null;
    }
  }

  // Embedded Ashby widget on company career pages (?ashby_jid=...)
  if (!ashbyJid) return null;

  try {
    const board = await discoverAshbyBoardFromPage(rawUrl);
    if (!board) return null;
    const jobs = await fetchAshbyBoardJobs(board);
    const match = findAshbyJob(jobs, ashbyJid);
    return match ? formatAshbyJob(match) : null;
  } catch {
    return null;
  }
}

// Recruitee (*.recruitee.com/o/{slug})
async function scrapeRecruitee(parsed: URL): Promise<string | null> {
  if (!/recruitee\.com$/i.test(parsed.hostname)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  // /o/{slug} or /{slug}
  const slug =
    segments[0] === "o" || segments[0] === "offers" ? segments[1] : segments[0];
  if (!slug) return null;

  try {
    const api = `${parsed.origin}/api/offers/${encodeURIComponent(slug)}`;
    const res = await fetchWithTimeout(api, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      offer?: {
        title?: string;
        company_name?: string;
        location?: string;
        city?: string;
        country?: string;
        remote?: boolean;
        department?: string;
        description?: string;
        requirements?: string;
        sharing_title?: string;
      };
    };
    const offer = data.offer;
    if (!offer) return null;

    const description = htmlToText(offer.description ?? "");
    const requirements = htmlToText(offer.requirements ?? "");
    const body = [description, requirements ? `Requirements:\n${requirements}` : ""]
      .filter(Boolean)
      .join("\n\n");
    if (!body.trim()) return null;

    const location =
      offer.location ||
      [offer.city, offer.country].filter(Boolean).join(", ") ||
      "";

    const text = collapseWhitespace(
      [
        offer.title || offer.sharing_title
          ? `Job Title: ${offer.title || offer.sharing_title}`
          : "",
        offer.company_name ? `Company: ${offer.company_name}` : "",
        offer.department ? `Department: ${offer.department}` : "",
        location
          ? `Location: ${location}${offer.remote ? " (Remote)" : ""}`
          : offer.remote
            ? "Location: Remote"
            : "",
        body,
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    return text.length >= 80 ? truncate(text) : null;
  } catch {
    return null;
  }
}

// SmartRecruiters (jobs.smartrecruiters.com)
async function scrapeSmartRecruiters(parsed: URL): Promise<string | null> {
  if (!/smartrecruiters\.com$/i.test(parsed.hostname)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const company = segments[0];
  const postingId = segments[1];
  if (!company || !postingId) return null;

  try {
    const api = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(company)}/postings/${encodeURIComponent(postingId)}`;
    const res = await fetchWithTimeout(api, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      name?: string;
      company?: { name?: string };
      location?: { city?: string; region?: string; country?: string; remote?: boolean };
      jobAd?: { sections?: { title?: string; text?: string }[] };
    };

    const sections = (data.jobAd?.sections ?? [])
      .map((s) => (s.title ? `${s.title}:\n${htmlToText(s.text ?? "")}` : htmlToText(s.text ?? "")))
      .filter(Boolean)
      .join("\n\n");
    if (!sections.trim()) return null;

    const loc = data.location;
    const locationParts = [loc?.city, loc?.region, loc?.country].filter(Boolean).join(", ");

    const text = collapseWhitespace(
      [
        data.name ? `Job Title: ${data.name}` : "",
        data.company?.name ? `Company: ${data.company.name}` : "",
        locationParts ? `Location: ${locationParts}${loc?.remote ? " (Remote)" : ""}` : "",
        sections,
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    return text.length >= 80 ? truncate(text) : null;
  } catch {
    return null;
  }
}

// Eightfold (*.eightfold.ai) — public apply API avoids CAPTCHA on careers SPA.
async function scrapeEightfold(parsed: URL): Promise<string | null> {
  if (!/eightfold\.ai$/i.test(parsed.hostname)) return null;

  const pid =
    parsed.searchParams.get("pid") ||
    parsed.pathname.match(/\/(?:careers\/)?(?:job|position|pid)\/(\d+)/i)?.[1] ||
    parsed.pathname.match(/\/(\d{5,})(?:\/|$)/)?.[1];
  if (!pid) return null;

  try {
    const api = `${parsed.origin}/api/apply/v2/jobs/${encodeURIComponent(pid)}`;
    const res = await fetchWithTimeout(api, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      name?: string;
      posting_name?: string;
      location?: string;
      locations?: string[];
      department?: string;
      business_unit?: string;
      job_description?: string;
    };
    const body = htmlToText(data.job_description ?? "");
    if (!body.trim()) return null;

    const location =
      (Array.isArray(data.locations) && data.locations[0]) || data.location || "";
    const title = data.name || data.posting_name || "";
    const companyGuess = parsed.hostname.split(".")[0]?.replace(/-/g, " ");

    const text = collapseWhitespace(
      [
        title ? `Job Title: ${title}` : "",
        companyGuess ? `Company: ${companyGuess}` : "",
        data.department ? `Department: ${data.department}` : "",
        data.business_unit ? `Business Unit: ${data.business_unit}` : "",
        location ? `Location: ${location}` : "",
        body,
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    return text.length >= 80 ? truncate(text) : null;
  } catch {
    return null;
  }
}

// TTC Portals / Jobvite career sites (*.ttcportals.com) — Cloudflare blocks Node fetch;
// curl + JSON-LD JobPosting usually works.
async function scrapeTtcPortals(parsed: URL, rawUrl: string): Promise<string | null> {
  if (!/ttcportals\.com$/i.test(parsed.hostname)) return null;

  const curlHtml = await fetchHtmlWithCurl(rawUrl);
  if (curlHtml && !looksLikeBotChallenge(curlHtml)) {
    const fromLd = extractJsonLdJobPostingFromRaw(curlHtml);
    if (fromLd) return fromLd;
    const generic = extractFromHtml(curlHtml);
    if (generic) return generic;
  }

  try {
    const res = await fetchWithTimeout(rawUrl);
    const html = await res.text();
    if (!looksLikeBotChallenge(html)) {
      const fromLd = extractJsonLdJobPostingFromRaw(html);
      if (fromLd) return fromLd;
      const generic = extractFromHtml(html);
      if (generic) return generic;
    }
  } catch {
    // fall through
  }

  return null;
}

/** curl often bypasses bot filters that block Node's fetch (Cloudflare, iCIMS, etc.). */
async function fetchHtmlWithCurl(
  url: string,
  extraHeaders: string[] = []
): Promise<string | null> {
  const curlBin = process.platform === "win32" ? "curl.exe" : "curl";
  const cookieFile = join(
    tmpdir(),
    `resume-tailor-curl-${process.pid}-${Date.now()}.txt`
  );

  const runOnce = async (): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(
        curlBin,
        [
          "-sL",
          "--compressed",
          "-c",
          cookieFile,
          "-b",
          cookieFile,
          "-A",
          BROWSER_HEADERS["User-Agent"],
          "-H",
          "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "-H",
          `Accept-Language: ${BROWSER_HEADERS["Accept-Language"]}`,
          "-H",
          "Sec-Fetch-Dest: document",
          "-H",
          "Sec-Fetch-Mode: navigate",
          "-H",
          "Upgrade-Insecure-Requests: 1",
          ...extraHeaders,
          url,
        ],
        { maxBuffer: 12 * 1024 * 1024 }
      );
      return stdout?.trim() ? stdout : null;
    } catch {
      return null;
    }
  };

  try {
    let html = await runOnce();
    // Cloudflare often needs a cookie handshake: first response is the
    // interstitial, second request with the jar returns the real page.
    if (html && looksLikeBotChallenge(html)) {
      await new Promise((r) => setTimeout(r, 2500));
      html = await runOnce();
    }
    return html;
  } finally {
    await unlink(cookieFile).catch(() => {});
  }
}

// iCIMS (careers-*.icims.com) — HTTP fetch + browser session + curl fallback.
async function fetchIcimsWithCurl(url: string, origin: string): Promise<string | null> {
  return fetchHtmlWithCurl(url, [
    "-H",
    `Referer: ${origin}/jobs/intro?in_iframe=1`,
  ]);
}

function extractJsonLdJobPostingFromRaw(html: string): string | null {
  try {
    const $ = cheerio.load(html);
    const fromCheerio = extractJsonLdJobPosting($);
    if (fromCheerio) return fromCheerio;
  } catch {
    // fall through to regex
  }

  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as {
        "@type"?: string | string[];
        title?: string;
        description?: string;
        hiringOrganization?: { name?: string };
      };
      const type = parsed["@type"];
      const isJob = Array.isArray(type) ? type.includes("JobPosting") : type === "JobPosting";
      if (!isJob || !parsed.description) continue;
      const text = collapseWhitespace(
        [
          parsed.title ? `Job Title: ${htmlToText(parsed.title)}` : "",
          parsed.hiringOrganization?.name
            ? `Company: ${htmlToText(parsed.hiringOrganization.name)}`
            : "",
          htmlToText(parsed.description),
        ]
          .filter(Boolean)
          .join("\n\n")
      );
      if (text.length >= 80) return text;
    } catch {
      continue;
    }
  }
  return null;
}

function extractIcimsInlineMeta(html: string): string[] {
  const parts: string[] = [];
  const sdMatch = html.match(/var\s+icimsSD\s*=\s*(\{[\s\S]*?\});/);
  if (sdMatch) {
    try {
      const sd = JSON.parse(sdMatch[1]) as {
        companyName?: string;
        job?: { title?: string; location?: string };
      };
      if (sd.job?.title) parts.push(`Job Title: ${sd.job.title}`);
      if (sd.companyName) parts.push(`Company: ${sd.companyName}`);
      if (sd.job?.location) parts.push(`Location: ${sd.job.location}`);
    } catch {
      // ignore
    }
  }
  return parts;
}

function extractIcimsPageBody(html: string): string | null {
  const meta = extractIcimsInlineMeta(html);
  const $ = cheerio.load(html);
  const sections: string[] = [...meta];
  $(".iCIMS_Expandable_Text").each((_, el) => {
    const text = collapseWhitespace($(el).text());
    if (text.length >= 40) sections.push(text);
  });
  const combined = collapseWhitespace(sections.join("\n\n"));
  return combined.length >= 120 ? combined : null;
}

function extractIcimsContent(html: string): string | null {
  if (!html.trim() || looksLikeBotChallenge(html)) return null;
  const jsonLd = extractJsonLdJobPostingFromRaw(html);
  if (jsonLd && !looksLikeBotChallenge(jsonLd)) return truncate(jsonLd);
  const icimsBody = extractIcimsPageBody(html);
  if (icimsBody && !looksLikeBotChallenge(icimsBody)) return truncate(icimsBody);
  const generic = extractFromHtml(html);
  if (generic && !looksLikeBotChallenge(generic)) return generic;
  return null;
}

function buildIcimsFetchUrls(parsed: URL, rawUrl: string): string[] {
  const segments = parsed.pathname.split("/").filter(Boolean);
  const jobsIdx = segments.indexOf("jobs");
  const jobId = jobsIdx >= 0 ? segments[jobsIdx + 1] : null;
  if (!jobId || !/^\d+$/.test(jobId)) return [];

  const origin = parsed.origin;
  const slug = segments[jobsIdx + 2];
  const iframeUrl = new URL(rawUrl);
  iframeUrl.searchParams.set("in_iframe", "1");
  iframeUrl.searchParams.delete("mobile");

  const urls = new Set<string>([
    `${origin}/jobs/${jobId}/job?in_iframe=1`,
    iframeUrl.toString().split("#")[0],
    rawUrl.includes("in_iframe=1") ? rawUrl.split("#")[0] : "",
  ]);
  if (slug && slug !== "job") {
    urls.add(`${origin}/jobs/${jobId}/${slug}/job?in_iframe=1`);
  }
  return Array.from(urls).filter(Boolean);
}

async function fetchIcimsHtmlViaHttp(url: string, origin: string): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(url, {
      headers: {
        ...ICIMS_HEADERS,
        Referer: `${origin}/jobs/intro?in_iframe=1`,
      },
    });
    const html = await res.text();
    if (looksLikeBotChallenge(html)) return null;
    if (html.includes("JobPosting") || html.includes("iCIMS_Expandable_Text")) return html;
    if (res.ok) return html;
    return null;
  } catch {
    return null;
  }
}

async function scrapeIcims(parsed: URL, rawUrl: string): Promise<string | null> {
  if (!isIcimsHost(parsed.hostname)) return null;
  const candidates = buildIcimsFetchUrls(parsed, rawUrl);
  if (!candidates.length) return null;

  const origin = parsed.origin;

  for (const candidate of candidates) {
    const curlHtml = await fetchIcimsWithCurl(candidate, origin);
    if (curlHtml) {
      const text = extractIcimsContent(curlHtml);
      if (text) return text;
    }

    const httpHtml = await fetchIcimsHtmlViaHttp(candidate, origin);
    if (httpHtml) {
      const text = extractIcimsContent(httpHtml);
      if (text) return text;
    }
  }

  try {
    const browserHtml = await fetchIcimsJobHtml(rawUrl);
    if (browserHtml) {
      const text = extractIcimsContent(browserHtml);
      if (text) return text;
    }
  } catch {
    // browser unavailable — fall through
  }

  return null;
}

// ---------- HTML extraction helpers ----------

function extractJsonLdJobPosting($: cheerio.CheerioAPI): string | null {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const script of scripts) {
    const raw = $(script).contents().text();
    if (!raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const candidate of candidates) {
      const node = candidate as {
        "@type"?: string | string[];
        "@graph"?: unknown[];
        title?: string;
        description?: string;
        hiringOrganization?: { name?: string };
      };
      const graph = Array.isArray(node["@graph"]) ? node["@graph"] : [node];
      for (const g of graph) {
        const item = g as typeof node;
        const type = item["@type"];
        const isJob = Array.isArray(type)
          ? type.includes("JobPosting")
          : type === "JobPosting";
        if (isJob && item.description) {
          const text = collapseWhitespace(
            [
              item.title ? `Job Title: ${htmlToText(item.title)}` : "",
              item.hiringOrganization?.name
                ? `Company: ${htmlToText(item.hiringOrganization.name)}`
                : "",
              htmlToText(item.description),
            ]
              .filter(Boolean)
              .join("\n\n")
          );
          if (text.length >= 80) return text;
        }
      }
    }
  }
  return null;
}

function pickMainText($: cheerio.CheerioAPI): string {
  // Phenom / careersmarketplace (e.g. jobs.slalom.com): labeled Job Description field.
  const labeledSections: string[] = [];
  let jobDescription = "";
  $(".article__content__view__field").each((_, el) => {
    const label = collapseWhitespace(
      $(el).find(".article__content__view__field__label").first().text()
    );
    const value = collapseWhitespace(
      $(el).find(".article__content__view__field__value").first().text()
    );
    if (!value || value.length < 40) return;
    if (/^job\s*description$/i.test(label) || /^description(\s+and\s+requirements)?$/i.test(label)) {
      jobDescription = value;
    } else if (!/^(locations?|date posted|ref|#|business function|category)$/i.test(label)) {
      labeledSections.push(`${label}:\n${value}`);
    }
  });
  if (jobDescription.length >= 200) {
    return collapseWhitespace(
      [jobDescription, ...labeledSections.filter((s) => s.length < 2000)].join("\n\n")
    );
  }

  const candidates = [
    "[data-automation-id='jobPostingDescription']",
    "[data-automation-id='job-posting-details']",
    ".article__content__view__field__value",
    "[class*='job-description']",
    "[class*='jobDescription']",
    "[class*='job_description']",
    "[id*='job-description']",
    "[id*='jobDescription']",
    "article",
    "main",
    "[role='main']",
    ".content",
    "#content",
  ];
  for (const selector of candidates) {
    const el = $(selector).first();
    if (el.length) {
      const text = collapseWhitespace(el.text());
      // Prefer real JD body over short sidebar metadata.
      if (text.length >= 400) return text;
    }
  }
  for (const selector of candidates) {
    const el = $(selector).first();
    if (el.length) {
      const text = collapseWhitespace(el.text());
      if (text.length >= 200) return text;
    }
  }
  return collapseWhitespace($("body").text());
}

function extractFromHtml(html: string, fallbackInnerText = ""): string | null {
  const $ = cheerio.load(html);

  const jsonLd = extractJsonLdJobPosting($);
  if (jsonLd) return truncate(jsonLd);

  const title = collapseWhitespace($("title").first().text());

  $(REMOVE_SELECTORS).remove();
  $("a").each((_, el) => {
    const linkText = $(el).text().trim();
    if (linkText) $(el).replaceWith(linkText);
    else $(el).remove();
  });

  const mainText = pickMainText($);
  const combined = collapseWhitespace(
    [title ? `Page Title: ${title}` : "", mainText].filter(Boolean).join("\n\n")
  );

  if (combined.length >= 120) return truncate(combined);

  const fallback = collapseWhitespace(fallbackInnerText);
  if (fallback.length >= 120) {
    return truncate(
      collapseWhitespace([title ? `Page Title: ${title}` : "", fallback].join("\n\n"))
    );
  }

  return null;
}

// ---------- Main entry ----------

/** Fix aggregator-mangled query values like jobId=2731%3Fsource%3Djobright → jobId=2731 */
export function normalizeJobUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    return rawUrl;
  }

  for (const [key, value] of Array.from(parsed.searchParams.entries())) {
    const decoded = (() => {
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    })();
    // Value accidentally contains another query string: "2731?source=jobright"
    if (/[?&]/.test(decoded)) {
      const cleaned = decoded.split(/[?&]/)[0]?.trim() || decoded;
      parsed.searchParams.set(key, cleaned);
      continue;
    }
    // Literal "%3F" left in the value
    if (/%3[fF]/.test(value)) {
      const cleaned = value.split(/%3[fF]/i)[0]?.trim() || value;
      parsed.searchParams.set(key, cleaned);
    }
  }

  return parsed.toString();
}

export async function scrapeJobPage(url: string): Promise<string> {
  const normalized = normalizeJobUrl(url);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("Invalid URL");
  }

  // Fast, reliable API paths first (no browser overhead).
  const greenhouse = await scrapeGreenhouse(parsed);
  if (greenhouse) return greenhouse;

  const lever = await scrapeLever(parsed);
  if (lever) return lever;

  const ashby = await scrapeAshby(parsed, normalized);
  if (ashby) return ashby;

  const recruitee = await scrapeRecruitee(parsed);
  if (recruitee) return recruitee;

  const smartRecruiters = await scrapeSmartRecruiters(parsed);
  if (smartRecruiters) return smartRecruiters;

  const eightfold = await scrapeEightfold(parsed);
  if (eightfold) return eightfold;

  if (/ttcportals\.com$/i.test(parsed.hostname)) {
    const ttc = await scrapeTtcPortals(parsed, normalized);
    if (ttc) return ttc;
    throw new Error(
      "Could not load this TTC Portals / Jobvite posting (Cloudflare blocked automated access). Open the URL in your browser, copy the job description, and paste it manually."
    );
  }

  if (isIcimsHost(parsed.hostname)) {
    const icims = await scrapeIcims(parsed, normalized);
    if (icims) return icims;
    throw new Error(
      "Could not load this iCIMS job posting automatically. iCIMS often blocks automated scrapers. Open the URL in your browser, copy the job description text, and paste it manually — or run: npm run setup:browser"
    );
  }

  // Workday: use a real browser session to reach its authenticated API.
  if (/\.myworkdayjobs\.com$/i.test(parsed.hostname)) {
    try {
      const wd = await scrapeWorkdayJob(normalized);
      if (wd.status === "ok") return wd.text;
      if (wd.status === "not_found") {
        throw new Error(
          "This Workday posting was not found — it has likely expired or been removed (the job ID no longer appears in this company's active listings)."
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Browser-missing errors fall through to the shared handler below.
      if (!/Executable doesn't exist|playwright install|Cannot find (?:module|package) 'playwright'/i.test(msg)) {
        throw err;
      }
    }
  }

  // Primary path: render with a real browser so JS-loaded content is present.
  try {
    const rendered = await renderPage(normalized);
    if (looksLikeBotChallenge(rendered.innerText) || looksLikeBotChallenge(rendered.html)) {
      // Headless browser blocked — try curl before giving up (works for many CF sites).
      const curlHtml = await fetchHtmlWithCurl(normalized);
      if (curlHtml && !looksLikeBotChallenge(curlHtml)) {
        const fromLd = extractJsonLdJobPostingFromRaw(curlHtml);
        if (fromLd) return fromLd;
        const fromHtml = extractFromHtml(curlHtml);
        if (fromHtml) return fromHtml;
      }
      throw new Error(
        "This job site blocked automated access with a human-verification (CAPTCHA) page. The URL works in a normal browser, but the server rejected the headless scraper."
      );
    }
    if (looksLikeNotFound(rendered.innerText)) {
      throw new Error(
        "This posting appears to be expired or removed (the page reports it no longer exists)."
      );
    }
    const text = extractFromHtml(rendered.html, rendered.innerText);
    if (text) return text;
    throw new Error(
      "Page loaded but no job description text was found. The posting may be expired, region-locked, or behind a login."
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // Browser missing → tell the user how to enable it, then try a plain fetch.
    if (
      /Executable doesn't exist|playwright install|Cannot find (?:module|package) 'playwright'|browserType\.launch/i.test(
        message
      )
    ) {
      const fallback = await plainFetchFallback(normalized).catch(() => null);
      if (fallback) return fallback;
      throw new Error(
        process.env.VERCEL
          ? "This job page needs a real browser to load (blocked or JS-rendered). Open the URL locally with Playwright, or paste the JD manually. Automation with headless Chrome works best via npm run dev on your machine."
          : "Headless browser not installed. Run: npx playwright install chromium (then restart the dev server)."
      );
    }

    // Other render errors → attempt a plain fetch before giving up.
    const fallback = await plainFetchFallback(normalized).catch(() => null);
    if (fallback) return fallback;
    throw new Error(message);
  }
}

async function plainFetchFallback(url: string): Promise<string | null> {
  const curlHtml = await fetchHtmlWithCurl(url);
  if (curlHtml && !looksLikeBotChallenge(curlHtml)) {
    const fromLd = extractJsonLdJobPostingFromRaw(curlHtml);
    if (fromLd) return fromLd;
    const fromHtml = extractFromHtml(curlHtml);
    if (fromHtml) return fromHtml;
  }

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Page returned HTTP ${res.status} ${res.statusText}`);
  const html = await res.text();
  if (!html.trim()) throw new Error("Page returned empty content");
  if (looksLikeBotChallenge(html)) return null;
  const fromLd = extractJsonLdJobPostingFromRaw(html);
  if (fromLd) return fromLd;
  return extractFromHtml(html);
}
