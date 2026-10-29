"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PageLinks } from "@/app/components/PageLinks";

interface WhatIf {
  id: string;
  label: string;
  expiration: string;
  strike: number;
  contracts: number;
  entryAsk: number;
  entryBid: number;
  status: "open" | "closed" | "skipped";
  skipReason: string | null;
  exitBid: number | null;
  exitAsk: number | null;
  exitReason: string | null;
  pnlDollars: number | null;
  unrealizedPnlDollars: number | null;
  lastBid: number | null;
  lastAsk: number | null;
}

interface Trade {
  id: string;
  symbol: string;
  strike: number;
  expiration: string;
  dte: number;
  contracts: number;
  anchorDate: string;
  gap: number;
  signalClose: number;
  signalVwap: number;
  entryAsk: number;
  entryBid: number;
  lastBid: number | null;
  lastAsk: number | null;
  status: "open" | "closed";
  exitBid: number | null;
  exitAsk: number | null;
  exitReason: string | null;
  exitNote: string | null;
  pnlDollars: number | null;
  unrealizedPnlDollars: number | null;
  debitDollars: number;
  runningPnlDollars: number | null;
  openedAt: number;
  closedAt: number | null;
  whatIfs: WhatIf[];
}

interface Section {
  label: string;
  note: string;
  paperOnly: true;
  stored: boolean;
  budgetDollars: number;
  feePerSide: number;
  drawdownFlagDollars: number;
  health: {
    open: number;
    closed: number;
    cumulativePnlDollars: number;
    maxDrawdownDollars: number;
    drawdownFlag: boolean;
    dailyStop: boolean;
    todayLossStreak: number;
  };
  drawdown: {
    currentDrawdownDollars: number;
    openUnrealizedDollars: number;
  };
  whatIf25PnlDollars: number;
  whatIf14PnlDollars: number;
  notes: Partial<Record<string, string>>;
  updatedAt: number | null;
  open: Trade[];
  closed: Trade[];
  error?: string;
}

function money(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
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

function quote(bid: number | null, ask: number | null): string {
  if (bid == null && ask == null) return "—";
  return `${money(bid)} / ${money(ask)}`;
}

function whatIf(trade: Trade, id: string): WhatIf | null {
  return trade.whatIfs.find((leg) => leg.id === id) ?? null;
}

function whatIfText(leg: WhatIf | null): string {
  if (!leg) return "—";
  if (leg.status === "skipped") return leg.skipReason ?? "skipped";
  if (leg.status === "open") return `open ${money(leg.unrealizedPnlDollars)}`;
  return `${leg.exitReason ?? "closed"} ${money(leg.pnlDollars)}`;
}

export default function AvwapPage() {
  const [page, setPage] = useState<Section | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    fetch("/api/avwap")
      .then(async (res) => {
        const body = await res.json() as Section;
        if (!res.ok) throw new Error(body.error ?? "The AVWAP paper log could not be read.");
        if (!gone) setPage(body);
      })
      .catch((err: unknown) => {
        if (!gone) setError(err instanceof Error ? err.message : "The AVWAP paper log could not be read.");
      });
    return () => {
      gone = true;
    };
  }, []);

  const health = page?.health;
  return (
    <main style={{ minHeight: "100vh", background: "#0b0f1a", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "16px 16px 14px" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontFamily: "monospace" }}>
          <span style={{ color: "#06b6d4" }}>▣</span> AVWAP Paper
        </h1>
        <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 15, lineHeight: 1.45 }}>
          Paper only. No order is placed. The 5-minute scan records these rows from Schwab quotes and price history.
        </p>
        <PageLinks current="avwap" />
      </div>
      <div style={{ padding: "16px 16px 48px", maxWidth: 1100, margin: "0 auto" }}>
        {error && <Banner color="#fca5a5">{error}</Banner>}
        {page && !page.stored && (
          <Banner color="#fbbf24">The private store is not configured, so a paper row cannot be saved. It uses the same store as the trade log.</Banner>
        )}
        {health?.dailyStop && (
          <Banner color="#d8b4fe">Stop for the day. {health.todayLossStreak} losing paper closes in a row. A new AVWAP paper entry waits until the next Chicago day.</Banner>
        )}
        {page && health?.drawdownFlag && (
          <Banner color="#fca5a5">Cumulative paper drawdown is over ${page.drawdownFlagDollars.toLocaleString("en-US")}. This is a flag. It does not place or cancel anything.</Banner>
        )}
        {page && (
          <>
            <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.5, margin: "0 0 16px" }}>{page.note}</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 16 }}>
              <Stat label="Open" value={String(health?.open ?? 0)} />
              <Stat label="Closed" value={String(health?.closed ?? 0)} />
              <Stat label="Primary P&L" value={money(health?.cumulativePnlDollars)} />
              <Stat label="Open mark" value={money(page.drawdown.openUnrealizedDollars)} />
              <Stat label="Max drawdown" value={money(health?.maxDrawdownDollars)} />
              <Stat label="+25% / 3-day" value={money(page.whatIf25PnlDollars)} />
              <Stat label="14 DTE what-if" value={money(page.whatIf14PnlDollars)} />
            </div>
            <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 18px" }}>
              Fees are ${page.feePerSide.toFixed(2)} per contract per side. Debit cap ${page.budgetDollars}. Last scan {when(page.updatedAt)}.
              {page.notes.SPY ? ` SPY: ${page.notes.SPY}.` : ""}
              {page.notes.IWM ? ` IWM: ${page.notes.IWM}.` : ""}
              {page.notes.QQQ ? ` QQQ: ${page.notes.QQQ}.` : ""}
            </p>
            <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Open</h2>
            <TradeTable rows={page.open} empty="No open AVWAP paper position." />
            <h2 style={{ fontSize: 16, margin: "22px 0 8px" }}>Closed</h2>
            <TradeTable rows={page.closed} empty="No closed AVWAP paper trade yet." showRunning />
          </>
        )}
      </div>
    </main>
  );
}

