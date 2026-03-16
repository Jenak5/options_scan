import { NextRequest, NextResponse } from "next/server";
import { getFlowAlerts, getDarkPoolRecent, getDarkPoolTicker, getMarketTide, getStockInfo, getStockVolatility, getGammaExposure } from "@/app/lib/unusualwhales";

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action");
  const ticker = request.nextUrl.searchParams.get("ticker");

  try {
    switch (action) {
      case "flow": {
        const params: Record<string, string> = {};
        if (ticker) params.ticker_symbol = ticker;
        const minPremium = request.nextUrl.searchParams.get("min_premium");
        if (minPremium) params.min_premium = minPremium;
        const isSweep = request.nextUrl.searchParams.get("is_sweep");
        if (isSweep) params.is_sweep = isSweep;
        const isOtm = request.nextUrl.searchParams.get("is_otm");
        if (isOtm) params.is_otm = isOtm;
        const sizeGtOi = request.nextUrl.searchParams.get("size_greater_oi");
        if (sizeGtOi) params.size_greater_oi = sizeGtOi;
        params.limit = request.nextUrl.searchParams.get("limit") || "50";
        const side = request.nextUrl.searchParams.get("side");
        if (side) params.side = side;
        return NextResponse.json({ data: await getFlowAlerts(params) });
      }
      case "darkpool":
        if (ticker) return NextResponse.json({ data: await getDarkPoolTicker(ticker) });
        return NextResponse.json({ data: await getDarkPoolRecent() });
      case "tide":
        return NextResponse.json({ data: await getMarketTide() });
      case "stock-info":
        if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
        return NextResponse.json({ data: await getStockInfo(ticker) });
      case "volatility":
        if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
        return NextResponse.json({ data: await getStockVolatility(ticker) });
      case "gex":
        if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
        return NextResponse.json({ data: await getGammaExposure(ticker) });
      default:
        return NextResponse.json({ error: "Invalid action" }, { status: 400 });
    }
  } catch (err: any) {
    console.error("UW API error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
