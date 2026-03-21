import { NextRequest, NextResponse } from "next/server";

// ─── Grok (xAI) research route ─────────────────────────────────────────────
// POST /api/research
// Body: { messages: [{role, content}], context?: { flows, volRows } }
//
// Requires XAI_API_KEY in Vercel environment variables.
// Add via: Vercel dashboard → Settings → Environment Variables → Add
//   Name:  XAI_API_KEY
//   Value: your xAI key from console.x.ai

// xAI uses the OpenAI-compatible API format
const XAI_API    = "https://api.x.ai/v1/chat/completions";
const MODEL      = "grok-3-fast";
const MAX_TOKENS = 1024;

const SYSTEM_PROMPT = `You are a sharp options trading research assistant embedded in a live options scanner. You have direct access to real-time data from the scanner including options flow alerts, dark pool prints, and volatility metrics.

Your job is to help the trader interpret signals, research tickers, and think through trade ideas — combining the live scanner data you're given with your knowledge of markets, options mechanics, and trading.

Be direct and specific. Lead with the signal, not the caveat. Use the scanner data provided in each message to ground your answers. If you see something interesting in the data that the trader didn't ask about, mention it briefly.

Format numbers cleanly: $1.2M not $1200000, 65% not 0.65, etc.
Keep responses focused and scannable — use short paragraphs or bullet points, not walls of text.
Never give specific investment advice or tell the trader to buy/sell. Frame everything as analysis and interpretation.`;

export async function POST(request: NextRequest) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "XAI_API_KEY not configured. Add it to Vercel → Settings → Environment Variables." },
      { status: 500 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { messages, context } = body;
  if (!messages || !Array.isArray(messages)) {
    return NextResponse.json({ error: "messages array required" }, { status: 400 });
  }

  // ── Build context block from live scanner data ────────────────────────────
  let contextBlock = "";
  if (context) {
    const parts: string[] = ["[LIVE SCANNER DATA]"];

    if (context.volRows && context.volRows.length > 0) {
      parts.push("\nVOL ARB WATCHLIST:");
      for (const r of context.volRows) {
        const signal =
          r.ivRank < 25 && r.spread < 10  ? "BUY FRIENDLY" :
          r.ivRank < 25 && r.spread >= 10 ? "CAUTION"      :
          r.spread < 0                     ? "BUY VOL"      :
          r.spread > 20                    ? "EXPENSIVE"    : "NEUTRAL";
        parts.push(`  ${r.ticker}: IV=${r.iv?.toFixed(1)}% HV=${r.hv?.toFixed(1)}% IVRank=${r.ivRank?.toFixed(0)}% Spread=${r.spread > 0 ? "+" : ""}${r.spread?.toFixed(1)}pp → ${signal}`);
      }
    }

    if (context.flows && context.flows.length > 0) {
      parts.push("\nRECENT OPTIONS FLOW (last 10):");
      for (const f of context.flows.slice(0, 10)) {
        const typeStr = (f.type ?? f.put_call ?? "").toLowerCase();
        const premium = parseFloat(f.total_premium ?? "0");
        const premStr = premium >= 1_000_000 ? `$${(premium / 1_000_000).toFixed(1)}M`
                      : premium >= 1_000     ? `$${(premium / 1_000).toFixed(0)}K`
                      : `$${premium}`;
        const askPrem = parseFloat(f.total_ask_side_prem ?? "0");
        const bidPrem = parseFloat(f.total_bid_side_prem ?? "0");
        const ratio   = (askPrem + bidPrem) > 0 ? askPrem / (askPrem + bidPrem) : null;
        const side    = ratio === null ? "" : ratio >= 0.65 ? " ASK-SIDE" : ratio <= 0.35 ? " BID-SIDE" : " MID";
        const sweep   = (f.has_sweep || f.is_sweep) ? " SWEEP" : "";
        const opening = f.all_opening_trades === true ? " OPENING" : f.all_opening_trades === false ? " CLOSING" : "";
        parts.push(`  ${f.ticker} ${typeStr.toUpperCase()} $${f.strike} exp ${f.expiry ?? "?"} ${premStr}${side}${sweep}${opening} IV=${f.iv_start ? (parseFloat(f.iv_start) * 100).toFixed(0) + "%" : "?"}`);
      }
    }

    contextBlock = parts.join("\n") + "\n\n[END SCANNER DATA]\n\n";
  }

  // Inject context into the first user message
  const augmentedMessages = messages.map((m: any, i: number) => {
    if (i === 0 && m.role === "user" && contextBlock) {
      return { ...m, content: contextBlock + m.content };
    }
    return m;
  });

  // xAI uses OpenAI-compatible format: system prompt goes as first message
  const grokMessages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...augmentedMessages,
  ];

  try {
    const res = await fetch(XAI_API, {
      method: "POST",
      headers: {
        "Content-Type":  "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        messages:   grokMessages,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`xAI API (${res.status}): ${err.slice(0, 200)}`);
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content ?? "";
    return NextResponse.json({ text });
  } catch (err: any) {
    console.error("Research API error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
