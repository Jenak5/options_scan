import { NextRequest, NextResponse } from "next/server";
import type { PutCall } from "@/app/lib/contract";
import { loadRiskStatus } from "@/app/lib/alertStore";
import { exitDefaultsSummary, planExits } from "@/app/lib/exits";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { evaluateGate, findContract } from "@/app/lib/gate";
import { earningsForTicker } from "@/app/lib/earnings";
import { keyLevelsForTicker } from "@/app/lib/levelScan";
import { getOptionChain, SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";
import { gradeContract } from "@/app/lib/verdict";

export const dynamic = "force-dynamic";

const MAX_RULE = 200;

/**
 * Live read of one contract, then the pure gate.
 * Session required. No order, no account write.
 */
export async function POST(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }

  const parsed = parseGateBody(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const chain = await loadChain(parsed.value);
    const contract = findContract(chain.contracts, {
      expiration: parsed.value.expiration,
      strike: parsed.value.strike,
      putCall: parsed.value.putCall,
    });
    const now = new Date();
    const risk = await loadRiskStatus(now);
    const losses = risk.stop.consecutiveLosses;
    const result = evaluateGate({
      contract,
      contracts: parsed.value.contracts,
      plannedEntry: parsed.value.plannedEntry,
      debitSpreadWidth: parsed.value.debitSpreadWidth,
      underlyingStop: parsed.value.underlyingStop,
      timeStop: parsed.value.timeStop,
      profitRule: parsed.value.profitRule,
      consecutiveLosses: losses,
      delayed: chain.delayed,
    });
    const levels = await keyLevelsForTicker({
      ticker: parsed.value.ticker,
      spot: chain.underlyingPrice,
      contracts: chain.contracts,
    });
    const earnings = await earningsForTicker(parsed.value.ticker, now.getTime());
    const width = parsed.value.debitSpreadWidth;
    const verdict = contract
      ? gradeContract({
        contract,
        underlyingPrice: chain.underlyingPrice,
        delayed: chain.delayed,
        now,
        consecutiveLosses: losses,
        levels,
        earnings,
        definedRiskSpread: width != null && Number.isFinite(width) && width > 0,
      })
      : null;
    return NextResponse.json({
      overall: result.overall,
      checks: result.checks,
      singleContractExceedsCap: result.singleContractExceedsCap,
      suggestion: result.suggestion,
      maxLoss: result.maxLoss,
      delayed: chain.delayed,
      contract: result.contract,
      verdict,
      dailyStop: risk.stop.dailyStop,
      consecutiveLosses: losses,
      weeklyNote: risk.weeklyNote,
      exits: exitPlan(parsed.value, contract?.ask ?? null),
      exitDefaults: exitDefaultsSummary(),
    });
  } catch (err) {
    if (err instanceof SchwabNotConnectedError) {
      return NextResponse.json({ error: err.message, reconnect: "/api/schwab/connect" }, { status: 409 });
    }
    if (err instanceof SchwabConfigError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    const message = err instanceof Error ? safeMessage(err.message) : "Schwab market data request failed";
    return NextResponse.json({ error: message }, { status: 502 });
  }
}

interface GateBody {
  ticker: string;
  expiration: string;
  strike: number;
  putCall: PutCall;
  contracts: number;
  plannedEntry: number;
  debitSpreadWidth: number | null;
  underlyingStop: string;
  timeStop: string;
  profitRule: string;
}

function parseGateBody(body: unknown): { ok: true; value: GateBody } | { ok: false; error: string } {
  const row = body && typeof body === "object" ? body as Record<string, unknown> : null;
  if (!row) return { ok: false, error: "Expected a JSON object" };

  const ticker = typeof row.ticker === "string" ? row.ticker.trim().toUpperCase() : "";
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(ticker)) return { ok: false, error: "Enter a ticker" };

  const expiration = typeof row.expiration === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(row.expiration.trim())?.[1] ?? "" : "";
  if (!expiration) return { ok: false, error: "Enter an expiration as YYYY-MM-DD" };

  const strike = asNumber(row.strike);
  if (strike == null || strike <= 0 || strike > 1_000_000) return { ok: false, error: "Enter a strike" };

  const putCall = parseRight(row.putCall);
  if (!putCall) return { ok: false, error: "Choose call or put" };

  const contracts = asNumber(row.contracts);
  const plannedEntry = asNumber(row.plannedEntry);
  const widthRaw = row.debitSpreadWidth;
  let debitSpreadWidth: number | null = null;
  if (widthRaw !== null && widthRaw !== undefined && widthRaw !== "") {
    const width = asNumber(widthRaw);
    if (width == null) return { ok: false, error: "Debit spread width must be a number" };
    debitSpreadWidth = width;
  }

  return {
    ok: true,
    value: {
      ticker,
      expiration,
      strike,
      putCall,
      contracts: contracts ?? Number.NaN,
      plannedEntry: plannedEntry ?? Number.NaN,
      debitSpreadWidth,
      underlyingStop: clip(row.underlyingStop),
      timeStop: clip(row.timeStop),
      profitRule: clip(row.profitRule),
    },
  };
}

async function loadChain(input: GateBody) {
  const common = {
    symbol: input.ticker,
    contractType: input.putCall === "call" ? "CALL" as const : "PUT" as const,
    fromDate: input.expiration,
    toDate: input.expiration,
  };
  const query = {
    expiration: input.expiration,
    strike: input.strike,
    putCall: input.putCall,
  };
  const exact = await getOptionChain({ ...common, strike: input.strike });
  if (findContract(exact.contracts, query)) return exact;
  const wider = await getOptionChain(common);
  return {
    contracts: wider.contracts.length > 0 ? wider.contracts : exact.contracts,
    delayed: exact.delayed || wider.delayed,
    underlyingPrice: wider.underlyingPrice ?? exact.underlyingPrice,
  };
}

function parseRight(value: unknown): PutCall | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (text === "call" || text === "c") return "call";
  if (text === "put" || text === "p") return "put";
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clip(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, MAX_RULE);
}

function exitPlan(input: GateBody, ask: number | null) {
  const premium = Number.isFinite(input.plannedEntry) && input.plannedEntry > 0
    ? input.plannedEntry
    : ask != null && ask > 0
      ? ask
      : 0;
  const contracts = Number.isInteger(input.contracts) && input.contracts >= 1 ? input.contracts : 1;
  const structure = input.debitSpreadWidth != null && input.debitSpreadWidth > 0 ? "debit-spread" as const : "single" as const;
  return planExits({ premium, contracts, structure });
}

function safeMessage(message: string): string {
  if (message.startsWith("Schwab ")) return message.slice(0, 180);
  return "Schwab market data request failed";
}
