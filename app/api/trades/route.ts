import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { exitDefaultsSummary } from "@/app/lib/exits";
import { quoteTradeMarks } from "@/app/lib/tradeQuotes";
import { flatTimeStopDue, PAPER_ENTRY_NOTE, withQuoteMark } from "@/app/lib/trades";
import {
  closeLoggedTrade,
  loadTradePage,
  openLoggedTrade,
  openPaperLoggedTrade,
  paperPreviewForAlert,
  removeLoggedTrade,
  tradeLogCsv,
  type TradePage,
} from "@/app/lib/tradeStore";

export const dynamic = "force-dynamic";

/**
 * Manual trade log. Session required.
 * Read-only toward brokers: nothing here places an order or reads a fill.
 */
export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  if (request.nextUrl.searchParams.get("format") === "csv") {
    const csv = await tradeLogCsv();
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": "attachment; filename=\"trade-log.csv\"",
      },
    });
  }

  const now = new Date();
  const page = await loadTradePage(now);
  const alertId = request.nextUrl.searchParams.get("alert");
  const preview = alertId ? await paperPreviewForAlert(alertId, now) : null;
  return NextResponse.json({
    ...(await withMarks(page, now)),
    preview,
    entryNote: PAPER_ENTRY_NOTE,
    exitDefaults: exitDefaultsSummary(),
  });
}

export async function POST(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body" }, { status: 400 });
  }
  const row = body && typeof body === "object" ? body as Record<string, unknown> : null;
  if (!row) return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });

  const now = new Date();
  const action = typeof row.action === "string" ? row.action : "";
  if (action === "paper") {
    const result = await openPaperLoggedTrade({
      alertId: typeof row.alertId === "string" ? row.alertId : null,
      ticker: typeof row.ticker === "string" ? row.ticker : "",
      putCall: typeof row.putCall === "string" ? row.putCall : "",
      strike: asNumber(row.strike) ?? undefined,
      expiration: typeof row.expiration === "string" ? row.expiration : "",
      ask: asNumber(row.ask) ?? undefined,
      grade: typeof row.grade === "string" ? row.grade : null,
      verdict: typeof row.verdict === "string" ? row.verdict : null,
      flowPremium: asNumber(row.flowPremium),
      contracts: asNumber(row.contracts) ?? 1,
    }, now);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({
      ...(await withMarks(result.page, now)),
      alreadyOpen: result.alreadyOpen,
      focusAlertId: result.focusAlertId,
      entryNote: PAPER_ENTRY_NOTE,
      exitDefaults: exitDefaultsSummary(),
    });
  }

  const result = action === "open"
    ? await openLoggedTrade({
      ticker: typeof row.ticker === "string" ? row.ticker : "",
      putCall: typeof row.putCall === "string" ? row.putCall : "",
      strike: asNumber(row.strike) ?? Number.NaN,
      expiration: typeof row.expiration === "string" ? row.expiration : "",
      contracts: asNumber(row.contracts) ?? Number.NaN,
      entryPrice: asNumber(row.entryPrice) ?? Number.NaN,
      structure: typeof row.structure === "string" ? row.structure : "single",
      openedAt: optionalTime(row.openedAt),
      alertId: typeof row.alertId === "string" ? row.alertId : null,
    }, now)
    : action === "close"
      ? await closeLoggedTrade(typeof row.id === "string" ? row.id : "", {
        exitPrice: asNumber(row.exitPrice) ?? Number.NaN,
        closedAt: optionalTime(row.closedAt),
        exitNote: typeof row.exitNote === "string" ? row.exitNote : null,
      }, now)
      : action === "remove"
        ? await removeLoggedTrade(typeof row.id === "string" ? row.id : "", now)
        : { ok: false as const, error: "Choose paper, open, close, or remove" };

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({
    ...(await withMarks(result.page, now)),
    alreadyOpen: false,
    focusAlertId: null,
    entryNote: PAPER_ENTRY_NOTE,
    exitDefaults: exitDefaultsSummary(),
  });
}

async function withMarks(page: TradePage, now: Date) {
  const marks = await quoteTradeMarks(page.trades);
  return {
    ...page,
    trades: page.trades.map((trade) => {
      const marked = withQuoteMark(trade, marks[trade.id] ?? null);
      return { ...marked, flatTimeStop: flatTimeStopDue(marked, marked.unrealizedPnl, now) };
    }),
  };
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function optionalTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
