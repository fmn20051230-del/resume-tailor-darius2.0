const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};
const main = await (
  await fetch(
    "https://mphasis.ripplehire.com/candidate/candresource/candidate/require_main.js",
    { headers }
  )
).text();
console.log(main.slice(4000));

const candidates = [
  "apps/candidate.js",
  "app.js",
  "apps/app.js",
  "entities/job.js",
  "entities/jobdetail.js",
  "apps/job/job_app.js",
  "apps/jobdetail/jobdetail_app.js",
  "apps/detail/detail_app.js",
];
for (const c of candidates) {
  const url = `https://mphasis.ripplehire.com/candidate/candresource/candidate/${c}?v=v735`;
  const r = await fetch(url, { headers });
  console.log(c, r.status, (await r.text()).slice(0, 80).replace(/\s+/g, " "));
}
