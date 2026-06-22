import { NextRequest, NextResponse } from "next/server";

const DEFAULT_LOG_SERVER_URL = "https://resume-tailor-log-server.vercel.app";
const DEFAULT_LOG_SERVER_API_KEY = "fmn";

export async function POST(request: NextRequest) {
  const serverUrl = process.env.LOG_SERVER_URL?.trim() || DEFAULT_LOG_SERVER_URL;
  const apiKey =
    process.env.LOG_SERVER_API_KEY?.trim() || DEFAULT_LOG_SERVER_API_KEY;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/api/logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      return NextResponse.json(
        { ok: false, error: (data as { error?: string }).error ?? "Log server error" },
        { status: res.status }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Log server unreachable",
      },
      { status: 502 }
    );
  }
}
