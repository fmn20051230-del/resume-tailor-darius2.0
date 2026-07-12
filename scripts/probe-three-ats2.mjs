import * as cheerio from "cheerio";

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/json,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

// --- Recruiterflow ---
{
  const url = "https://recruiterflow.com/recruitingfromscratch/jobs/3949";
  const html = await (await fetch(url, { headers })).text();
  const ld = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  console.log("\nRF ld count", ld.length);
  for (const m of ld) {
    try {
      const j = JSON.parse(m[1]);
      console.log("RF ld type", j["@type"], "keys", Object.keys(j).slice(0, 20));
      if (j.description) console.log("RF desc len", String(j.description).length, String(j.description).slice(0, 200));
      if (j.title) console.log("RF title", j.title);
    } catch {}
  }
  // also try careers API
  for (const api of [
    "https://recruiterflow.com/api/careers/job?company=recruitingfromscratch&job_id=3949",
    "https://recruiterflow.com/api/careers/jobs/3949?company=recruitingfromscratch",
    "https://recruiterflow.com/api/public/job/3949?company=recruitingfromscratch",
  ]) {
    const r = await fetch(api, { headers: { ...headers, Accept: "application/json", Referer: url } });
    const t = await r.text();
    console.log("RF api", r.status, api.slice(40), t.slice(0, 180).replace(/\s+/g, " "));
  }
}

// --- Oracle ---
{
  const domain = "eeho.fa.us2.oraclecloud.com";
  const jobId = "339424";
  // Discover siteNumber from HTML
  const pageUrl = `https://${domain}/hcmUI/CandidateExperience/en/sites/jobsearch/job/${jobId}`;
  const html = await (await fetch(pageUrl, { headers })).text();
  console.log("\nOracle og:title", (html.match(/property="og:title"\s+content="([^"]+)"/) || [])[1]);
  console.log("Oracle og:desc len", ((html.match(/property="og:description"\s+content="([^"]+)"/) || [])[1] || "").length);
  const siteHints = [...html.matchAll(/siteNumber["'\s:=]+([A-Z0-9_]+)/gi)].map((m) => m[1]);
  const siteHints2 = [...html.matchAll(/sites\/([a-zA-Z0-9_-]+)/g)].map((m) => m[1]);
  console.log("site hints", [...new Set([...siteHints, ...siteHints2])].slice(0, 20));
  // Common CX site numbers / from path jobsearch
  const siteCandidates = ["CX_1", "CX_1001", "jobsearch", "CX_45001", "CX"];
  for (const site of ["jobsearch", ...siteHints.slice(0, 5)]) {
    const api = `https://${domain}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${jobId}%22,siteNumber=${site}`;
    const r = await fetch(api, {
      headers: {
        ...headers,
        Accept: "application/vnd.oracle.adf.resourceitem+json, application/json",
        "ora-irc-language": "en",
        "ora-irc-cx-userid": crypto.randomUUID(),
        Referer: pageUrl,
      },
    });
    const t = await r.text();
    console.log("Oracle detail", site, r.status, t.slice(0, 220).replace(/\s+/g, " "));
  }
}

// --- Ripplehire ---
{
  const jobId = "881303";
  const token = "QBghj9dAEVmZUtMzyrCx";
  const page = `https://mphasis.ripplehire.com/candidate/?token=${token}`;
  const html = await (await fetch(page, { headers })).text();
  console.log("\nRH JobPosting sample", html.includes("JobPosting"));
  // Find script endpoints
  const endpoints = [...html.matchAll(/["'](\/candidate\/[^"']+)["']/g)].map((m) => m[1]);
  console.log("RH endpoints", [...new Set(endpoints)].filter((e) => /job|detail|req|api/i.test(e)).slice(0, 40));
  for (const path of [
    `/candidate/jobdetail/${jobId}`,
    `/candidate/getjobdetail/${jobId}`,
    `/candidate/rest/job/${jobId}`,
    `/candidate/api/job/${jobId}`,
    `/candidate/job/${jobId}`,
    `/candidate/getJobDetails?jobId=${jobId}`,
    `/candidate/jobdetails?jobId=${jobId}&token=${token}`,
  ]) {
    const api = `https://mphasis.ripplehire.com${path}`;
    const r = await fetch(api, {
      headers: { ...headers, Accept: "application/json, text/html,*/*", Referer: page, "X-Requested-With": "XMLHttpRequest" },
    });
    const t = await r.text();
    console.log("RH", r.status, path, t.slice(0, 160).replace(/\s+/g, " "));
  }
}
