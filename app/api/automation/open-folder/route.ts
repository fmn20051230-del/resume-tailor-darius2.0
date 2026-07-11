import { NextRequest, NextResponse } from "next/server";
import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import fs from "fs";

const execAsync = promisify(exec);

export async function POST(request: NextRequest) {
  let body: { folderPath?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const folderPath = typeof body.folderPath === "string" ? body.folderPath.trim() : "";
  if (!folderPath) {
    return NextResponse.json({ error: "Missing folderPath" }, { status: 400 });
  }

  const resolved = path.resolve(folderPath);
  if (!fs.existsSync(resolved)) {
    return NextResponse.json({ error: "Folder does not exist" }, { status: 404 });
  }

  try {
    if (process.platform === "win32") {
      await execAsync(`explorer "${resolved.replace(/"/g, '\\"')}"`);
    } else if (process.platform === "darwin") {
      await execAsync(`open "${resolved.replace(/"/g, '\\"')}"`);
    } else {
      await execAsync(`xdg-open "${resolved.replace(/"/g, '\\"')}"`);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not open folder" },
      { status: 500 }
    );
  }
}
