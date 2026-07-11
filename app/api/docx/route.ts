import { NextRequest, NextResponse } from "next/server";
import { fillTemplateDocx } from "@/lib/fill-template-docx";
import { saveSlotDocx } from "@/lib/generated-docx-store";

function safeFilename(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "resume.docx";
  return trimmed.toLowerCase().endsWith(".docx") ? trimmed : `${trimmed}.docx`;
}

export async function POST(request: NextRequest) {
  let body: {
    content?: string;
    baseResume?: string;
    filename?: string;
    slot?: number;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!content) {
    return NextResponse.json({ error: "Missing or empty content" }, { status: 400 });
  }

  const baseResume = typeof body.baseResume === "string" ? body.baseResume : "";
  const filename = safeFilename(typeof body.filename === "string" ? body.filename : "resume");
  const slot = body.slot;

  try {
    const buffer = fillTemplateDocx(content, baseResume);

    // Persist to disk only for local "Open in Word"; Vercel uses the response blob download.
    if (
      !process.env.VERCEL &&
      typeof slot === "number" &&
      Number.isInteger(slot) &&
      slot >= 0 &&
      slot <= 3
    ) {
      saveSlotDocx(slot, buffer);
    }

    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": `attachment; filename="${filename.replace(/[^\w.\-() ]+/g, "_")}"`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "DOCX generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
