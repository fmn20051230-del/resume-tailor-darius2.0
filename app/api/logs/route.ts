import { NextRequest, NextResponse } from "next/server";
import { getLogs } from "@/lib/generation-log";

export async function GET(request: NextRequest) {
  const key = request.nextUrl.searchParams.get("key");
  const secret = process.env.LOG_VIEWER_SECRET;
  if (!secret || key !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const page = Math.max(1, parseInt(request.nextUrl.searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(request.nextUrl.searchParams.get("limit") ?? "20", 10) || 20));
  const ip = request.nextUrl.searchParams.get("ip") ?? "";
  const filename = request.nextUrl.searchParams.get("filename") ?? "";

  const { logs, total } = await getLogs({ page, limit, ip: ip || undefined, filename: filename || undefined });
  return NextResponse.json({ logs, total, page, limit });
}
