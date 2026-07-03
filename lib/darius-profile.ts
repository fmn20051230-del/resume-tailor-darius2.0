import type { ResumeEducation, ResumeJob } from "./parse-resume-markdown";

export type DariusFixedJob = {
  company: string;
  period: string;
  aliases: string[];
};

/** Fixed companies and dates from template.docx. */
export const DARIUS_FIXED_JOBS: DariusFixedJob[] = [
  {
    company: "Texicare",
    period: "Jul 2021 - May 2026",
    aliases: ["texicare"],
  },
  {
    company: "HCL Technologies",
    period: "May 2019 - Jun 2021",
    aliases: ["hcl"],
  },
  {
    company: "Gravity Systems",
    period: "May 2013 - Apr 2019",
    aliases: ["gravity"],
  },
];

/** Fixed education from the current template.docx. */
export const DARIUS_FIXED_EDUCATION: ResumeEducation = {
  university: "University of Arkansas Grantham, Little Rock AR",
  degreeLine: "M.Sc. Information Technology",
  period: "2018 - 2020",
};

/** Canonical header contact from template.docx — always used in generated resumes. */
export const DARIUS_PHONE = "+1 (872) 234-8844";
export const DARIUS_EMAIL = "dariuscampbell399@gmail.com";
export const DARIUS_LOCATION = "Leander, TX";

function matchesFixedJob(job: ResumeJob, fixed: DariusFixedJob): boolean {
  const hay = `${job.company} ${job.role}`.toLowerCase();
  return fixed.aliases.some((alias) => hay.includes(alias));
}

export function mergeDariusExperience(parsed: ResumeJob[]): ResumeJob[] {
  const used = new Set<number>();

  return DARIUS_FIXED_JOBS.map((fixed, index) => {
    let source: ResumeJob | undefined;
    for (let i = 0; i < parsed.length; i++) {
      if (used.has(i)) continue;
      if (matchesFixedJob(parsed[i], fixed)) {
        source = parsed[i];
        used.add(i);
        break;
      }
    }
    if (!source && index < parsed.length && !used.has(index)) {
      source = parsed[index];
      used.add(index);
    }

    return {
      company: fixed.company,
      location: source?.location ?? "",
      period: fixed.period,
      role: source?.role?.trim() || "",
      bullets: source?.bullets ?? [],
    };
  });
}

export function mergeDariusEducation(_parsed: ResumeEducation[]): ResumeEducation[] {
  return [{ ...DARIUS_FIXED_EDUCATION }];
}
