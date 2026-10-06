import { NextResponse } from "next/server";

/**
 * Server-side gate for the scanner.
 *
 * Two ways in, both fail closed when their env var is missing or blank:
 * - Authorization: Bearer <CRON_SECRET>  (Vercel cron and other server callers)
 * - httpOnly session cookie signed with SESSION_SECRET, issued after APP_PASSWORD
 *
 * The cookie is never a raw password. Callers must use a constant-time compare.
 */

export const SESSION_COOKIE_NAME = "oes_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

const BEARER_PREFIX = "bearer ";

function readEnv(name: string): string | null {
  const value = process.env[name];
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.trim().length === 0) return null;
  return value;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const pad = (4 - (value.length % 4)) % 4;
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Compare two strings without leaking the match prefix. Empty values never match. */
export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  if (a.length === 0 || b.length === 0) return false;
  const encoder = new TextEncoder();
  const [digestA, digestB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const left = new Uint8Array(digestA);
  const right = new Uint8Array(digestB);
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left[i] ^ right[i];
  return diff === 0;
}

async function sign(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return bytesToBase64Url(new Uint8Array(signature));
}

/**
 * Lax, not Strict: Schwab sends the browser back with a cross-site top-level GET.
 * Strict cookies are omitted on that request, so the callback looked logged-out
 * and middleware bounced her through /login forever.
 * httpOnly and Secure stay on. The value is the signed session token.
 */
export function sessionCookieOptions(maxAge: number = SESSION_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

/** OAuth state lives only long enough to finish the Schwab redirect. */
export const OAUTH_STATE_MAX_AGE_SECONDS = 60 * 10;

/** Signed, httpOnly, Secure, SameSite=Lax. Same cross-site reason as the session cookie. */
export function oauthStateCookieOptions(maxAge: number = OAUTH_STATE_MAX_AGE_SECONDS) {
  return {
    httpOnly: true,
    secure: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge,
  };
}

/**
 * Cookie value is `v1.<payload>.<hmac>`, not the raw state.
 * The payload carries the state and an expiry. SESSION_SECRET signs it.
 */
export async function createSignedOAuthState(
  state: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<string | null> {
  const secret = readEnv("SESSION_SECRET");
  if (!secret) return null;
  if (state.length === 0 || state.length > 256) return null;
  const exp = nowSeconds + OAUTH_STATE_MAX_AGE_SECONDS;
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ state, exp })));
  const signature = await sign(secret, `oes-oauth-state.v1.${payload}`);
  return `v1.${payload}.${signature}`;
}

/** True only when the cookie is signed, unexpired, and binds this exact state. */
export async function verifySignedOAuthState(
  cookieValue: string | undefined | null,
  state: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const secret = readEnv("SESSION_SECRET");
  if (!secret || !cookieValue || state.length === 0) return false;
  const parts = cookieValue.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const payload = parts[1];
  const signature = parts[2];
  if (!payload || !signature) return false;
  const expected = await sign(secret, `oes-oauth-state.v1.${payload}`);
  if (!(await timingSafeEqual(signature, expected))) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as {
      state?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.state !== "string" || parsed.state.length === 0) return false;
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) return false;
    if (parsed.exp < nowSeconds) return false;
    return timingSafeEqual(parsed.state, state);
  } catch {
    return false;
  }
}

export function getCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  const parts = header.split(";");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq);
    if (key !== name) continue;
    const raw = part.slice(eq + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * True only when Authorization is `Bearer <CRON_SECRET>`.
 * Query strings and the legacy x-cron-secret header are ignored.
 * Missing CRON_SECRET fails closed.
 */
export async function hasValidBearer(request: Request): Promise<boolean> {
  const secret = readEnv("CRON_SECRET");
  if (!secret) return false;
  const header = request.headers.get("authorization");
  if (!header) return false;
  if (header.length < BEARER_PREFIX.length) return false;
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return false;
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0 || token.length > 4096) return false;
  return timingSafeEqual(token, secret);
}

/** Missing APP_PASSWORD fails closed. The submitted password is never logged. */
export async function checkAppPassword(password: string): Promise<boolean> {
  const expected = readEnv("APP_PASSWORD");
  if (!expected) return false;
  if (password.length === 0 || password.length > 1024) return false;
  return timingSafeEqual(password, expected);
}

export function authEnvReady(): boolean {
  return readEnv("APP_PASSWORD") !== null && readEnv("SESSION_SECRET") !== null;
}

export async function createSessionToken(): Promise<string | null> {
  const secret = readEnv("SESSION_SECRET");
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = bytesToBase64Url(new TextEncoder().encode(JSON.stringify({ v: 1, exp })));
  const signature = await sign(secret, `oes-session.v1.${payload}`);
  return `v1.${payload}.${signature}`;
}

export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  const secret = readEnv("SESSION_SECRET");
  if (!secret || !token) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const payload = parts[1];
  const signature = parts[2];
  if (!payload || !signature) return false;
  const expected = await sign(secret, `oes-session.v1.${payload}`);
  if (!(await timingSafeEqual(signature, expected))) return false;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload))) as { exp?: unknown };
    if (typeof parsed.exp !== "number" || !Number.isFinite(parsed.exp)) return false;
    if (parsed.exp < Math.floor(Date.now() / 1000)) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Health monitor. HEALTH_TOKEN when it is set. CRON_SECRET only when HEALTH_TOKEN is unset.
 * A session cookie is not enough. The token is never logged.
 */
export async function hasHealthBearer(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
  const token = bearerToken(request);
  if (!token) return false;
  const health = readEnvFrom(env, "HEALTH_TOKEN");
  if (health) return timingSafeEqual(token, health);
  const cron = readEnvFrom(env, "CRON_SECRET");
  if (!cron) return false;
  return timingSafeEqual(token, cron);
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) return null;
  if (header.length < BEARER_PREFIX.length) return null;
  if (header.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  if (token.length === 0 || token.length > 4096) return null;
  return token;
}

function readEnvFrom(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name];
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.trim().length === 0) return null;
  return value;
}

/** Bearer token or a valid app session. Either missing secret fails that path closed. */
export async function isAuthorized(request: Request): Promise<boolean> {
  if (await hasValidBearer(request)) return true;
  return verifySessionToken(getCookie(request, SESSION_COOKIE_NAME));
}

export async function denyIfUnauthorized(request: Request): Promise<NextResponse | null> {
  if (await isAuthorized(request)) return null;
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}
