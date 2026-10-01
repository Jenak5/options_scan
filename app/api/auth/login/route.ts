import { NextRequest, NextResponse } from "next/server";
import {
  authEnvReady,
  checkAppPassword,
  createSessionToken,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
} from "@/app/lib/auth";

export async function POST(request: NextRequest) {
  if (!authEnvReady()) {
    return NextResponse.json({ error: "Sign-in is not configured" }, { status: 503 });
  }

  let password = "";
  try {
    const body = await request.json();
    if (body && typeof body.password === "string") password = body.password;
  } catch {
    password = "";
  }

  if (!(await checkAppPassword(password))) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  const token = await createSessionToken();
  if (!token) {
    return NextResponse.json({ error: "Sign-in is not configured" }, { status: 503 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions());
  return response;
}
