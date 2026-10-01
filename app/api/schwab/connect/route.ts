import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { SCHWAB_STATE_COOKIE, schwabAuthorizeUrl, schwabConfigured } from "@/app/lib/schwab";

export const dynamic = "force-dynamic";

/** Starts the Schwab authorization-code flow. The browser comes back to /api/schwab/callback. */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;
  if (!schwabConfigured()) {
    return NextResponse.json({ error: "Schwab market data is not configured" }, { status: 503 });
  }

  const state = randomState();
  let destination: string;
  try {
    destination = schwabAuthorizeUrl(state);
  } catch {
    return NextResponse.json({ error: "Schwab market data is not configured" }, { status: 503 });
  }

  const response = NextResponse.redirect(destination);
  response.cookies.set(SCHWAB_STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 10,
  });
  return response;
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
