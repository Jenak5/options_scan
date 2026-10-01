import { NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, sessionCookieOptions } from "@/app/lib/auth";

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(SESSION_COOKIE_NAME, "", sessionCookieOptions(0));
  return response;
}
