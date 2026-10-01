import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OAUTH_STATE_MAX_AGE_SECONDS,
  SESSION_MAX_AGE_SECONDS,
  createSignedOAuthState,
  oauthStateCookieOptions,
  sessionCookieOptions,
  verifySignedOAuthState,
} from "@/app/lib/auth";
import { redirectPath } from "@/app/lib/redirect";
import { safeNextPath } from "@/app/lib/safeNext";

const savedSecret = process.env.SESSION_SECRET;

beforeEach(() => {
  process.env.SESSION_SECRET = "unit-test-session-secret";
});

afterEach(() => {
  if (savedSecret === undefined) delete process.env.SESSION_SECRET;
  else process.env.SESSION_SECRET = savedSecret;
});

describe("cookie flags", () => {
  it("sets the session cookie to httpOnly, Secure, and SameSite=Lax", () => {
    expect(sessionCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
  });

  it("sets the OAuth state cookie to httpOnly, Secure, SameSite=Lax, and 10 minutes", () => {
    expect(oauthStateCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: OAUTH_STATE_MAX_AGE_SECONDS,
    });
    expect(OAUTH_STATE_MAX_AGE_SECONDS).toBe(600);
  });
});

describe("signed OAuth state", () => {
  const issuedAt = 1_700_000_000;

  it("accepts the state that was signed into the cookie", async () => {
    const state = "fixture-oauth-state";
    const cookie = await createSignedOAuthState(state, issuedAt);
    expect(cookie).toBeTruthy();
    expect(cookie).not.toBe(state);
    expect(cookie?.split(".").length).toBe(3);
    expect(await verifySignedOAuthState(cookie, state, issuedAt)).toBe(true);
    expect(await verifySignedOAuthState(cookie, state, issuedAt + OAUTH_STATE_MAX_AGE_SECONDS)).toBe(true);
  });

  it("rejects a different state, a missing cookie, a tampered cookie, and an expired cookie", async () => {
    const state = "fixture-oauth-state";
    const cookie = await createSignedOAuthState(state, issuedAt);
    expect(cookie).toBeTruthy();
    const token = cookie as string;

    expect(await verifySignedOAuthState(token, "other-state", issuedAt)).toBe(false);
    expect(await verifySignedOAuthState(undefined, state, issuedAt)).toBe(false);
    expect(await verifySignedOAuthState("", state, issuedAt)).toBe(false);
    expect(await verifySignedOAuthState(token, "", issuedAt)).toBe(false);

    const flipped = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    expect(await verifySignedOAuthState(flipped, state, issuedAt)).toBe(false);

    const [version, payload, signature] = token.split(".");
    expect(await verifySignedOAuthState(`${version}.${payload}x.${signature}`, state, issuedAt)).toBe(false);
    expect(await verifySignedOAuthState(`v2.${payload}.${signature}`, state, issuedAt)).toBe(false);

    expect(await verifySignedOAuthState(token, state, issuedAt + OAUTH_STATE_MAX_AGE_SECONDS + 1)).toBe(false);
  });

  it("rejects a cookie signed with a different secret", async () => {
    const cookie = await createSignedOAuthState("fixture-oauth-state", issuedAt);
    process.env.SESSION_SECRET = "different-unit-test-secret";
    expect(await verifySignedOAuthState(cookie, "fixture-oauth-state", issuedAt)).toBe(false);
  });

  it("fails closed when SESSION_SECRET is missing", async () => {
    delete process.env.SESSION_SECRET;
    expect(await createSignedOAuthState("fixture-oauth-state", issuedAt)).toBeNull();
    expect(await verifySignedOAuthState("v1.payload.sig", "fixture-oauth-state", issuedAt)).toBe(false);
  });
});

describe("in-app redirect", () => {
  it("uses a relative Location so the session cookie stays on this host", () => {
    const response = redirectPath("/?schwab=connected");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("/?schwab=connected");
    expect(() => redirectPath("//evil.example")).toThrow(/stay on this app/);
    expect(() => redirectPath("https://evil.example")).toThrow(/stay on this app/);
  });
});

describe("safe next path", () => {
  it("keeps a same-origin path so connect and the callback can resume", () => {
    expect(safeNextPath("/api/schwab/connect")).toBe("/api/schwab/connect");
    expect(safeNextPath("/gate")).toBe("/gate");
    expect(safeNextPath("/api/schwab/callback?code=abc&state=xyz")).toBe("/api/schwab/callback?code=abc&state=xyz");
    expect(safeNextPath("https://app.example/api/schwab/connect", "https://app.example")).toBe("/api/schwab/connect");
  });

  it("drops open redirects and login loops", () => {
    expect(safeNextPath("https://evil.example/phish")).toBeNull();
    expect(safeNextPath("https://evil.example/phish", "https://app.example")).toBeNull();
    expect(safeNextPath("//evil.example")).toBeNull();
    expect(safeNextPath("/\\evil.example")).toBeNull();
    expect(safeNextPath("javascript:alert(1)")).toBeNull();
    expect(safeNextPath("/login")).toBeNull();
    expect(safeNextPath("/login?next=/api/schwab/connect")).toBeNull();
    expect(safeNextPath("/api/auth/login")).toBeNull();
    expect(safeNextPath("https://user:secret@app.example/gate", "https://app.example")).toBeNull();
  });
});
