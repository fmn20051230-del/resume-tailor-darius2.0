const page = "https://mphasis.ripplehire.com/candidate/?token=QBghj9dAEVmZUtMzyrCx";
const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,*/*",
};
const html = await (await fetch(page, { headers })).text();
const idx = html.toLowerCase().indexOf("jobposting");
console.log("jobposting idx", idx, html.slice(Math.max(0, idx - 100), idx + 200));

// require.js config
const req = html.match(/require\.config\((\{[\s\S]*?\})\)/) || html.match(/require\((\{[\s\S]*?\})\)/);
console.log("require?", !!req);

// Find data-main
console.log("data-main", (html.match(/data-main=["']([^"']+)/) || [])[1]);
console.log("require paths", [...html.matchAll(/candresource\/[^"'\\\s]+\.js/gi)].slice(0, 40).map((m) => m[0]));

// Fetch main candidate app JS
const mains = [
  "/candidate/candresource/candidate/js/main.js",
  "/candidate/candresource/candidate/js/app.js",
  "/candidate/candresource/candidate/main.js",
  "/candidate/candresource/js/candidate.js",
];
for (const p of mains) {
  const r = await fetch(`https://mphasis.ripplehire.com${p}`, { headers });
  console.log(p, r.status, r.headers.get("content-type"));
}

// Try require config from page
const scriptsInline = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
for (const s of scriptsInline) {
  if (/require|jobId|detail\/job|getJob/i.test(s)) {
    console.log("INLINE", s.slice(0, 500).replace(/\s+/g, " "));
  }
}
