import { NextRequest, NextResponse } from "next/server";
import {
  getCookie,
  oauthStateCookieOptions,
  SESSION_COOKIE_NAME,
  verifySessionToken,
  verifySignedOAuthState,
} from "@/app/lib/auth";
import { redirectPath } from "@/app/lib/redirect";
import { safeNextPath } from "@/app/lib/safeNext";
import { SCHWAB_STATE_COOKIE, exchangeAuthorizationCode } from "@/app/lib/schwab";
import { resolveStoreKind, writeTokens } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/**
 * Schwab redirects the browser here after the owner approves Market Data.
 * SameSite=Lax sends both the session cookie and the signed state cookie on
 * that cross-site GET. Both have to check out. A missing session goes back
 * to /login?next=this URL so the exchange can finish after sign-in.
 * Failures land on the dashboard with an error banner. They do not start
 * another Schwab redirect.
 */
export async function GET(request: NextRequest) {
  const sessionOk = await verifySessionToken(getCookie(request, SESSION_COOKIE_NAME));
  if (!sessionOk) return redirectToLogin(request);

  const params = request.nextUrl.searchParams;
  const state = params.get("state") ?? "";
  const stateOk = await verifySignedOAuthState(request.cookies.get(SCHWAB_STATE_COOKIE)?.value, state);
  if (!stateOk) return finish("/?schwab=error&reason=state");

  if (params.get("error")) return finish("/?schwab=error&reason=denied");

  if (resolveStoreKind() === "unconfigured") {
    return finish("/?schwab=error&reason=storage");
  }

  const code = params.get("code") ?? "";
  if (!code) return finish("/?schwab=error&reason=exchange");

  try {
    const tokens = await exchangeAuthorizationCode(code);
    await writeTokens(tokens);
    return finish("/?schwab=connected");
  } catch (err) {
    const storage = err instanceof Error && /storage is not configured/i.test(err.message);
    return finish(storage ? "/?schwab=error&reason=storage" : "/?schwab=error&reason=exchange");
  }
}

function redirectToLogin(request: NextRequest): NextResponse {
  const next = safeNextPath(`${request.nextUrl.pathname}${request.nextUrl.search}`);
  const params = new URLSearchParams();
  if (next) params.set("next", next);
  const query = params.toString();
  return redirectPath(query ? `/login?${query}` : "/login");
}

function finish(path: string): NextResponse {
  const response = redirectPath(path);
  response.cookies.set(SCHWAB_STATE_COOKIE, "", oauthStateCookieOptions(0));
  return response;
}
