import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

/** Writable on Vercel/serverless (/tmp only); local dev uses project dir. */
export function getGeneratedDir(): string {
  if (process.env.VERCEL) {
    return path.join(os.tmpdir(), "resume-tailor-generated");
  }
  return path.join(process.cwd(), ".generated-resumes");
}

export function getSlotDocxPath(slot: number): string {
  return path.join(getGeneratedDir(), `slot-${slot}.docx`);
}

export function saveSlotDocx(slot: number, buffer: Buffer): string | null {
  try {
    const dir = getGeneratedDir();
    fs.mkdirSync(dir, { recursive: true });
    const filePath = getSlotDocxPath(slot);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch {
    // Serverless FS may be read-only outside /tmp; download still works via API response.
    return null;
  }
}

export function slotDocxExists(slot: number): boolean {
  try {
    return fs.existsSync(getSlotDocxPath(slot));
  } catch {
    return false;
  }
}

export function isLocalOpenSupported(): boolean {
  return !process.env.VERCEL;
}

export async function openDocxWithDefaultApp(filePath: string): Promise<void> {
  if (!fs.existsSync(filePath)) {
    throw new Error("Generated file not found. Please generate again.");
  }

  const platform = process.platform;
  if (platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", filePath], { windowsHide: true });
    return;
  }
  if (platform === "darwin") {
    await execFileAsync("open", [filePath]);
    return;
  }
  await execFileAsync("xdg-open", [filePath]);
}
