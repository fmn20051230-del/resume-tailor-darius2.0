import { NextRequest, NextResponse } from "next/server";
import { getStagedDocx } from "@/lib/staged-docx-store";

export async function GET(
  _request: NextRequest,
  { params }: { params: { token: string } }
) {
  const staged = await getStagedDocx(params.token);
  if (!staged) {
    return NextResponse.json({ error: "File not found or expired" }, { status: 404 });
  }

  const safeName = staged.filename.replace(/[^\w.\-() ]+/g, "_");
  return new NextResponse(new Uint8Array(staged.buffer), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `inline; filename="${safeName}"`,
      "Cache-Control": "private, max-age=600",
    },
  });
}
