import { NextResponse } from "next/server";

/**
 * Send the browser to a path on this same host.
 * An absolute URL built from request.url can swap 127.0.0.1 for localhost
 * (or an internal host), and the session cookie is then missing on the next hop.
 */
export function redirectPath(path: string): NextResponse {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("\n")) {
    throw new Error("Redirect path must stay on this app");
  }
  return new NextResponse(null, {
    status: 307,
    headers: { Location: path },
  });
}
