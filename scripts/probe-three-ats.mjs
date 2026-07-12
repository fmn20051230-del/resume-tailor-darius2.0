const urls = [
  "https://mphasis.ripplehire.com/candidate/?token=QBghj9dAEVmZUtMzyrCx#detail/job/881303",
  "https://recruiterflow.com/recruitingfromscratch/jobs/3949",
  "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/339424",
];

const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

for (const url of urls) {
  console.log("\n====", url);
  try {
    const r = await fetch(url, { headers, redirect: "follow" });
    const t = await r.text();
    console.log("status", r.status, "final", r.url, "len", t.length);
    console.log("title", (t.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.slice(0, 120));
    console.log("has __NEXT_DATA__", /__NEXT_DATA__/.test(t));
    console.log("has JobPosting", /JobPosting/.test(t));
    console.log("sample", t.replace(/\s+/g, " ").slice(0, 400));
    const apis = [...t.matchAll(/https?:\/\/[^"'\\\s]{10,120}/g)]
      .map((m) => m[0])
      .filter((u) => /api|graphql|job|requisition|ripple|recruiterflow|oracle/i.test(u))
      .slice(0, 15);
    console.log("url hints", apis);
  } catch (e) {
    console.log("FAIL", e.message);
  }
}