function TradeTable({ rows, empty, showRunning = false }: { rows: Trade[]; empty: string; showRunning?: boolean }) {
  if (rows.length === 0) return <p style={{ color: "#64748b", fontSize: 14 }}>{empty}</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Contract</th>
            <th>Qty</th>
            <th>Entry bid / ask</th>
            <th>Exit or last bid / ask</th>
            <th>P&L</th>
            {showRunning ? <th>Running</th> : null}
            <th>+25% / 3-day</th>
            <th>14 DTE</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((trade) => {
            const exit = trade.status === "closed" ? quote(trade.exitBid, trade.exitAsk) : quote(trade.lastBid, trade.lastAsk);
            const pnl = trade.status === "closed" ? trade.pnlDollars : trade.unrealizedPnlDollars;
            return (
              <tr key={trade.id}>
                <td>{trade.symbol}</td>
                <td>
                  ${trade.strike} put {trade.expiration}
                  <div style={{ color: "#64748b", fontSize: 12 }}>
                    anchor {trade.anchorDate} · close {trade.signalClose.toFixed(2)} vs VWAP {trade.signalVwap.toFixed(2)}
                    {trade.exitReason ? ` · ${trade.exitReason}` : ""}
                    {trade.exitNote ? ` · ${trade.exitNote}` : ""}
                  </div>
                </td>
                <td>{trade.contracts}</td>
                <td>{quote(trade.entryBid, trade.entryAsk)}</td>
                <td>{exit}</td>
                <td style={{ color: pnl != null && pnl < 0 ? "#fca5a5" : "#86efac" }}>{money(pnl)}</td>
                {showRunning ? <td>{money(trade.runningPnlDollars)}</td> : null}
                <td>{whatIfText(whatIf(trade, "target25-or-3d"))}</td>
                <td>{whatIfText(whatIf(trade, "dte14"))}</td>
                <td>{trade.status === "closed" ? when(trade.closedAt) : when(trade.openedAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "10px 12px", background: "rgba(255,255,255,0.03)" }}>
      <div style={{ color: "#64748b", fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function Banner({ children, color }: { children: ReactNode; color: string }) {
  return (
    <p style={{ color, border: `1px solid ${color}`, borderRadius: 8, padding: "10px 12px", fontSize: 14, lineHeight: 1.45, margin: "0 0 12px" }}>
      {children}
    </p>
  );
}
