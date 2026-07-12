const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/javascript, */*; q=0.01",
  "X-Requested-With": "XMLHttpRequest",
  "Accept-Language": "en-US,en;q=0.9",
  Referer:
    "https://mphasis.ripplehire.com/candidate/?token=QBghj9dAEVmZUtMzyrCx",
};

const token = "QBghj9dAEVmZUtMzyrCx";
const jobSeq = "881303";

for (const base of [
  "https://mphasis.ripplehire.com/candidate/",
  "https://mphasis.ripplehire.com/",
  "https://mphasis.ripplehire.com/candidate/candresource/candidate/",
]) {
  const url = new URL("candidatejobdetail", base);
  url.searchParams.set("token", token);
  url.searchParams.set("jobSeq", jobSeq);
  url.searchParams.set("lang", "en");
  const r = await fetch(url, { headers });
  const t = await r.text();
  console.log(r.status, url.toString().slice(0, 100), t.slice(0, 250).replace(/\s+/g, " "));
}

// Also try with id in path (Backbone model id)
for (const path of [
  `candidatejobdetail/${jobSeq}?token=${token}&jobSeq=${jobSeq}&lang=en`,
  `candidatejobdetail?token=${token}&jobSeq=${jobSeq}&lang=en&source=`,
]) {
  const url = `https://mphasis.ripplehire.com/candidate/${path}`;
  const r = await fetch(url, { headers });
  const t = await r.text();
  console.log("alt", r.status, t.slice(0, 200).replace(/\s+/g, " "));
}
