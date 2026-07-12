const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

const mainUrl =
  "https://mphasis.ripplehire.com/candidate/candresource/candidate/require_main.js";
const main = await (await fetch(mainUrl, { headers })).text();
console.log("main len", main.length);
console.log(main.slice(0, 800));

// paths in require config
const pathMatch = main.match(/paths\s*:\s*\{([\s\S]*?)\}/);
console.log("paths block", pathMatch?.[1]?.slice(0, 1500));

// Fetch likely modules
const mods = [
  "https://mphasis.ripplehire.com/candidate/candresource/candidate/js/jobDetail.js",
  "https://mphasis.ripplehire.com/candidate/candresource/candidate/js/job.js",
  "https://mphasis.ripplehire.com/candidate/candresource/candidate/js/controllers/jobDetailController.js",
  "https://mphasis.ripplehire.com/candidate/candresource/candidate/app.js",
  "https://mphasis.ripplehire.com/candidate/candresource/candidate/js/app.js",
];

// Discover from require_main text
const refs = [...main.matchAll(/["']([^"']*job[^"']*)["']/gi)].map((m) => m[1]);
console.log("job refs", [...new Set(refs)].slice(0, 50));

const allJs = [...main.matchAll(/["'](js\/[^"']+)["']/g)].map((m) => m[1]);
console.log("js modules", [...new Set(allJs)].slice(0, 60));
