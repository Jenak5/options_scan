import { NextRequest, NextResponse } from "next/server";
import { loadRiskStatus } from "@/app/lib/alertStore";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { earningsForTicker } from "@/app/lib/earnings";
import { flowContractKey } from "@/app/lib/flow";
import { findContract } from "@/app/lib/gate";
import { detectPairedFlow, ivVersusRecent, repeatFromSnapshot } from "@/app/lib/marketContext";
import { gradeMyTrade, parseGradeRequest, type GradeTradeResult } from "@/app/lib/gradeTrade";
import { keyLevelsForTicker } from "@/app/lib/levelScan";
import type { KeyLevels } from "@/app/lib/levels";
import { getOptionChain, SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";
import { readFlowSnapshots } from "@/app/lib/schwabStore";
import { openGradedTrade } from "@/app/lib/tradeStore";
import type { LetterGrade } from "@/app/lib/alertConfig";
import type { EarningsFact } from "@/app/lib/eventRisk";
import type { OptionContract } from "@/app/lib/contract";
import type { PairedFlow, RepeatFlow } from "@/app/lib/marketContext";

export const dynamic = "force-dynamic";

/**
 * Grade one contract with the alert checklist, then optionally save it
 * as an open paper trade. Session required. No order is placed.
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

  const parsed = parseGradeRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const save = body != null && typeof body === "object" && (body as { save?: unknown }).save === true;
  const now = new Date();
  const losses = await lossCount(now);

  try {
    const chain = await loadChain(parsed.value);
    const contract = findContract(chain.contracts, {
      expiration: parsed.value.expiration,
      strike: parsed.value.strike,
      putCall: parsed.value.putCall,
    });
    const levels = await levelsFor(parsed.value.ticker, chain.underlyingPrice, chain.contracts);
    const earnings = await earningsFor(parsed.value.ticker, now.getTime());
    const context = await gradeContext(parsed.value.ticker, contract, chain.contracts);
    const graded = gradeMyTrade({
      expiration: parsed.value.expiration,
      strike: parsed.value.strike,
      putCall: parsed.value.putCall,
      contract,
      underlyingPrice: chain.underlyingPrice,
      delayed: chain.delayed,
      now,
      consecutiveLosses: losses,
      levels,
      earnings,
      providerError: null,
      plannedEntry: parsed.value.plannedEntry,
      thesis: parsed.value.thesis,
      pairedFlow: context.pairedFlow,
      repeatFlow: context.repeatFlow,
      ivVsRecent: context.ivVsRecent,
    });
    return respond(graded, save, parsed.value, now);
  } catch (err) {
    const providerError = providerMessage(err);
    const graded = gradeMyTrade({
      expiration: parsed.value.expiration,
      strike: parsed.value.strike,
      putCall: parsed.value.putCall,
      contract: null,
      underlyingPrice: null,
      delayed: false,
      now,
      consecutiveLosses: losses,
      levels: null,
      earnings: null,
      providerError,
      plannedEntry: parsed.value.plannedEntry,
      thesis: parsed.value.thesis,
    });
    const reconnect = err instanceof SchwabNotConnectedError ? "/api/schwab/connect" : null;
    return respond(graded, save, parsed.value, now, reconnect);
  }
}

async function respond(
  graded: GradeTradeResult,
  save: boolean,
  request: { ticker: string; expiration: string; strike: number; putCall: "call" | "put" },
  now: Date,
  reconnect: string | null = null,
) {
  if (!save) {
    return NextResponse.json({ ...graded, saved: false, alreadyOpen: false, reconnect });
  }
  if (!graded.canSave || graded.entryPrice == null || graded.entryPriceSource == null) {
    return NextResponse.json({
      ...graded,
      saved: false,
      alreadyOpen: false,
      reconnect,
      error: graded.saveBlock ?? "This grade was not saved.",
    }, { status: 400 });
  }
  const result = await openGradedTrade({
    ticker: request.ticker,
    putCall: request.putCall,
    strike: request.strike,
    expiration: request.expiration,
    entryPrice: graded.entryPrice,
    entryPriceSource: graded.entryPriceSource,
    flowPremium: graded.flowPremium,
    alertGrade: storedLetter(graded),
    alertVerdict: graded.verdict,
    gradeOverall: graded.overall,
    thesis: graded.thesis,
    features: graded.features,
    gradeChecks: graded.checks.map((check) => ({
      id: check.id,
      label: check.label,
      status: check.status,
      detail: check.detail,
    })),
    quotedAt: graded.quotedAt,
  }, now);
  if (!result.ok) {
    return NextResponse.json({ ...graded, saved: false, alreadyOpen: false, reconnect, error: result.error }, { status: 400 });
  }
  return NextResponse.json({
    ...graded,
    saved: !result.alreadyOpen,
    alreadyOpen: result.alreadyOpen,
    reconnect,
    error: result.alreadyOpen ? "This contract already has an open paper trade." : null,
  });
}

function storedLetter(graded: GradeTradeResult): LetterGrade | null {
  if (graded.overall === "A" || graded.overall === "B") return graded.overall;
  if (graded.scannerGrade === "C" || graded.scannerGrade === "D") return graded.scannerGrade;
  return null;
}

async function lossCount(now: Date): Promise<number | null> {
  try {
    const risk = await loadRiskStatus(now);
    return risk.stop.consecutiveLosses;
  } catch {
    return null;
  }
}

async function levelsFor(
  ticker: string,
  spot: number | null,
  contracts: { strike: number; putCall: "call" | "put"; openInterest: number }[],
): Promise<KeyLevels | null> {
  try {
    return await keyLevelsForTicker({ ticker, spot, contracts });
  } catch {
    return null;
  }
}

async function gradeContext(
  ticker: string,
  contract: OptionContract | null,
  contracts: OptionContract[],
): Promise<{ pairedFlow: PairedFlow | null; repeatFlow: RepeatFlow | null; ivVsRecent: number | null }> {
  if (!contract) return { pairedFlow: null, repeatFlow: null, ivVsRecent: null };
  const expiration = contract.expiration.slice(0, 10);
  const pairedFlow = detectPairedFlow(
    { strike: contract.strike, expiration, putCall: contract.putCall, volume: contract.volume },
    contracts.map((item) => ({
      strike: item.strike,
      expiration: item.expiration.slice(0, 10),
      putCall: item.putCall,
      volume: item.volume,
    })),
  );
  try {
    const snaps = await readFlowSnapshots();
    const snap = snaps[ticker.trim().toUpperCase()] ?? null;
    const key = flowContractKey({ expiration, strike: contract.strike, putCall: contract.putCall });
    return {
      pairedFlow,
      repeatFlow: repeatFromSnapshot(key, snap),
      ivVsRecent: ivVersusRecent(contract.iv, snap?.priorSession?.ivs?.[key] ?? null),
    };
  } catch {
    return { pairedFlow, repeatFlow: null, ivVsRecent: null };
  }
}

async function earningsFor(ticker: string, now: number): Promise<EarningsFact | null> {
  try {
    return await earningsForTicker(ticker, now);
  } catch {
    return null;
  }
}

async function loadChain(input: { ticker: string; expiration: string; strike: number; putCall: "call" | "put" }) {
  const common = {
    symbol: input.ticker,
    contractType: "ALL" as const,
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

function providerMessage(err: unknown): string {
  if (err instanceof SchwabNotConnectedError || err instanceof SchwabConfigError) return err.message;
  if (err instanceof Error && err.message.startsWith("Schwab ")) return err.message.slice(0, 180);
  return "Schwab market data request failed, so this quote was not graded.";
}
