import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { exitDefaultsSummary } from "@/app/lib/exits";
import {
  closeLoggedTrade,
  loadTradePage,
  openLoggedTrade,
  removeLoggedTrade,
  tradeLogCsv,
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

  const page = await loadTradePage(new Date());
  return NextResponse.json({ ...page, exitDefaults: exitDefaultsSummary() });
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
        : { ok: false as const, error: "Choose open, close, or remove" };

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ...result.page, exitDefaults: exitDefaultsSummary() });
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
