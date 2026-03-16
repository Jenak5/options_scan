import { NextRequest, NextResponse } from "next/server";
import { getPositions, getBalances, getOptionChain, getMarketMetrics, getNetLiqHistory, getLiveOrders } from "@/app/lib/tastytrade";

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action");
  const symbol = request.nextUrl.searchParams.get("symbol");

  try {
    switch (action) {
      case "positions":
        return NextResponse.json({ data: await getPositions() });
      case "balances":
        return NextResponse.json({ data: await getBalances() });
      case "chain":
        if (!symbol) return NextResponse.json({ error: "symbol required" }, { status: 400 });
        return NextResponse.json({ data: await getOptionChain(symbol) });
      case "metrics": {
        const symbols = request.nextUrl.searchParams.get("symbols");
        if (!symbols) return NextResponse.json({ error: "symbols required" }, { status: 400 });
        return NextResponse.json({ data: await getMarketMetrics(symbols.split(",")) });
      }
      case "netliq": {
        const timeBack = request.nextUrl.searchParams.get("timeBack") || "1m";
        return NextResponse.json({ data: await getNetLiqHistory(undefined, timeBack) });
      }
      case "orders":
        return NextResponse.json({ data: await getLiveOrders() });
      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err: any) {
    console.error("Tastytrade API error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
