"use client";

import { useEffect, useState } from "react";

interface SideCheck {
  outcome: string;
  reason: string;
}

interface SymbolCheck {
  at: number;
  put: SideCheck;
  call: SideCheck;
}

interface Trade {
  id: string;
  symbol: string;
  putCall: "put" | "call";
  strike: number;
  expiration: string;
  contracts: number;
  status: "open" | "closed";
  entryAsk: number;
  pnlDollars: number | null;
  exitReason: string | null;
  openedAt: number;
  closedAt: number | null;
}

interface Skip {
  id: string;
  symbol: string;
  putCall: "put" | "call";
  at: number;
  reason: string;
}

interface Section {
  label: string;
  stored: boolean;
  symbols: string[];
  puts: { pnlDollars: number; wins: number; losses: number; open: number };
  calls: { pnlDollars: number; wins: number; losses: number; open: number };
  totalPnlDollars: number;
  wins: number;
  losses: number;
  checks: Record<string, SymbolCheck>;
  skips: Skip[];
  openPuts: Trade[];
  openCalls: Trade[];
  closedPuts: Trade[];
  closedCalls: Trade[];
  error?: string;
}

export function AvwapTrialPanel() {
  const [page, setPage] = useState<Section | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    fetch("/api/avwap-trial")
      .then(async (res) => {
        const body = await res.json() as Section;
        if (!res.ok) throw new Error(body.error ?? "The AVWAP trial log could not be read.");
        if (!gone) setPage(body);
      })
      .catch((err: unknown) => {
        if (!gone) setError(err instanceof Error ? err.message : "The AVWAP trial log could not be read.");
      });
    return () => {
      gone = true;
    };
  }, []);

  return (
    <section style={{ marginTop: 36, paddingTop: 20, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
      <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>AVWAP trial: AMD, MSFT, AMZN (paper)</h2>
      <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.5, margin: "0 0 12px" }}>
        Separate paper book. Puts and calls. No order is placed. Open alerts use the AVWAP Telegram repeats. Exits do not.
      </p>
      {error && <p style={{ color: "#fca5a5", fontSize: 14 }}>{error}</p>}
      {page && !page.stored && (
        <p style={{ color: "#fbbf24", fontSize: 14 }}>The private store is not configured, so a trial row cannot be saved.</p>
      )}
      {page && (
        <>
          <p style={{ color: "#cbd5e1", fontSize: 14, margin: "0 0 8px" }}>
            Put P&L {money(page.puts.pnlDollars)} ({page.puts.wins} wins, {page.puts.losses} losses). Call P&L {money(page.calls.pnlDollars)} ({page.calls.wins} wins, {page.calls.losses} losses). Total {money(page.totalPnlDollars)}.
          </p>
          <h3 style={{ fontSize: 15, margin: "12px 0 6px" }}>Last scan</h3>
          <ul style={{ margin: 0, paddingLeft: 18, color: "#94a3b8", fontSize: 14 }}>
            {page.symbols.map((symbol) => {
              const check = page.checks[symbol];
              return (
                <li key={symbol}>
                  {symbol}: {check ? `${when(check.at)}. Put ${check.put.outcome} (${check.put.reason}). Call ${check.call.outcome} (${check.call.reason}).` : "not checked yet."}
                </li>
              );
            })}
          </ul>
          <TradeList title="Open puts" rows={page.openPuts} />
          <TradeList title="Open calls" rows={page.openCalls} />
          <TradeList title="Closed puts" rows={page.closedPuts} />
          <TradeList title="Closed calls" rows={page.closedCalls} />
          <h3 style={{ fontSize: 15, margin: "16px 0 6px" }}>Skipped</h3>
          {page.skips.length === 0 ? <p style={{ color: "#64748b", fontSize: 14 }}>No skipped trial entries.</p> : (
            <ul style={{ margin: 0, paddingLeft: 18, color: "#94a3b8", fontSize: 14 }}>
              {page.skips.slice(0, 12).map((skip) => (
                <li key={skip.id}>{skip.symbol} {skip.putCall}: {skip.reason}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function TradeList({ title, rows }: { title: string; rows: Trade[] }) {
  return (
    <>
      <h3 style={{ fontSize: 15, margin: "16px 0 6px" }}>{title}</h3>
      {rows.length === 0 ? <p style={{ color: "#64748b", fontSize: 14 }}>None.</p> : (
        <ul style={{ margin: 0, paddingLeft: 18, color: "#e2e8f0", fontSize: 14 }}>
          {rows.map((trade) => (
            <li key={trade.id}>
              {trade.symbol} {trade.putCall} ${trade.strike} {trade.expiration} x{trade.contracts}
              {trade.status === "closed" ? ` ${trade.exitReason ?? "closed"} ${money(trade.pnlDollars)}` : ` open at ${money(trade.entryAsk)}`}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function money(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `$${value.toFixed(2)}`;
}

function when(value: number | null): string {
  if (value == null) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(value);
}
