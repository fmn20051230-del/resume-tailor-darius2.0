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
    text.includes("job_description") ||
    text.includes('id="job-description"') ||
    text.includes("id='job-description'") ||
    text.includes("jobDescriptionHeader") ||
    text.includes("__NEXT_DATA__")
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

/** Decode Greenhouse job HTML content field into plain text. */
function formatGreenhouseJob(data: {
  title?: string;
  location?: { name?: string };
  content?: string;
  company_name?: string;
}): string | null {
  if (!data.content) return null;
  const decoded = data.content
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
  const text = collapseWhitespace(
    [
      data.title ? `Job Title: ${data.title}` : "",
      data.company_name ? `Company: ${data.company_name}` : "",
      data.location?.name ? `Location: ${data.location.name}` : "",
      htmlToText(decoded),
    ]
      .filter(Boolean)
      .join("\n\n")
  );
  return text.length >= 80 ? truncate(text) : null;
}

async function fetchGreenhouseJobByBoard(
  board: string,
  jobId: string
): Promise<{ text: string | null; notFound: boolean }> {
  const api = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}`;
  try {
    const res = await fetchWithTimeout(api, {
      headers: { ...BROWSER_HEADERS, Accept: "application/json" },
    });
    if (res.status === 404) return { text: null, notFound: true };
    if (!res.ok) return { text: null, notFound: false };
    const data = (await res.json()) as {
      title?: string;
      location?: { name?: string };
      content?: string;
      company_name?: string;
    };
    return { text: formatGreenhouseJob(data), notFound: false };
  } catch {
    return { text: null, notFound: false };
  }
}

function extractGreenhouseJobId(parsed: URL): string | null {
  const fromQuery =
    parsed.searchParams.get("gh_jid") ||
    parsed.searchParams.get("gh_jid ") ||
    parsed.searchParams.get("jobId") ||
    parsed.searchParams.get("job_id");
  if (fromQuery && /^\d+$/.test(fromQuery.trim())) return fromQuery.trim();

  const segments = parsed.pathname.split("/").filter(Boolean);
  const jobsIdx = segments.findIndex((s) => /^jobs?$/i.test(s));
  if (jobsIdx >= 0) {
    const id = segments[jobsIdx + 1]?.split(/[?#]/)[0];
    if (id && /^\d+$/.test(id)) return id;
  }

  // /job-detail/5979543004/  /careers/job/7696633  /positions/123
  for (let i = 0; i < segments.length; i++) {
    if (
      /^(job-detail|job|jobs|careers|position|positions|opening|openings|role|roles)$/i.test(
        segments[i]
      )
    ) {
      const id = segments[i + 1]?.split(/[?#]/)[0];
      if (id && /^\d{5,}$/.test(id)) return id;
    }
  }

  const trailing = segments[segments.length - 1]?.split(/[?#]/)[0];
  if (trailing && /^\d{6,}$/.test(trailing)) return trailing;
  return null;
}

function extractGreenhouseBoardFromUrl(parsed: URL): string | null {
  const forParam =
    parsed.searchParams.get("for") ||
    parsed.searchParams.get("board") ||
    parsed.searchParams.get("board_token");
  if (forParam?.trim()) return forParam.trim().toLowerCase();

  if (/greenhouse\.io$/i.test(parsed.hostname)) {
    const segments = parsed.pathname.split("/").filter(Boolean);
    // job-boards.greenhouse.io/modernhealth/jobs/…
    if (segments[0] && !/^(embed|v1|boards)$/i.test(segments[0])) {
      return segments[0].toLowerCase();
    }
  }
  return null;
}

/** Common company career hosts → Greenhouse board token. */
const GREENHOUSE_HOST_BOARDS: Array<{ host: RegExp; board: string }> = [
  { host: /(?:^|\.)mongodb\.com$/i, board: "mongodb" },
  { host: /(?:^|\.)cribl\.io$/i, board: "cribl" },
  { host: /(?:^|\.)ondarowave\.com$/i, board: "ondarowave" },
  { host: /(?:^|\.)modernhealth\.com$/i, board: "modernhealth" },
];

function boardFromHostname(hostname: string): string | null {
  for (const row of GREENHOUSE_HOST_BOARDS) {
    if (row.host.test(hostname)) return row.board;
  }
  return null;
}

/** Discover board token from page HTML (embed for=, boards-api path, absolute_url). */
function discoverGreenhouseBoardFromHtml(html: string): string | null {
  const patterns = [
    /boards-api\.greenhouse\.io\/v1\/boards\/([a-zA-Z0-9_-]+)/i,
    /[?&]for=([a-zA-Z0-9_-]+)/i,
    /job_board\?for=([a-zA-Z0-9_-]+)/i,
    /"board_token"\s*:\s*"([a-zA-Z0-9_-]+)"/i,
    /boards\.greenhouse\.io\/([a-zA-Z0-9_-]+)/i,
    /job-boards\.greenhouse\.io\/([a-zA-Z0-9_-]+)/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1] && !/^(embed|v1|jobs|job)$/i.test(m[1])) return m[1].toLowerCase();
  }
  return null;
}

/**
 * Greenhouse — boards.greenhouse.io / job-boards.greenhouse.io / company sites
 * with ?gh_jid= or /jobs/{id} that proxy Greenhouse.
 */
async function scrapeGreenhouse(parsed: URL): Promise<string | null> {
  // Dedicated ATS hosts have their own scrapers — never treat /jobs/{id} as Greenhouse.
  if (
    /(?:^|\.)(?:recruiterflow\.com|ripplehire\.com|oraclecloud\.com|dayforcehcm\.com|ashbyhq\.com|applytojob\.com|jobs\.gem\.com|adp\.com|lever\.co|myworkdayjobs\.com|smartrecruiters\.com|recruitee\.com|eightfold\.ai|icims\.com)$/i.test(
      parsed.hostname
    )
  ) {
    return null;
  }

  const isGreenhouseHost = /greenhouse\.io$/i.test(parsed.hostname);
  const jobId = extractGreenhouseJobId(parsed);
  if (!jobId) {
    if (isGreenhouseHost) return null;
    // No numeric job id — only continue for greenhouse hosts.
    return null;
  }

  const boardCandidates: string[] = [];
  const push = (b: string | null | undefined) => {
    if (!b) return;
    const t = b.trim().toLowerCase();
    if (t && !boardCandidates.includes(t)) boardCandidates.push(t);
  };

  push(extractGreenhouseBoardFromUrl(parsed));
  push(boardFromHostname(parsed.hostname));

  // Company career pages: peek at HTML for for=board token when still unknown.
  if (!isGreenhouseHost && boardCandidates.length === 0) {
    try {
      const res = await fetchWithTimeout(parsed.toString(), {
        headers: { ...BROWSER_HEADERS, Accept: "text/html,*/*" },
      });
      if (res.ok) {
        const html = await res.text();
        push(discoverGreenhouseBoardFromHtml(html));
      }
    } catch {
      // ignore — try known boards only
    }
  }

  // Greenhouse host with path board already pushed; if empty, nothing to try.
  if (boardCandidates.length === 0 && isGreenhouseHost) {
    push(parsed.pathname.split("/").filter(Boolean)[0]);
  }

  let sawNotFound = false;
  for (const board of boardCandidates) {
    const { text, notFound } = await fetchGreenhouseJobByBoard(board, jobId);
    if (text) return text;
    if (notFound) sawNotFound = true;
  }

  // Last resort: fetch HTML and discover board, then retry once.
  if (!isGreenhouseHost) {
    try {
      const res = await fetchWithTimeout(parsed.toString(), {
        headers: { ...BROWSER_HEADERS, Accept: "text/html,*/*" },
      });
      if (res.ok) {
        const html = await res.text();
        const discovered = discoverGreenhouseBoardFromHtml(html);
        if (discovered && !boardCandidates.includes(discovered)) {
          const { text, notFound } = await fetchGreenhouseJobByBoard(
            discovered,
            jobId
          );
          if (text) return text;
          if (notFound) sawNotFound = true;
        }
      }
    } catch {
      // ignore
    }
  }

  if (isGreenhouseHost && sawNotFound) {
    throw new Error(
      "This Greenhouse posting was not found — it has likely expired or been removed."
    );
  }

  // Signal to caller that this looked like Greenhouse but failed (company sites).
  if (!isGreenhouseHost && boardCandidates.length > 0 && sawNotFound) {
    throw new Error(
      "This Greenhouse-hosted posting was not found — it has likely expired or been removed."
    );
  }

  return null;
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
      if (match) return formatAshbyJob(match);

      const detail = await fetchAshbyJobGraphql(board, jobKey);
      if (detail) return detail;

      throw new Error(
        "This Ashby posting was not found — it has likely expired, been unlisted, or removed."
      );
    } catch (err) {
      if (err instanceof Error && /Ashby posting was not found/i.test(err.message)) {
        throw err;
      }
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
    if (match) return formatAshbyJob(match);
    return fetchAshbyJobGraphql(board, ashbyJid);
  } catch {
    return null;
  }
}

async function fetchAshbyJobGraphql(
  board: string,
  jobPostingId: string
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(
      "https://jobs.ashbyhq.com/api/non-user-graphql?op=ApiJobPosting",
      {
        method: "POST",
        headers: {
          ...BROWSER_HEADERS,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          operationName: "ApiJobPosting",
          variables: {
            organizationHostedJobsPageName: board,
            jobPostingId,
          },
          query: `query ApiJobPosting($organizationHostedJobsPageName: String!, $jobPostingId: String!) {
            jobPosting(organizationHostedJobsPageName: $organizationHostedJobsPageName, jobPostingId: $jobPostingId) {
              id title locationName employmentType descriptionHtml departmentName
            }
          }`,
        }),
      }
    );
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: {
        jobPosting?: {
          title?: string;
          locationName?: string;
          departmentName?: string;
          descriptionHtml?: string;
        } | null;
      };
    };
    const job = json.data?.jobPosting;
    if (!job) return null;
    return formatAshbyJob({
      title: job.title,
      location: job.locationName,
      department: job.departmentName,
      descriptionHtml: job.descriptionHtml,
    });
  } catch {
    return null;
  }
}

// Dayforce / Ceridian (jobs.dayforcehcm.com) — JD is embedded in __NEXT_DATA__.
async function scrapeDayforce(parsed: URL): Promise<string | null> {
  if (!/dayforcehcm\.com$/i.test(parsed.hostname)) return null;
  if (!/\/jobs\/\d+/i.test(parsed.pathname)) return null;

  try {
    const res = await fetchWithTimeout(parsed.toString(), {
      headers: { ...BROWSER_HEADERS, Accept: "text/html,*/*" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const nd = html.match(
      /<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
    );
    if (!nd?.[1]) return null;
    const json = JSON.parse(nd[1]) as {
      props?: {
        pageProps?: {
          jobData?: {
            jobTitle?: string;
            postingLocations?: Array<{
              locationName?: string;
              cityName?: string;
              stateCode?: string;
              countryCode?: string;
            }>;
            jobPostingContent?: {
              jobDescriptionHeader?: string;
              jobDescription?: string;
              jobDescriptionFooter?: string;
            };
          };
        };
      };
    };
    const job = json.props?.pageProps?.jobData;
    if (!job?.jobTitle && !job?.jobPostingContent) return null;

    const content = job.jobPostingContent ?? {};
    const body = [
      htmlToText(content.jobDescriptionHeader ?? ""),
      htmlToText(content.jobDescription ?? ""),
      htmlToText(content.jobDescriptionFooter ?? ""),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!body.trim()) return null;

    const locations = (job.postingLocations ?? [])
      .map((loc) => {
        if (loc.locationName?.trim()) return loc.locationName.trim();
        return [loc.cityName, loc.stateCode, loc.countryCode]
          .filter(Boolean)
          .join(", ");
      })
      .filter(Boolean);

    const text = collapseWhitespace(
      [
        job.jobTitle ? `Job Title: ${job.jobTitle}` : "",
        locations.length ? `Location: ${locations.join(" | ")}` : "",
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

// Gem (jobs.gem.com/{board}/{extId}) — public GraphQL API.
async function scrapeGem(parsed: URL): Promise<string | null> {
  if (!/jobs\.gem\.com$/i.test(parsed.hostname)) return null;
  const segments = parsed.pathname.split("/").filter(Boolean);
  const boardId = segments[0];
  const extId = segments[1];
  if (!boardId || !extId) return null;

  const query = `query ExternalJobPostingQuery($boardId: String!, $extId: String!) {
    oatsExternalJobPosting(boardId: $boardId, extId: $extId) {
      id
      title
      descriptionHtml
      locations { name city isoCountry isRemote }
      job {
        employmentType
        teamDisplayName
        department { name }
      }
      jobPostSectionHtml { introHtml outroHtml }
      compensationHtml
    }
  }`;

  try {
    const res = await fetchWithTimeout("https://jobs.gem.com/api/public/graphql", {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        "Content-Type": "application/json",
        Accept: "application/json",
        Origin: "https://jobs.gem.com",
        Referer: parsed.toString(),
      },
      body: JSON.stringify({
        operationName: "ExternalJobPostingQuery",
        variables: { boardId, extId },
        query,
      }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      data?: {
        oatsExternalJobPosting?: {
          title?: string;
          descriptionHtml?: string;
          compensationHtml?: string;
          locations?: Array<{
            name?: string;
            city?: string;
            isoCountry?: string;
            isRemote?: boolean;
          }>;
          job?: {
            employmentType?: string;
            teamDisplayName?: string;
            department?: { name?: string };
          };
          jobPostSectionHtml?: { introHtml?: string; outroHtml?: string };
        } | null;
      };
    };
    const job = json.data?.oatsExternalJobPosting;
    if (!job) {
      throw new Error(
        "This Gem posting was not found — it has likely expired or been removed."
      );
    }

    const body = [
      htmlToText(job.jobPostSectionHtml?.introHtml ?? ""),
      htmlToText(job.descriptionHtml ?? ""),
      htmlToText(job.compensationHtml ?? ""),
      htmlToText(job.jobPostSectionHtml?.outroHtml ?? ""),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!body.trim()) return null;

    const locations = (job.locations ?? [])
      .map((loc) => {
        const named = loc.name?.trim();
        if (named) return named + (loc.isRemote ? " (Remote)" : "");
        const parts = [loc.city, loc.isoCountry].filter(Boolean).join(", ");
        return parts + (loc.isRemote ? " (Remote)" : "");
      })
      .filter(Boolean);

    const text = collapseWhitespace(
      [
        job.title ? `Job Title: ${job.title}` : "",
        job.job?.department?.name
          ? `Department: ${job.job.department.name}`
          : job.job?.teamDisplayName
            ? `Team: ${job.job.teamDisplayName}`
            : "",
        locations.length ? `Location: ${locations.join(" | ")}` : "",
        job.job?.employmentType
          ? `Employment Type: ${job.job.employmentType}`
          : "",
        body,
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    return text.length >= 80 ? truncate(text) : null;
  } catch (err) {
    if (err instanceof Error && /Gem posting was not found/i.test(err.message)) {
      throw err;
    }
    return null;
  }
}

// JazzHR (*.applytojob.com) — full JD is in HTML (#job-description).
async function scrapeJazzHr(parsed: URL): Promise<string | null> {
  if (!/applytojob\.com$/i.test(parsed.hostname)) return null;

  try {
    const res = await fetchWithTimeout(parsed.toString(), {
      headers: { ...BROWSER_HEADERS, Accept: "text/html,*/*" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    $("script, style, noscript").remove();

    const pageTitle = collapseWhitespace($("title").first().text());
    const titleFromDoc = pageTitle.split(/\s+[-|–—]\s+/)[0]?.trim() || "";
    const title =
      collapseWhitespace($("h2.job-title, h1.job-title, .job-title").first().text()) ||
      (titleFromDoc && !/career|apply/i.test(titleFromDoc) ? titleFromDoc : "") ||
      collapseWhitespace($("h1").first().text());
    const company =
      collapseWhitespace($(".company-name, [class*='company-name']").first().text()) ||
      collapseWhitespace(pageTitle.split(/\s+[-|–—]\s+/).slice(1).join(" - ")) ||
      "";

    const desc =
      collapseWhitespace($("#job-description").text()) ||
      collapseWhitespace($("[id*='job-description']").first().text()) ||
      collapseWhitespace($(".job_description, .job-description").first().text());

    if (!desc || desc.length < 80) {
      const fromLd = extractJsonLdJobPostingFromRaw(html);
      if (fromLd) return fromLd;
      return extractFromHtml(html);
    }

    const text = collapseWhitespace(
      [
        title ? `Job Title: ${title}` : "",
        company && !/career page/i.test(company) ? `Company: ${company}` : "",
        desc,
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    return text.length >= 80 ? truncate(text) : null;
  } catch {
    return null;
  }
}

// Ripplehire (*.ripplehire.com) — SPA; JD via candidatejobdetail?token=&jobSeq=
async function scrapeRipplehire(parsed: URL): Promise<string | null> {
  if (!/ripplehire\.com$/i.test(parsed.hostname)) return null;

  const token =
    parsed.searchParams.get("token")?.trim() ||
    parsed.searchParams.get("ptoken")?.trim() ||
    "";
  const hash = parsed.hash || "";
  const jobSeq =
    parsed.searchParams.get("jobSeq")?.trim() ||
    parsed.searchParams.get("jobId")?.trim() ||
    parsed.searchParams.get("jobid")?.trim() ||
    (hash.match(/detail\/job\/(\d+)/i)?.[1] ?? "") ||
    (hash.match(/\/job\/(\d+)/i)?.[1] ?? "");
  if (!token || !jobSeq) return null;

  const origin = `${parsed.protocol}//${parsed.host}`;
  const api = new URL("/candidate/candidatejobdetail", origin);
  api.searchParams.set("token", token);
  api.searchParams.set("jobSeq", jobSeq);
  api.searchParams.set("lang", "en");

  try {
    const res = await fetchWithTimeout(api.toString(), {
      headers: {
        ...BROWSER_HEADERS,
        Accept: "application/json, text/javascript, */*; q=0.01",
        "X-Requested-With": "XMLHttpRequest",
        Referer: parsed.toString().split("#")[0],
        Origin: origin,
      },
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      companyVO?: { companyName?: string };
      jobVO?: {
        jobTitle?: string;
        jobDesc?: string;
        jobLocation?: string;
        locations?: string;
        jobCode?: string;
        jobPrimarySkills?: string;
        jobSecondarySkills?: string;
        jobSkills?: string;
        otherDetails?: string;
        compensationInfo?: string;
        compensationRange?: string;
      };
    };
    const job = json.jobVO;
    if (!job?.jobDesc && !job?.jobTitle) {
      throw new Error(
        "This Ripplehire posting was not found — it has likely expired or been removed."
      );
    }

    const body = [
      htmlToText(job.jobDesc ?? ""),
      htmlToText(job.otherDetails ?? ""),
      job.jobPrimarySkills ? `Primary Skills: ${htmlToText(job.jobPrimarySkills)}` : "",
      job.jobSecondarySkills
        ? `Secondary Skills: ${htmlToText(job.jobSecondarySkills)}`
        : "",
      job.jobSkills ? `Skills: ${htmlToText(job.jobSkills)}` : "",
      job.compensationInfo || job.compensationRange
        ? `Compensation: ${htmlToText(job.compensationInfo || job.compensationRange || "")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!body.trim()) return null;

    const location = job.jobLocation || job.locations || "";
    const text = collapseWhitespace(
      [
        job.jobTitle ? `Job Title: ${job.jobTitle}` : "",
        json.companyVO?.companyName
          ? `Company: ${json.companyVO.companyName}`
          : "",
        location ? `Location: ${location}` : "",
        job.jobCode ? `Job Code: ${job.jobCode}` : "",
        body,
      ]
        .filter(Boolean)
        .join("\n\n")
    );
    return text.length >= 80 ? truncate(text) : null;
  } catch (err) {
    if (
      err instanceof Error &&
      /Ripplehire posting was not found/i.test(err.message)
    ) {
      throw err;
    }
    return null;
  }
}

// Recruiterflow (recruiterflow.com/{company}/jobs/{id}) — JSON-LD JobPosting in HTML.
async function scrapeRecruiterflow(parsed: URL): Promise<string | null> {
  if (!/recruiterflow\.com$/i.test(parsed.hostname)) return null;
  if (!/\/jobs\/\d+/i.test(parsed.pathname)) return null;

  try {
    const res = await fetchWithTimeout(parsed.toString(), {
      headers: { ...BROWSER_HEADERS, Accept: "text/html,*/*" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const fromLd = extractJsonLdJobPostingFromRaw(html);
    if (fromLd) return fromLd;
    return extractFromHtml(html);
  } catch {
    return null;
  }
}

// Oracle Cloud HCM Candidate Experience (*.oraclecloud.com/.../job/{id})
type OracleCeJobDetail = {
  Title?: string;
  PrimaryLocation?: string;
  PrimaryLocationCountry?: string;
  Organization?: string;
  ExternalDescriptionStr?: string;
  ExternalResponsibilitiesStr?: string;
  ExternalQualificationsStr?: string;
  ShortDescriptionStr?: string;
  CorporateDescriptionStr?: string;
  WorkplaceType?: string;
  Category?: string;
};

async function scrapeOracleCloud(parsed: URL): Promise<string | null> {
  if (!/oraclecloud\.com$/i.test(parsed.hostname)) return null;
  const jobMatch = parsed.pathname.match(/\/job\/(\d+)/i);
  if (!jobMatch?.[1]) return null;
  const jobId = jobMatch[1];

  try {
    const pageRes = await fetchWithTimeout(parsed.toString(), {
      headers: { ...BROWSER_HEADERS, Accept: "text/html,*/*" },
    });
    const pageHtml = pageRes.ok ? await pageRes.text() : "";

    const siteFromHtml = [
      ...pageHtml.matchAll(/siteNumber["'\s:=]+([A-Z0-9_]+)/gi),
    ].map((m) => m[1]);
    const siteFromPath = parsed.pathname.match(/\/sites\/([^/]+)/i)?.[1];
    const siteCandidates = [
      ...new Set(
        [
          ...siteFromHtml,
          siteFromPath && /^CX_/i.test(siteFromPath) ? siteFromPath : "",
          siteFromPath === "jobsearch" ? "CX_45001" : "",
          siteFromPath || "",
          "CX_45001",
          "CX_1",
        ].filter(Boolean)
      ),
    ];

    let item: OracleCeJobDetail | null = null;

    for (const site of siteCandidates) {
      const api = new URL(
        "/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails",
        `${parsed.protocol}//${parsed.host}`
      );
      api.searchParams.set("expand", "all");
      api.searchParams.set("onlyData", "true");
      api.searchParams.set(
        "finder",
        `ById;Id="${jobId}",siteNumber=${site}`
      );

      const res = await fetchWithTimeout(api.toString(), {
        headers: {
          ...BROWSER_HEADERS,
          Accept: "application/json, application/vnd.oracle.adf.resourceitem+json",
          "ora-irc-language": "en",
          "ora-irc-cx-userid":
            typeof crypto !== "undefined" && "randomUUID" in crypto
              ? crypto.randomUUID()
              : `cx-${Date.now()}`,
          Referer: parsed.toString(),
          Origin: `${parsed.protocol}//${parsed.host}`,
        },
      });
      if (!res.ok) continue;
      const json = (await res.json()) as { items?: OracleCeJobDetail[] };
      const candidate = json.items?.[0];
      if (candidate?.Title || candidate?.ExternalDescriptionStr) {
        item = candidate;
        break;
      }
    }

    if (!item) {
      // Fallback: og:title / og:description from the public page (short).
      const ogTitle = pageHtml.match(
        /property=["']og:title["']\s+content=["']([^"']+)["']/i
      )?.[1];
      const ogDesc = pageHtml.match(
        /property=["']og:description["']\s+content=["']([^"']+)["']/i
      )?.[1];
      if (ogTitle && ogDesc && ogDesc.length >= 80) {
        return truncate(
          collapseWhitespace(
            `Job Title: ${ogTitle}\n\n${htmlToText(ogDesc)}`
          )
        );
      }
      return null;
    }

    const body = [
      htmlToText(item.ExternalDescriptionStr ?? ""),
      htmlToText(item.ExternalResponsibilitiesStr ?? ""),
      htmlToText(item.ExternalQualificationsStr ?? ""),
      !item.ExternalDescriptionStr
        ? htmlToText(item.ShortDescriptionStr ?? "")
        : "",
      htmlToText(item.CorporateDescriptionStr ?? ""),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!body.trim()) return null;

    const location = [item.PrimaryLocation, item.PrimaryLocationCountry]
      .filter(Boolean)
      .join(", ");
    const text = collapseWhitespace(
      [
        item.Title ? `Job Title: ${item.Title}` : "",
        item.Organization ? `Organization: ${item.Organization}` : "",
        location ? `Location: ${location}` : "",
        item.WorkplaceType ? `Workplace: ${item.WorkplaceType}` : "",
        item.Category ? `Category: ${item.Category}` : "",
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

/**
 * ADP Workforce Now / MASCSR career pages are a JS SPA — plain HTML has no JD.
 * Public career-center API works on Vercel without Playwright:
 *   GET .../job-requisitions/{jobId}?cid={cid}
 */
function isAdpHost(hostname: string): boolean {
  return /(?:^|\.)adp\.com$/i.test(hostname);
}

type AdpJobDetail = {
  itemID?: string;
  requisitionTitle?: string;
  requisitionDescription?: string;
  clientRequisitionID?: string;
  postDate?: string;
  workLevelCode?: { shortName?: string };
  payGradeRange?: {
    minimumRate?: { amountValue?: number; currencyCode?: string };
    maximumRate?: { amountValue?: number; currencyCode?: string };
  };
  requisitionLocations?: Array<{
    nameCode?: { shortName?: string };
    address?: {
      cityName?: string;
      countrySubdivisionLevel1?: { codeValue?: string };
      postalCode?: string;
    };
  }>;
  customFieldGroup?: {
    stringFields?: Array<{
      stringValue?: string;
      nameCode?: { codeValue?: string };
    }>;
  };
};

function formatAdpJobDetail(data: AdpJobDetail): string | null {
  const rawHtml = data.requisitionDescription ?? "";
  let body = "";
  if (rawHtml) {
    const $ = cheerio.load(rawHtml);
    $("script, style").remove();
    $("br").replaceWith("\n");
    $("p, div, li, h1, h2, h3, h4, tr, section").append("\n");
    body = collapseWhitespace($.root().text());
  }
  if (!body.trim()) return null;

  const locations = (data.requisitionLocations ?? [])
    .map((loc) => {
      const named = loc.nameCode?.shortName?.trim();
      if (named) return named;
      const city = loc.address?.cityName;
      const state = loc.address?.countrySubdivisionLevel1?.codeValue;
      return [city, state].filter(Boolean).join(", ");
    })
    .filter(Boolean);

  const min = data.payGradeRange?.minimumRate;
  const max = data.payGradeRange?.maximumRate;
  let pay = "";
  if (min?.amountValue != null || max?.amountValue != null) {
    const currency = min?.currencyCode || max?.currencyCode || "USD";
    const lo = min?.amountValue != null ? `${min.amountValue}` : "?";
    const hi = max?.amountValue != null ? `${max.amountValue}` : "?";
    pay = `${lo} – ${hi} ${currency}`;
  }
  const salaryField = data.customFieldGroup?.stringFields?.find(
    (f) => f.nameCode?.codeValue === "SalaryRange"
  )?.stringValue;

  const text = collapseWhitespace(
    [
      data.requisitionTitle ? `Job Title: ${data.requisitionTitle}` : "",
      locations.length ? `Location: ${locations.join(" | ")}` : "",
      data.workLevelCode?.shortName
        ? `Employment Type: ${data.workLevelCode.shortName}`
        : "",
      salaryField || pay ? `Pay: ${salaryField || pay}` : "",
      data.postDate ? `Posted: ${data.postDate}` : "",
      data.clientRequisitionID
        ? `Requisition ID: ${data.clientRequisitionID}`
        : "",
      body,
    ]
      .filter(Boolean)
      .join("\n\n")
  );
  return text.length >= 80 ? truncate(text) : null;
}

/**
 * ADP MyJobs (myjobs.adp.com/{company}/cx/job-details?reqId=...).
 * 1) GET career-site config → myJobsToken + orgoid
 * 2) GET search-meta/{reqId} with those headers → full JD
 */
async function scrapeAdpMyJobs(parsed: URL): Promise<string | null> {
  if (!/myjobs\.adp\.com$/i.test(parsed.hostname)) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  const company = segments[0];
  const reqId =
    parsed.searchParams.get("reqId")?.trim() ||
    parsed.searchParams.get("reqid")?.trim() ||
    (segments.includes("job") || segments.includes("job-details")
      ? segments[segments.length - 1]
      : null);
  if (!company || !reqId || !/^\d+$/.test(reqId)) return null;

  try {
    const cfgRes = await fetchWithTimeout(
      `https://myjobs.adp.com/public/staffing/v1/career-site/${encodeURIComponent(company)}`,
      {
        headers: {
          ...BROWSER_HEADERS,
          Accept: "application/json, text/plain, */*",
          Origin: "https://myjobs.adp.com",
          Referer: "https://myjobs.adp.com/",
        },
      }
    );
    if (!cfgRes.ok) {
      console.warn(`[scrape] ADP MyJobs config HTTP ${cfgRes.status} for ${company}`);
      return null;
    }
    const cfg = (await cfgRes.json()) as {
      myJobsToken?: string;
      orgoid?: string;
      clientName?: string;
    };
    if (!cfg.myJobsToken || !cfg.orgoid) return null;

    const myadpUrl = "https://my.adp.com";
    const detailUrl = `${myadpUrl}/myadp_prefix/mycareer/public/staffing/v1/job-requisitions/search-meta/${encodeURIComponent(reqId)}`;
    const detailRes = await fetchWithTimeout(detailUrl, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: "application/json, text/plain, */*",
        "Accept-Language": "en-US",
        Origin: "https://myjobs.adp.com",
        Referer: parsed.toString(),
        myjobstoken: cfg.myJobsToken,
        orgoid: cfg.orgoid,
      },
    });
    if (!detailRes.ok) {
      console.warn(
        `[scrape] ADP MyJobs search-meta HTTP ${detailRes.status} for reqId=${reqId}`
      );
      return null;
    }
    const json = (await detailRes.json()) as {
      jobRequisitions?: AdpJobDetail[];
    };
    const job = json.jobRequisitions?.[0];
    if (!job) {
      throw new Error(
        "This ADP MyJobs posting was not found — it has likely expired or been removed."
      );
    }

    const formatted = formatAdpJobDetail(job);
    if (!formatted) return null;
    if (cfg.clientName && !formatted.includes("Company:")) {
      return `Company: ${cfg.clientName}\n\n${formatted}`;
    }
    return formatted;
  } catch (err) {
    if (
      err instanceof Error &&
      /ADP MyJobs posting was not found/i.test(err.message)
    ) {
      throw err;
    }
    console.warn(
      "[scrape] ADP MyJobs failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

async function scrapeAdp(parsed: URL): Promise<string | null> {
  if (!isAdpHost(parsed.hostname)) return null;
  if (/myjobs\.adp\.com$/i.test(parsed.hostname)) return null;
  if (!/workforcenow\.adp\.com/i.test(parsed.hostname) && !/mascsr/i.test(parsed.pathname)) {
    // Still try if cid+jobId are present on any adp.com careers URL.
    if (!parsed.searchParams.get("cid") || !parsed.searchParams.get("jobId")) {
      return null;
    }
  }

  const cid = parsed.searchParams.get("cid")?.trim();
  const jobId =
    parsed.searchParams.get("jobId")?.trim() ||
    parsed.searchParams.get("jobid")?.trim() ||
    parsed.searchParams.get("selectedJobId")?.trim();
  if (!cid || !jobId) return null;

  const lang =
    parsed.searchParams.get("lang")?.trim() ||
    parsed.searchParams.get("locale")?.trim() ||
    "en_US";
  const ccId = parsed.searchParams.get("ccId")?.trim();

  const qs = new URLSearchParams({
    cid,
    lang,
    locale: lang,
  });
  if (ccId) qs.set("ccId", ccId);

  const api = `https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions/${encodeURIComponent(jobId)}?${qs.toString()}`;

  try {
    const res = await fetchWithTimeout(api, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: "application/json, text/plain, */*",
        Referer: parsed.toString(),
        Origin: "https://workforcenow.adp.com",
      },
    });
    if (!res.ok) {
      console.warn(`[scrape] ADP job API HTTP ${res.status} for jobId=${jobId}`);
      return null;
    }
    const data = (await res.json()) as AdpJobDetail;
    const formatted = formatAdpJobDetail(data);
    if (formatted) return formatted;

    // Some tenants only accept ExternalJobID via listing lookup.
    const listUrl = `https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions?${qs.toString()}&$top=100&$skip=0`;
    const listRes = await fetchWithTimeout(listUrl, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: "application/json, text/plain, */*",
        Referer: parsed.toString(),
      },
    });
    if (!listRes.ok) return null;
    const list = (await listRes.json()) as { jobRequisitions?: AdpJobDetail[] };
    const match = (list.jobRequisitions ?? []).find((job) => {
      const external = job.customFieldGroup?.stringFields?.find(
        (f) => f.nameCode?.codeValue === "ExternalJobID"
      )?.stringValue;
      return (
        job.itemID === jobId ||
        external === jobId ||
        job.clientRequisitionID === jobId
      );
    });
    if (!match?.itemID) return null;

    const detailUrl = `https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions/${encodeURIComponent(match.itemID)}?${qs.toString()}`;
    const detailRes = await fetchWithTimeout(detailUrl, {
      headers: {
        ...BROWSER_HEADERS,
        Accept: "application/json, text/plain, */*",
        Referer: parsed.toString(),
      },
    });
    if (!detailRes.ok) return formatAdpJobDetail(match);
    const detail = (await detailRes.json()) as AdpJobDetail;
    return formatAdpJobDetail(detail) || formatAdpJobDetail(match);
  } catch (err) {
    console.warn(
      "[scrape] ADP job API failed:",
      err instanceof Error ? err.message : err
    );
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
  // Greenhouse also covers company career pages with ?gh_jid= or /jobs/{id}
  // (MongoDB, Cribl, Ondaro Wave, job-boards.greenhouse.io, etc.).
  try {
    const greenhouse = await scrapeGreenhouse(parsed);
    if (greenhouse) return greenhouse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Greenhouse posting was not found|expired or been removed/i.test(msg)) {
      throw err;
    }
    // Soft-fail discovery errors; continue to other scrapers.
  }

  const lever = await scrapeLever(parsed);
  if (lever) return lever;

  try {
    const ashby = await scrapeAshby(parsed, normalized);
    if (ashby) return ashby;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Ashby posting was not found|expired|unlisted|removed/i.test(msg)) {
      throw err;
    }
  }

  const dayforce = await scrapeDayforce(parsed);
  if (dayforce) return dayforce;

  try {
    const gem = await scrapeGem(parsed);
    if (gem) return gem;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Gem posting was not found|expired or been removed/i.test(msg)) {
      throw err;
    }
  }

  const jazzHr = await scrapeJazzHr(parsed);
  if (jazzHr) return jazzHr;

  try {
    const ripplehire = await scrapeRipplehire(parsed);
    if (ripplehire) return ripplehire;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/Ripplehire posting was not found|expired or been removed/i.test(msg)) {
      throw err;
    }
  }

  const recruiterflow = await scrapeRecruiterflow(parsed);
  if (recruiterflow) return recruiterflow;

  const oracleCloud = await scrapeOracleCloud(parsed);
  if (oracleCloud) return oracleCloud;

  const recruitee = await scrapeRecruitee(parsed);
  if (recruitee) return recruitee;

  const smartRecruiters = await scrapeSmartRecruiters(parsed);
  if (smartRecruiters) return smartRecruiters;

  const eightfold = await scrapeEightfold(parsed);
  if (eightfold) return eightfold;

  // ADP MyJobs (myjobs.adp.com) + Workforce Now (workforcenow.adp.com).
  if (isAdpHost(parsed.hostname)) {
    try {
      const myJobs = await scrapeAdpMyJobs(parsed);
      if (myJobs) return myJobs;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/ADP MyJobs posting was not found|expired or been removed/i.test(msg)) {
        throw err;
      }
    }

    const adp = await scrapeAdp(parsed);
    if (adp) return adp;

    if (/myjobs\.adp\.com$/i.test(parsed.hostname)) {
      throw new Error(
        "Could not load this ADP MyJobs posting. Check that the URL still includes the company slug and reqId, or paste the job description manually."
      );
    }
    throw new Error(
      "Could not load this ADP Workforce Now posting. Check that the URL still includes cid and jobId, or paste the job description manually."
    );
  }

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
