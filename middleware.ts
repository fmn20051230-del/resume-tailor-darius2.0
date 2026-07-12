import { NextRequest, NextResponse } from "next/server";

function getAllowedIps(): string[] {
  const raw = process.env.ALLOWED_IPS;
  if (!raw || !raw.trim()) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function getClientIp(request: NextRequest): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = request.headers.get("x-real-ip");
  if (real) return real.trim();
  return "unknown";
}

/** LibreOffice WASM in the browser needs SharedArrayBuffer (COOP + COEP). */
function withWasmHeaders(response: NextResponse, pathname: string): NextResponse {
  if (
    pathname.startsWith("/automation") ||
    pathname.startsWith("/lo-wasm")
  ) {
    response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
    response.headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    // Allow same-origin WASM/worker fetches under COEP.
    response.headers.set("Cross-Origin-Resource-Policy", "same-origin");
  }
  return response;
}

export function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const allowed = getAllowedIps();

  if (allowed.length === 0) {
    return withWasmHeaders(NextResponse.next(), pathname);
  }

  if (request.nextUrl.pathname.startsWith("/api/docx/staged/")) {
    return withWasmHeaders(NextResponse.next(), pathname);
  }

  // Static WASM assets must stay reachable for PDF conversion.
  if (pathname.startsWith("/lo-wasm")) {
    return withWasmHeaders(NextResponse.next(), pathname);
  }

  const clientIp = getClientIp(request);
  if (allowed.includes(clientIp)) {
    return withWasmHeaders(NextResponse.next(), pathname);
  }

  if (request.nextUrl.pathname === "/blocked") {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL("/blocked", request.url));
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
