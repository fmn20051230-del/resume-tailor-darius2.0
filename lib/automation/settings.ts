import { SLOT_LABELS } from "./types";

export const SETTINGS_STORAGE_KEY = "auto-resume-tailor-settings";

export type AutomationSettings = {
  username: string;
  apiKey: string;
  extractionPrompt: string;
  tailoringPrompt: string;
  baseResumes: [string, string, string, string];
  outputDir: string;
  extractionModel: string;
  temperature: number;
  autoCreateFolder: boolean;
};

export const DEFAULT_SETTINGS: AutomationSettings = {
  username: "",
  apiKey: "",
  extractionPrompt: "",
  tailoringPrompt: "",
  baseResumes: ["", "", "", ""],
  outputDir: "output",
  extractionModel: "qwen/qwen3.5-flash-02-23",
  temperature: 0.3,
  autoCreateFolder: true,
};

export const SLOT_DISPLAY = SLOT_LABELS.map((label, i) => ({
  index: i,
  label: `${i + 1} — ${label}`,
  shortLabel: label,
}));

export function loadSettings(): AutomationSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AutomationSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      baseResumes: [
        parsed.baseResumes?.[0] ?? "",
        parsed.baseResumes?.[1] ?? "",
        parsed.baseResumes?.[2] ?? "",
        parsed.baseResumes?.[3] ?? "",
      ],
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AutomationSettings): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}

export function mergeServerConfig(
  settings: AutomationSettings,
  server: {
    extractionPrompt?: string;
    tailoringPrompt?: string;
    baseResumes?: string[];
    outputDir?: string;
  }
): AutomationSettings {
  return {
    ...settings,
    extractionPrompt: settings.extractionPrompt || server.extractionPrompt || "",
    tailoringPrompt: settings.tailoringPrompt || server.tailoringPrompt || "",
    baseResumes: [
      settings.baseResumes[0] || server.baseResumes?.[0] || "",
      settings.baseResumes[1] || server.baseResumes?.[1] || "",
      settings.baseResumes[2] || server.baseResumes?.[2] || "",
      settings.baseResumes[3] || server.baseResumes?.[3] || "",
    ],
    outputDir: settings.outputDir || server.outputDir || "output",
  };
}
