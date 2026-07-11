import type { Browser, BrowserContext } from "playwright";

let browserPromise: Promise<Browser> | null = null;

function browserUnavailableError(): Error {
  return new Error("Cannot find package 'playwright'");
}

async function getBrowser(): Promise<Browser> {
  // No Chromium on Vercel serverless — scraper falls back to HTTP fetch.
  if (process.env.VERCEL || process.env.DISABLE_PLAYWRIGHT === "1") {
    throw browserUnavailableError();
  }

  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import("playwright");
      return chromium.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
        ],
      });
    })();
  }
  return browserPromise;
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch {
      // ignore
    }
    browserPromise = null;
  }
}

const DESCRIPTION_SELECTORS = [
  "[data-automation-id='jobPostingDescription']",
  "[data-automation-id='job-posting-details']",
  "[class*='job-description']",
  "[class*='jobDescription']",
  "[id*='job-description']",
  "article",
  "main",
];

export type RenderedPage = {
  html: string;
  innerText: string;
};

/**
 * Renders a page with a real headless browser so JavaScript-loaded job
 * descriptions (Workday, LinkedIn, SPAs) are fully present before extraction.
 */
export async function renderPage(
  url: string,
  timeoutMs = 45_000
): Promise<RenderedPage> {
  const browser = await getBrowser();
  let context: BrowserContext | null = null;

  try {
    context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
    });

    const page = await context.newPage();

    // Speed up: skip heavy assets we don't need for text extraction.
    await page.route("**/*", (route) => {
      const type = route.request().resourceType();
      if (type === "image" || type === "media" || type === "font") {
        return route.abort();
      }
      return route.continue();
    });

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

    // Give SPA content time to hydrate; wait for meaningful body text.
    await Promise.race([
      page
        .waitForSelector(DESCRIPTION_SELECTORS.join(", "), {
          timeout: Math.min(20_000, timeoutMs),
        })
        .catch(() => null),
      page
        .waitForFunction(() => (document.body?.innerText?.length ?? 0) > 400, {
          timeout: Math.min(20_000, timeoutMs),
        })
        .catch(() => null),
      page.waitForTimeout(5_000),
    ]);

    // Scroll to trigger lazy-loaded sections.
    await page.evaluate(async () => {
      await new Promise<void>((resolve) => {
        let scrolled = 0;
        const step = 500;
        const timer = window.setInterval(() => {
          window.scrollBy(0, step);
          scrolled += step;
          const max = Math.min(document.body?.scrollHeight ?? 0, 6000);
          if (scrolled >= max) {
            window.clearInterval(timer);
            resolve();
          }
        }, 150);
      });
    });

    await page.waitForTimeout(1_500);

    const html = await page.content();
    const innerText = await page.evaluate(() => document.body?.innerText ?? "");

    return { html, innerText };
  } finally {
    if (context) {
      await context.close().catch(() => {});
    }
  }
}

