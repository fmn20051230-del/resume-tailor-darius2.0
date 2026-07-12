import { scrapeJobPage } from "../lib/automation/scraper";

const urls = [
  "https://mphasis.ripplehire.com/candidate/?token=QBghj9dAEVmZUtMzyrCx#detail/job/881303",
  "https://recruiterflow.com/recruitingfromscratch/jobs/3949",
  "https://eeho.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/339424",
];

async function main() {
  for (const url of urls) {
    process.stdout.write(`\n=== ${url}\n`);
    try {
      const text = await scrapeJobPage(url);
      console.log("OK", text.length, "chars");
      console.log(text.slice(0, 280).replace(/\n/g, " | "));
    } catch (e) {
      console.log("FAIL", e instanceof Error ? e.message : e);
    }
  }
}

main();
