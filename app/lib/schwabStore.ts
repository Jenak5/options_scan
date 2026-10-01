import type { StoredTokens } from "@/app/lib/schwabParse";
import {
  SCHWAB_KV_TOKEN_ENV,
  SCHWAB_KV_URL_ENV,
  SCHWAB_UPSTASH_TOKEN_ENV,
  SCHWAB_UPSTASH_URL_ENV,
} from "@/app/lib/schwabStorage";

/**
 * Server-side Schwab token store.
 *
 * Production: Vercel KV or Upstash Redis (same REST API), via
 * KV_REST_API_URL + KV_REST_API_TOKEN, or
 * UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN.
 * The token JSON is encrypted with a key derived from SESSION_SECRET
 * before it is written. Values are never logged.
 *
 * Fallback: process memory, and only outside production. A serverless
 * instance does not share that memory, so production without KV or Upstash
 * reports storage as not configured and refuses to pretend a token was saved.
 */

export interface AlertMeta {
  expiryAlertAt: number | null;
  refreshFailAlertAt: number | null;
}

export type StoreKind = "kv" | "memory" | "unconfigured";

const TOKEN_KEY = "oes:schwab:tokens";
const ALERT_KEY = "oes:schwab:alerts";

interface MemoryBag {
  tokens: StoredTokens | null;
  alerts: AlertMeta;
}

const EMPTY_ALERTS: AlertMeta = { expiryAlertAt: null, refreshFailAlertAt: null };

function memoryBag(): MemoryBag {
  const g = globalThis as typeof globalThis & { __oesSchwabMemory?: MemoryBag };
  if (!g.__oesSchwabMemory) {
    g.__oesSchwabMemory = { tokens: null, alerts: { ...EMPTY_ALERTS } };
  }
  return g.__oesSchwabMemory;
}

export function clearMemoryStoreForTests(): void {
  const g = globalThis as typeof globalThis & { __oesSchwabMemory?: MemoryBag };
  g.__oesSchwabMemory = { tokens: null, alerts: { ...EMPTY_ALERTS } };
}

export function kvRestConfig(): { url: string; token: string } | null {
  const url = firstEnv(SCHWAB_KV_URL_ENV, SCHWAB_UPSTASH_URL_ENV);
  const token = firstEnv(SCHWAB_KV_TOKEN_ENV, SCHWAB_UPSTASH_TOKEN_ENV);
  if (!url || !token) return null;
  return { url: url.replace(/\/$/, ""), token };
}

/** Production and Vercel do not keep a durable process, so memory is not a store. */
export function durableStoreRequired(): boolean {
  return process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
}

export function resolveStoreKind(): StoreKind {
  if (kvRestConfig()) return "kv";
  if (durableStoreRequired()) return "unconfigured";
  return "memory";
}

export async function readTokens(): Promise<StoredTokens | null> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") return null;
  if (kind === "memory") return memoryBag().tokens;
  try {
    const raw = await kvCommand(["GET", TOKEN_KEY]);
    if (typeof raw !== "string" || raw.length === 0) return null;
    const json = await decryptTokenPayload(raw);
    return parseStored(json);
  } catch {
    console.error("Schwab token store could not be read");
    return null;
  }
}

export async function writeTokens(tokens: StoredTokens): Promise<void> {
  if (!tokens.accessToken || !tokens.refreshToken) {
    throw new Error("Refusing to store an empty Schwab token");
  }
  const kind = resolveStoreKind();
  if (kind === "unconfigured") {
    throw new Error("Schwab token storage is not configured");
  }
  if (kind === "memory") {
    memoryBag().tokens = tokens;
    return;
  }
  const cipher = await encryptTokenPayload(JSON.stringify(tokens));
  await kvCommand(["SET", TOKEN_KEY, cipher]);
}

export async function readAlertMeta(): Promise<AlertMeta> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") return { ...EMPTY_ALERTS };
  if (kind === "memory") return memoryBag().alerts;
  try {
    const raw = await kvCommand(["GET", ALERT_KEY]);
    if (typeof raw !== "string" || raw.length === 0) return { ...EMPTY_ALERTS };
    return parseAlerts(raw);
  } catch {
    return { ...EMPTY_ALERTS };
  }
}

export async function writeAlertMeta(meta: AlertMeta): Promise<void> {
  const kind = resolveStoreKind();
  if (kind === "unconfigured") return;
  if (kind === "memory") {
    memoryBag().alerts = meta;
    return;
  }
  await kvCommand(["SET", ALERT_KEY, JSON.stringify(meta)]);
}

export async function encryptTokenPayload(json: string): Promise<string> {
  const key = await aesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(json)),
  );
  const packed = new Uint8Array(iv.length + cipher.length);
  packed.set(iv, 0);
  packed.set(cipher, iv.length);
  return bytesToBase64(packed);
}

export async function decryptTokenPayload(payload: string): Promise<string> {
  const key = await aesKey();
  const packed = base64ToBytes(payload);
  if (packed.length < 13) throw new Error("Schwab token payload is unreadable");
  const iv = packed.slice(0, 12);
  const cipher = packed.slice(12);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipher);
  return new TextDecoder().decode(plain);
}

async function aesKey(): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET?.trim() ?? "";
  if (!secret) throw new Error("SESSION_SECRET is required to store Schwab tokens");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`oes-schwab-tokens.v1.${secret}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function kvCommand(command: string[]): Promise<unknown> {
  const cfg = kvRestConfig();
  if (!cfg) throw new Error("Token store is not configured");
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Token store request failed (${res.status})`);
  const payload: unknown = await res.json();
  if (!payload || typeof payload !== "object") return null;
  return (payload as { result?: unknown }).result ?? null;
}

function parseStored(json: string): StoredTokens | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const row = parsed as Partial<StoredTokens>;
  if (typeof row.accessToken !== "string" || typeof row.refreshToken !== "string") return null;
  if (typeof row.accessExpiresAt !== "number" || typeof row.refreshExpiresAt !== "number") return null;
  return {
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    accessExpiresAt: row.accessExpiresAt,
    refreshExpiresAt: row.refreshExpiresAt,
  };
}

function parseAlerts(json: string): AlertMeta {
  try {
    const parsed = JSON.parse(json) as Partial<AlertMeta>;
    return {
      expiryAlertAt: typeof parsed.expiryAlertAt === "number" ? parsed.expiryAlertAt : null,
      refreshFailAlertAt: typeof parsed.refreshFailAlertAt === "number" ? parsed.refreshFailAlertAt : null,
    };
  } catch {
    return { ...EMPTY_ALERTS };
  }
}

function firstEnv(primary: string, fallback: string): string {
  const first = process.env[primary]?.trim() ?? "";
  if (first) return first;
  return process.env[fallback]?.trim() ?? "";
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
