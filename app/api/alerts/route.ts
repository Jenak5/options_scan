import { NextRequest, NextResponse } from "next/server";
import { getFlowAlerts } from "@/app/lib/unusualwhales";
import { sendTelegramAlert, formatFlowAlert, shouldAlert } from "@/app/lib/telegram";

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get("action");

  try {
    switch (action) {
      case "test": {
        const sent = await sendTelegramAlert(
          "🧪 <b>OPTIONS EDGE SCANNER</b>\n\n✅ Telegram alerts are working!\n\nYou'll receive alerts here when high-conviction flow is detected."
        );
        return NextResponse.json({ success: sent, message: sent ? "Test alert sent!" : "Failed — check your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID" });
      }

      case "scan": {
        const minPremium = process.env.ALERT_MIN_PREMIUM || "100000";
        const params: Record<string, string> = {
          min_premium: minPremium,
          limit: "25",
        };
        if (process.env.ALERT_SWEEPS_ONLY === "true") params.is_sweep = "true";
        if (process.env.ALERT_OTM_ONLY === "true") params.is_otm = "true";

        const flows = await getFlowAlerts(params);
        let alertsSent = 0;

        for (const flow of flows) {
          if (shouldAlert(flow)) {
            const message = formatFlowAlert(flow);
            const sent = await sendTelegramAlert(message);
            if (sent) alertsSent++;
            await new Promise((r) => setTimeout(r, 1100));
          }
        }

        return NextResponse.json({
          success: true,
          scanned: flows.length,
          alerts_sent: alertsSent,
        });
      }

      default:
        return NextResponse.json({ error: "Use action=test or action=scan" }, { status: 400 });
    }
  } catch (err: any) {
    console.error("Alert error:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { message } = await request.json();
    if (!message) return NextResponse.json({ error: "message required" }, { status: 400 });
    const sent = await sendTelegramAlert(message);
    return NextResponse.json({ success: sent });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
