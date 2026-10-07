import { NextRequest, NextResponse } from "next/server";
import { isAuthorized } from "@/app/lib/auth";
import { safeNextPath } from "@/app/lib/safeNext";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);

/**
 * These are full browser navigations, not fetch() calls.
 * A missing session should land on /login and come back, including the
 * Schwab callback (code + state) and Reconnect Schwab.
 */
const BROWSER_API_PATHS = new Set(["/api/schwab/callback", "/api/schwab/connect"]);

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Vercel cron authenticates itself with Authorization: Bearer.
  // The Schwab callback is not public: SameSite=Lax sends the session cookie
  // on Schwab's cross-site GET, and the route also checks that session.
  // Cron, the health check, and the market brief authenticate with Authorization: Bearer.
  // Health and the brief accept HEALTH_TOKEN, or CRON_SECRET when that token is unset.
  // A session cookie is not enough for those two routes.
  if (pathname === "/api/cron" || pathname === "/api/health" || pathname === "/api/brief" || PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  let allowed = false;
  try {
    allowed = await isAuthorized(request);
  } catch {
    allowed = false;
  }

  if (allowed) return NextResponse.next();

  if (pathname.startsWith("/api/") && !BROWSER_API_PATHS.has(pathname)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const next = safeNextPath(`${pathname}${request.nextUrl.search}`);
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  if (next) loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
