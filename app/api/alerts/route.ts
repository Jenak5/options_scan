import { NextRequest, NextResponse } from "next/server";
import { denyIfUnauthorized } from "@/app/lib/auth";
import { selectAlertRows, watchlistFromEnv } from "@/app/lib/flow";
import { scanEstimatedFlow } from "@/app/lib/flowScan";
import { SchwabConfigError, SchwabNotConnectedError } from "@/app/lib/schwab";
import { sendTelegramAlert, formatFlowAlert } from "@/app/lib/telegram";

export async function GET(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  const action = request.nextUrl.searchParams.get("action");

  try {
    switch (action) {
      case "test": {
        const sent = await sendTelegramAlert(
          "🧪 <b>OPTIONS EDGE SCANNER</b>\n\n✅ Telegram alerts are working!\n\nYou'll receive alerts here when estimated flow passes the gate liquidity filters."
        );
        return NextResponse.json({ success: sent, message: sent ? "Test alert sent!" : "Failed — check your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" });
      }

      case "scan": {
        const minPremium = Number(process.env.ALERT_MIN_PREMIUM || "100000");
        const otmOnly = process.env.ALERT_OTM_ONLY === "true";
        const scan = await scanEstimatedFlow({
          tickers: watchlistFromEnv(process.env.FLOW_WATCHLIST),
        });
        const rows = selectAlertRows(scan.rows, {
          minPremium: Number.isFinite(minPremium) ? minPremium : 100_000,
          otmOnly,
          limit: 25,
        });
        let alertsSent = 0;

        for (const flow of rows) {
          const message = formatFlowAlert(flow);
          const sent = await sendTelegramAlert(message);
          if (sent) alertsSent++;
          await new Promise((r) => setTimeout(r, 1100));
        }

        return NextResponse.json({
          success: true,
          scanned: scan.rows.length,
          matched: rows.length,
          alerts_sent: alertsSent,
          errors: scan.errors,
        });
      }

      default:
        return NextResponse.json({ error: "Use action=test or action=scan" }, { status: 400 });
    }
  } catch (err) {
    if (err instanceof SchwabNotConnectedError) {
      return NextResponse.json({ error: err.message, reconnect: "/api/schwab/connect", connected: false }, { status: 409 });
    }
    if (err instanceof SchwabConfigError) {
      return NextResponse.json({ error: err.message, connected: false }, { status: 503 });
    }
    const message = err instanceof Error && err.message.startsWith("Schwab ")
      ? err.message.slice(0, 180)
      : "Alert scan failed";
    console.error("Alert error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const denied = await denyIfUnauthorized(request);
  if (denied) return denied;

  try {
    const { message } = await request.json();
    if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
    const sent = await sendTelegramAlert(message);
    return NextResponse.json({ success: sent });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Alert failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
