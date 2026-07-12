const headers = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
};

// Oracle full fields
{
  const domain = "eeho.fa.us2.oraclecloud.com";
  const jobId = "339424";
  const site = "CX_45001";
  const api = `https://${domain}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails?expand=all&onlyData=true&finder=ById;Id=%22${jobId}%22,siteNumber=${site}`;
  const r = await fetch(api, {
    headers: {
      ...headers,
      Accept: "application/json",
      "ora-irc-language": "en",
      "ora-irc-cx-userid": crypto.randomUUID(),
    },
  });
  const j = await r.json();
  const item = j.items?.[0];
  console.log("Oracle keys", Object.keys(item || {}));
  const htmlFields = Object.entries(item || {})
    .filter(([, v]) => typeof v === "string" && v.length > 80)
    .map(([k, v]) => [k, v.length, String(v).slice(0, 100)]);
  console.log("Oracle long strings", htmlFields);
}

// Ripplehire - download main JS / find APIs
{
  const page = "https://mphasis.ripplehire.com/candidate/?token=QBghj9dAEVmZUtMzyrCx";
  const html = await (
    await fetch(page, {
      headers: { ...headers, Accept: "text/html" },
    })
  ).text();
  const scripts = [...html.matchAll(/src=["']([^"']+\.js[^"']*)["']/gi)].map((m) => m[1]);
  console.log("\nRH scripts", scripts.slice(0, 25));
  // Also look for ld+json
  const ld = [...html.matchAll(/application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  console.log("RH ld", ld.length, ld[0]?.[1]?.slice(0, 300));
  // Try common RH patterns with POST
  for (const [method, path, body] of [
    ["POST", "/candidate/getjobdetails", JSON.stringify({ jobId: 881303 })],
    ["POST", "/candidate/jobDetail", JSON.stringify({ jobId: "881303" })],
    ["GET", "/candidate/openings/881303", null],
    ["GET", "/candidate/jobOpening/881303", null],
    ["GET", "/candidate/public/job/881303", null],
    ["GET", "/candidate/candresource/jobs/881303.json", null],
    ["GET", "/candidate/getAllJobs?token=QBghj9dAEVmZUtMzyrCx", null],
  ]) {
    const r = await fetch(`https://mphasis.ripplehire.com${path}`, {
      method,
      headers: {
        ...headers,
        Referer: page,
        Origin: "https://mphasis.ripplehire.com",
        "Content-Type": "application/json",
        "X-Requested-With": "XMLHttpRequest",
      },
      body: body || undefined,
    });
    const t = await r.text();
    console.log(method, r.status, path, t.slice(0, 150).replace(/\s+/g, " "));
  }
}
