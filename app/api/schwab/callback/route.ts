import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "@/app/lib/auth";
import { SCHWAB_STATE_COOKIE, exchangeAuthorizationCode } from "@/app/lib/schwab";
import { writeTokens } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/**
 * Schwab redirects the browser here after the owner approves Market Data.
 * The app session cookie is SameSite=Strict, so it is not sent on this
 * cross-site redirect. The short-lived state cookie (SameSite=Lax) is the
 * check that this browser started the flow. Tokens are stored on the server
 * and never placed on the redirect.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const state = params.get("state") ?? "";
  const cookie = request.cookies.get(SCHWAB_STATE_COOKIE)?.value ?? "";
  const stateOk = state.length > 0 && cookie.length > 0 && await timingSafeEqual(state, cookie);
  if (!stateOk) return finish(request, "/?schwab=error&reason=state");

  if (params.get("error")) return finish(request, "/?schwab=error&reason=denied");

  const code = params.get("code") ?? "";
  if (!code) return finish(request, "/?schwab=error&reason=exchange");

  try {
    const tokens = await exchangeAuthorizationCode(code);
    await writeTokens(tokens);
    return finish(request, "/?schwab=connected");
  } catch {
    return finish(request, "/?schwab=error&reason=exchange");
  }
}

function finish(request: NextRequest, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.url));
  response.cookies.set(SCHWAB_STATE_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
}
