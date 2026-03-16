import { NextRequest, NextResponse } from "next/server";
import { getFlowAlerts } from "@/app/lib/unusualwhales";
import { sendTelegramAlert, formatFlowAlert, shouldAlert } from "@/app/lib/telegram";

const alertedIds = new Set<string>();

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const minPremium = process.env.ALERT_MIN_PREMIUM || "100000";
    const params: Record<string, string> = {
      min_premium: minPremium,
      limit: "20",
    };
    if (process.env.ALERT_SWEEPS_ONLY === "true") params.is_sweep = "true";
    if (process.env.ALERT_OTM_ONLY === "true") params.is_otm = "true";

    const flows = await getFlowAlerts(params);
    let alertsSent = 0;

    for (const flow of flows) {
      const flowId = `${flow.ticker}-${flow.strike_price}-${flow.option_type}-${flow.expiration_date}-${flow.executed_at}`;

      if (alertedIds.has(flowId)) continue;
      if (!shouldAlert(flow)) continue;

      const message = formatFlowAlert(flow);
      const sent = await sendTelegramAlert(message);

      if (sent) {
        alertsSent++;
        alertedIds.add(flowId);
        if (alertedIds.size > 500) {
          const arr = Array.from(alertedIds);
          arr.slice(0, 200).forEach((id) => alertedIds.delete(id));
        }
      }

      await new Promise((r) => setTimeout(r, 1100));
    }

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      scanned: flows.length,
      alerts_sent: alertsSent,
      total_tracked: alertedIds.size,
    });
  } catch (err: any) {
    console.error("Cron scan error:", err.message);
    await sendTelegramAlert(`⚠️ <b>Scanner Error</b>\n\n${err.message}`);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
