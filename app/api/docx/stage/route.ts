import { NextRequest, NextResponse } from "next/server";
import { isStagedOpenAvailable, stageDocx } from "@/lib/staged-docx-store";

function getPublicOrigin(request: NextRequest): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  return `${proto}://${host}`;
}

function safeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "resume.docx";
  return trimmed.toLowerCase().endsWith(".docx") ? trimmed : `${trimmed}.docx`;
}

export async function POST(request: NextRequest) {
  if (!isStagedOpenAvailable()) {
    return NextResponse.json(
      {
        error:
          "Open on Vercel requires Upstash Redis (same as /logs). Add KV_REST_API_URL and KV_REST_API_TOKEN, or use the downloaded file.",
      },
      { status: 503 }
    );
  }

  let buffer: Buffer;
  let filename = "resume.docx";

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "Missing file" }, { status: 400 });
    }
    filename = safeFilename(file.name || "resume.docx");
    buffer = Buffer.from(await file.arrayBuffer());
  } else {
    let body: { data?: string; filename?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid body" }, { status: 400 });
    }
    if (typeof body.data !== "string" || !body.data) {
      return NextResponse.json({ error: "Missing data" }, { status: 400 });
    }
    filename = safeFilename(typeof body.filename === "string" ? body.filename : "resume.docx");
    buffer = Buffer.from(body.data, "base64");
  }

  if (!buffer.length) {
    return NextResponse.json({ error: "Empty file" }, { status: 400 });
  }

  try {
    const token = await stageDocx(buffer, filename);
    const fileUrl = `${getPublicOrigin(request)}/api/docx/staged/${token}`;
    return NextResponse.json({ token, fileUrl, filename });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not stage file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
