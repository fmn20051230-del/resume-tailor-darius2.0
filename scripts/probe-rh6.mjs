const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
  Referer:
    "https://mphasis.ripplehire.com/candidate/?token=QBghj9dAEVmZUtMzyrCx",
};
const url =
  "https://mphasis.ripplehire.com/candidate/candidatejobdetail?token=QBghj9dAEVmZUtMzyrCx&jobSeq=881303&lang=en";
const j = await (await fetch(url, { headers })).json();
console.log("top keys", Object.keys(j));
const job = j.jobVO || j.job || j;
console.log("job keys", Object.keys(job));
const long = Object.entries(job)
  .filter(([, v]) => typeof v === "string" && v.length > 40)
  .map(([k, v]) => [k, v.length, v.slice(0, 120)]);
console.log(long);
if (j.jobVO) {
  const long2 = Object.entries(j.jobVO)
    .filter(([, v]) => typeof v === "string" && v.length > 40)
    .map(([k, v]) => [k, v.length, v.slice(0, 120)]);
  console.log("jobVO long", long2);
  console.log("title", j.jobVO.jobTitle || j.jobVO.title);
}
