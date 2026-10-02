"use client";

import { useState } from "react";

interface FlowPaper {
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  ask: number;
  grade: string;
  verdict: string;
  flowPremium: number | null;
}

/**
 * One tap records a simulated entry. It does not place an order.
 * A saved alert is preferred. A Flow card sends the contract and the log
 * links the newest matching alert when one exists.
 */
export function PaperTradeButton({ alertId, flow }: { alertId?: string; flow?: FlowPaper }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function record() {
    setPending(true);
    setError(null);
    try {
      const body = alertId
        ? { action: "paper", alertId, contracts: 1 }
        : {
          action: "paper",
          ticker: flow?.ticker,
          putCall: flow?.putCall,
          strike: flow?.strike,
          expiration: flow?.expiration,
          ask: flow?.ask,
          grade: flow?.grade,
          verdict: flow?.verdict,
          flowPremium: flow?.flowPremium,
          contracts: 1,
        };
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Paper trade was not saved");
      const id = typeof json.focusAlertId === "string" && json.focusAlertId ? json.focusAlertId : alertId ?? "";
      window.location.href = id ? `/trades?alert=${encodeURIComponent(id)}` : "/trades";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Paper trade was not saved");
      setPending(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <button
        type="button"
        onClick={() => { void record(); }}
        disabled={pending}
        style={{
          width: "100%",
          minHeight: 48,
          background: "rgba(6,182,212,0.16)",
          color: "#06b6d4",
          border: "1px solid rgba(6,182,212,0.4)",
          borderRadius: 10,
          padding: "12px 16px",
          fontSize: 16,
          fontWeight: 700,
          cursor: pending ? "wait" : "pointer",
          opacity: pending ? 0.6 : 1,
        }}
      >
        {pending ? "Saving paper trade…" : "Paper trade"}
      </button>
      {error && <p style={{ margin: "8px 0 0", color: "#fca5a5", fontSize: 14, lineHeight: 1.4 }}>{error}</p>}
    </div>
  );
}
