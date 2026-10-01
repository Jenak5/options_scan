import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/app/lib/auth";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Vercel cron authenticates itself with Authorization: Bearer.
  // The Schwab callback is a cross-site redirect, so the SameSite=Strict
  // session cookie is not sent. The route checks the OAuth state cookie.
  if (pathname === "/api/cron" || pathname === "/api/schwab/callback" || PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  let allowed = false;
  try {
    allowed = await isAuthorized(request);
  } catch {
    allowed = false;
  }

  if (allowed) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
