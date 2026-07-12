const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};
const base = "https://mphasis.ripplehire.com/candidate/candresource/candidate/";

const jobJs = await (await fetch(base + "entities/job.js?v=v735", { headers })).text();
console.log("=== job.js ===\n", jobJs);

const appJs = await (await fetch(base + "app.js?v=v735", { headers })).text();
console.log("\n=== app.js len", appJs.length);
const urls = [...appJs.matchAll(/url\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]);
console.log("urls in app", urls);
const jobRefs = [...appJs.matchAll(/job[^"']{0,40}/gi)].slice(0, 30).map((m) => m[0]);
console.log("job refs", jobRefs);
