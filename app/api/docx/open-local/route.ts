import { NextRequest, NextResponse } from "next/server";
import {
  getSlotDocxPath,
  isLocalOpenSupported,
  openDocxWithDefaultApp,
  slotDocxExists,
} from "@/lib/generated-docx-store";

export async function POST(request: NextRequest) {
  if (!isLocalOpenSupported()) {
    return NextResponse.json(
      {
        error:
          "Open is only available when running locally. On Vercel, use the downloaded DOCX file.",
      },
      { status: 501 }
    );
  }

  let body: { slot?: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const slot = body.slot;
  if (typeof slot !== "number" || !Number.isInteger(slot) || slot < 0 || slot > 3) {
    return NextResponse.json({ error: "Invalid slot (0–3)" }, { status: 400 });
  }

  if (!slotDocxExists(slot)) {
    return NextResponse.json(
      { error: "No generated resume for this slot. Generate one first." },
      { status: 404 }
    );
  }

  try {
    await openDocxWithDefaultApp(getSlotDocxPath(slot));
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not open file";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
