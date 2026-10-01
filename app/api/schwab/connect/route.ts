import { NextRequest, NextResponse } from "next/server";
import { createSignedOAuthState, denyIfUnauthorized, oauthStateCookieOptions } from "@/app/lib/auth";
import { redirectPath } from "@/app/lib/redirect";
import { SCHWAB_STATE_COOKIE, schwabAuthorizeUrl, schwabConfigured } from "@/app/lib/schwab";
import { resolveStoreKind } from "@/app/lib/schwabStore";

export const dynamic = "force-dynamic";

/** Starts the Schwab authorization-code flow. The browser comes back to /api/schwab/callback. */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  if (resolveStoreKind() === "unconfigured") {
    return redirectPath("/?schwab=error&reason=storage");
  }

  if (!schwabConfigured()) {
    return NextResponse.json({ error: "Schwab market data is not configured" }, { status: 503 });
  }

  const state = randomState();
  const signed = await createSignedOAuthState(state);
  if (!signed) {
    return NextResponse.json({ error: "Sign-in is not configured" }, { status: 503 });
  }

  let destination: string;
  try {
    destination = schwabAuthorizeUrl(state);
  } catch {
    return NextResponse.json({ error: "Schwab market data is not configured" }, { status: 503 });
  }

  const response = NextResponse.redirect(destination);
  response.cookies.set(SCHWAB_STATE_COOKIE, signed, oauthStateCookieOptions());
  return response;
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
