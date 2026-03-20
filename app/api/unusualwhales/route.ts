import { NextRequest, NextResponse } from "next/server";

const UW_BASE = "https://api.unusualwhales.com/api";

function headers() {
  return {
    Authorization: `Bearer ${process.env.UNUSUAL_WHALES_API_TOKEN}`,
    Accept: "application/json",
  };
}

async function uwFetch(path: string, params?: Record<string, string>) {
  const url = new URL(`${UW_BASE}${path}`);
  if (params) {
    Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
  }
  const res = await fetch(url.toString(), { headers: headers() });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`UW API (${res.status}): ${err.slice(0, 200)}`);
  }
  return res.json();
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const action = searchParams.get("action");
  const ticker = (searchParams.get("ticker") || "").toUpperCase();

  try {
    switch (action) {

      // ── Options Flow ────────────────────────────────────────────────────
      case "flow": {
        const params: Record<string, string> = {
          limit: searchParams.get("limit") || "60",
        };
        if (ticker) params.ticker_symbol = ticker;
        const mp = searchParams.get("min_premium");
        if (mp) params.min_premium = mp;
        const sw = searchParams.get("is_sweep");
        if (sw) params.is_sweep = sw;
        const ot = searchParams.get("is_otm");
        if (ot) params.is_otm = ot;
        const data = await uwFetch("/option-trades/flow-alerts", params);
        return NextResponse.json({ data: data.data ?? [] });
      }

      // ── Dark Pool ───────────────────────────────────────────────────────
      case "darkpool": {
        const limit = searchParams.get("limit") || "50";
        const path  = ticker ? `/darkpool/${ticker}/recent` : "/darkpool/recent";
        const data  = await uwFetch(path, { limit });
        return NextResponse.json({ data: data.data ?? [] });
      }

      // ── Option Chain (live quotes) ─────────────────────────────────────
      // Endpoint: GET /stock/{ticker}/option-contracts
      // Query:    expiration_date=YYYY-MM-DD  (optional filter)
      // Returns:  flat list of option contracts with bid/ask/iv/greeks
      case "option-chain": {
        if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
        const expiration = searchParams.get("expiration") || "";
        const params: Record<string, string> = {};
        if (expiration) params.expiration_date = expiration;
        const data = await uwFetch(`/stock/${ticker}/option-contracts`, params);
        return NextResponse.json({ data: data.data ?? [] });
      }

      // ── Option Expirations ─────────────────────────────────────────────
      // Endpoint: GET /stock/{ticker}/option-contracts/expirations
      // Returns:  list of available expiration dates
      case "expirations": {
        if (!ticker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
        const data = await uwFetch(`/stock/${ticker}/option-contracts/expirations`);
        return NextResponse.json({ data: data.data ?? [] });
      }

      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
    }
  } catch (err: any) {
    console.error("UW API error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