export async function isBrowserAvailable(): Promise<boolean> {
  try {
    await getBrowser();
    return true;
  } catch {
    return false;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

type WorkdayDetail = {
  jobPostingInfo?: {
    title?: string;
    jobDescription?: string;
    location?: string;
  };
  hiringOrganization?: { name?: string };
};

function formatWorkdayDetail(data: WorkdayDetail): string | null {
  const info = data.jobPostingInfo;
  if (!info?.jobDescription) return null;
  const text = [
    info.title ? `Job Title: ${info.title}` : "",
    data.hiringOrganization?.name ? `Company: ${data.hiringOrganization.name}` : "",
    info.location ? `Location: ${info.location}` : "",
    stripHtml(info.jobDescription),
  ]
    .filter(Boolean)
    .join("\n\n");
  return text.trim().length >= 80 ? text.trim() : null;
}

export type WorkdayResult =
  | { status: "ok"; text: string }
  | { status: "not_found" }
  | { status: "unsupported" };

/** Fetch iCIMS job HTML using a real browser session (bypasses Node fetch blocks). */
export async function fetchIcimsJobHtml(rawUrl: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!/(?:^|\.)icims\.com$/i.test(parsed.hostname)) return null;

  const segments = parsed.pathname.split("/").filter(Boolean);
  const jobsIdx = segments.indexOf("jobs");
  const jobId = jobsIdx >= 0 ? segments[jobsIdx + 1] : null;
  if (!jobId || !/^\d+$/.test(jobId)) return null;

  const origin = parsed.origin;
  const slug = segments[jobsIdx + 2];
  const candidates = [
    `${origin}/jobs/${jobId}/job?in_iframe=1`,
    slug && slug !== "job" ? `${origin}/jobs/${jobId}/${slug}/job?in_iframe=1` : "",
  ].filter(Boolean);

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  try {
    const page = await context.newPage();
    await page.goto(`${origin}/jobs/intro?in_iframe=1`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(1200);

    for (const jobUrl of candidates) {
      const res = await page.request.get(jobUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: `${origin}/jobs/intro?in_iframe=1`,
        },
      });
      const html = await res.text();
      if (
        html.includes("JobPosting") ||
        html.includes("iCIMS_Expandable_Text") ||
        html.includes("iCIMS_InfoMsg_Job")
      ) {
        return html;
      }
    }
    return null;
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * Scrapes a Workday posting via its authenticated CXS API using a real browser
 * session (needed to pass Cloudflare + CSRF). Falls back through:
 *   1. direct detail endpoint (clean Workday URLs)
 *   2. search-by-job-id (handles aggregator-mangled URLs)
 */
export async function scrapeWorkdayJob(rawUrl: string): Promise<WorkdayResult> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { status: "unsupported" };
  }
  if (!/\.myworkdayjobs\.com$/i.test(parsed.hostname)) return { status: "unsupported" };

  const tenant = parsed.hostname.split(".")[0];
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) return { status: "unsupported" };
  const startsWithLocale = /^[a-z]{2}-[A-Z]{2}$/.test(segments[0]);
  const pathSegments = startsWithLocale ? segments.slice(1) : segments;
  const site = pathSegments[0];
  const detailPath = "/" + pathSegments.slice(1).join("/"); // e.g. /job/City/Title_JR_0000894
  if (!site || detailPath.length < 5) return { status: "unsupported" };

  const cxsBase = `${parsed.origin}/wday/cxs/${tenant}/${site}`;

  // Job id from the last URL segment (longest digit run, >=4 digits).
  const lastSegment = pathSegments[pathSegments.length - 1] ?? "";
  const digitMatch = lastSegment.match(/\d{4,}/g);
  const jobIdDigits = digitMatch ? digitMatch[digitMatch.length - 1] : null;
  const titleGuess = lastSegment
    .replace(/[_-]?\b[a-z]{0,3}_?\d{4,}\b.*$/i, "")
    .replace(/[_-]+/g, " ")
    .trim();

  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    locale: "en-US",
    extraHTTPHeaders: { "Accept-Language": "en-US,en;q=0.9" },
  });

  try {
    const page = await context.newPage();
    await page.goto(`${parsed.origin}/${site}`, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page.waitForTimeout(800);

    // 1. Direct detail endpoint (works for clean Workday URLs).
    try {
      const direct = await page.request.get(`${cxsBase}${detailPath}`, {
        headers: { Accept: "application/json" },
      });
      if (direct.ok()) {
        const text = formatWorkdayDetail((await direct.json()) as WorkdayDetail);
        if (text) return { status: "ok", text };
      }
    } catch {
      // fall through to search
    }

    // 2. Search by job id (handles mangled/aggregator URLs).
    if (jobIdDigits) {
      const searchTexts = [titleGuess, ""].filter(
        (v, i, arr) => arr.indexOf(v) === i
      );
      for (const searchText of searchTexts) {
        for (let offset = 0; offset < 200; offset += 20) {
          const res = await page.request.post(`${cxsBase}/jobs`, {
            data: { appliedFacets: {}, limit: 20, offset, searchText },
            headers: { "Content-Type": "application/json", Accept: "application/json" },
          });
          if (!res.ok()) break;
          const body = (await res.json()) as {
            jobPostings?: {
              externalPath?: string;
              bulletFields?: string[];
            }[];
          };
          const postings = body.jobPostings ?? [];
          for (const posting of postings) {
            const hay = `${posting.externalPath ?? ""} ${(posting.bulletFields ?? []).join(" ")}`;
            if (posting.externalPath && hay.includes(jobIdDigits)) {
              const detail = await page.request.get(`${cxsBase}${posting.externalPath}`, {
                headers: { Accept: "application/json" },
              });
              if (detail.ok()) {
                const text = formatWorkdayDetail((await detail.json()) as WorkdayDetail);
                if (text) return { status: "ok", text };
              }
            }
          }
          if (postings.length < 20) break;
        }
      }
    }

    return { status: "not_found" };
  } finally {
    await context.close().catch(() => {});
  }
}
