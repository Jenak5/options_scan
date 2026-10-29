"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PageLinks } from "@/app/components/PageLinks";

interface Leg {
  side: "long" | "short";
  strike: number;
  expiration: string;
  delta: number | null;
  entryBid: number;
  entryAsk: number;
  exitBid: number | null;
  exitAsk: number | null;
  lastBid: number | null;
  lastAsk: number | null;
}

interface Trade {
  id: string;
  setup: "A" | "S";
  symbol: string;
  expiration: string;
  dte: number;
  contracts: number;
  sessionOpen: number;
  priorClose: number;
  flushLow: number;
  signalClose: number;
  entryDebit: number;
  status: "open" | "closed";
  exitReason: string | null;
  exitNote: string | null;
  pnlDollars: number | null;
  unrealizedPnlDollars: number | null;
  debitDollars: number;
  runningPnlDollars: number | null;
  openedAt: number;
  closedAt: number | null;
  legs: Leg[];
}

interface SetupHealth {
  open: number;
  closed: number;
  cumulativePnlDollars: number;
  maxDrawdownDollars: number;
  openUnrealizedDollars: number;
  drawdownFlag: boolean;
  dailyStop: boolean;
  todayLossStreak: number;
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
    lastCheckAt: string | null;
    drawdownFlag: boolean;
    dailyStop: boolean;
    setups: { A: SetupHealth; S: SetupHealth };
  };
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

function structure(trade: Trade): string {
  const long = trade.legs.find((leg) => leg.side === "long");
  const short = trade.legs.find((leg) => leg.side === "short");
  if (trade.setup === "A") {
    const delta = long?.delta == null ? "" : ` · delta ${long.delta.toFixed(2)}`;
    return `$${long?.strike ?? "—"} call ${trade.expiration}${delta}`;
  }
  return `$${long?.strike ?? "—"} / $${short?.strike ?? "—"} call ${trade.expiration}`;
}

export default function CallsPage() {
  const [page, setPage] = useState<Section | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    fetch("/api/calls")
      .then(async (res) => {
        const body = await res.json() as Section;
        if (!res.ok) throw new Error(body.error ?? "The calls paper log could not be read.");
        if (!gone) setPage(body);
      })
      .catch((err: unknown) => {
        if (!gone) setError(err instanceof Error ? err.message : "The calls paper log could not be read.");
      });
    return () => {
      gone = true;
    };
  }, []);

  const health = page?.health;
  const setupA = health?.setups.A;
  const setupS = health?.setups.S;
  const combined = (setupA?.cumulativePnlDollars ?? 0) + (setupS?.cumulativePnlDollars ?? 0);
  return (
    <main style={{ minHeight: "100vh", background: "#0b0f1a", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "16px 16px 14px" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontFamily: "monospace" }}>
          <span style={{ color: "#06b6d4" }}>▣</span> Calls Paper
        </h1>
        <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 15, lineHeight: 1.45 }}>
          Paper only. No order is placed. The 5-minute scan records these rows from Schwab price history and option quotes.
        </p>
        <PageLinks current="calls" />
      </div>
      <div style={{ padding: "16px 16px 48px", maxWidth: 1100, margin: "0 auto" }}>
        {error && <Banner color="#fca5a5">{error}</Banner>}
        {page && !page.stored && (
          <Banner color="#fbbf24">The private store is not configured, so a paper row cannot be saved. It uses the same store as the trade log.</Banner>
        )}
        {setupA?.dailyStop && (
          <Banner color="#d8b4fe">Setup A is stopped for the day. {setupA.todayLossStreak} losing paper closes in a row. A new long-call entry waits until the next Chicago day.</Banner>
        )}
        {setupS?.dailyStop && (
          <Banner color="#d8b4fe">Setup S is stopped for the day. {setupS.todayLossStreak} losing paper closes in a row. A new spread entry waits until the next Chicago day.</Banner>
        )}
        {page && setupA?.drawdownFlag && (
          <Banner color="#fca5a5">Setup A cumulative paper drawdown is over ${page.drawdownFlagDollars.toLocaleString("en-US")}. This is a flag. It does not place or cancel anything.</Banner>
        )}
        {page && setupS?.drawdownFlag && (
          <Banner color="#fca5a5">Setup S cumulative paper drawdown is over ${page.drawdownFlagDollars.toLocaleString("en-US")}. This is a flag. It does not place or cancel anything.</Banner>
        )}
        {page && health && (
          <>
            <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.5, margin: "0 0 16px" }}>{page.note}</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 16 }}>
              <Stat label="A open" value={String(setupA?.open ?? 0)} />
              <Stat label="A realized" value={money(setupA?.cumulativePnlDollars)} />
              <Stat label="A open mark" value={money(setupA?.openUnrealizedDollars)} />
              <Stat label="A max drawdown" value={money(setupA?.maxDrawdownDollars)} />
              <Stat label="S open" value={String(setupS?.open ?? 0)} />
              <Stat label="S realized" value={money(setupS?.cumulativePnlDollars)} />
              <Stat label="S open mark" value={money(setupS?.openUnrealizedDollars)} />
              <Stat label="S max drawdown" value={money(setupS?.maxDrawdownDollars)} />
              <Stat label="Combined realized" value={money(combined)} />
            </div>
            <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 18px" }}>
              Fees are ${page.feePerSide.toFixed(2)} per contract per side per leg. Debit cap ${page.budgetDollars}. Last check {health.lastCheckAt ? when(Date.parse(health.lastCheckAt)) : "—"}.
              {page.notes.SPY ? ` SPY: ${page.notes.SPY}.` : ""}
              {page.notes.IWM ? ` IWM: ${page.notes.IWM}.` : ""}
              {page.notes.QQQ ? ` QQQ: ${page.notes.QQQ}.` : ""}
            </p>
            <h2 style={{ fontSize: 16, margin: "0 0 8px" }}>Open</h2>
            <TradeTable rows={page.open} empty="No open calls paper position." />
            <h2 style={{ fontSize: 16, margin: "22px 0 8px" }}>Closed</h2>
            <TradeTable rows={page.closed} empty="No closed calls paper trade yet." showRunning />
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
            <th>Setup</th>
            <th>Symbol</th>
            <th>Contract</th>
            <th>Qty</th>
            <th>Entry quotes</th>
            <th>Exit or last quotes</th>
            <th>P&L</th>
            {showRunning ? <th>Running</th> : null}
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((trade) => {
            const pnl = trade.status === "closed" ? trade.pnlDollars : trade.unrealizedPnlDollars;
            return (
              <tr key={trade.id}>
                <td>{trade.setup === "A" ? "A long call" : "S spread"}</td>
                <td>{trade.symbol}</td>
                <td>
                  {structure(trade)}
                  <div style={{ color: "#64748b", fontSize: 12 }}>
                    open {trade.sessionOpen.toFixed(2)} · prior {trade.priorClose.toFixed(2)} · flush {trade.flushLow.toFixed(2)} · close {trade.signalClose.toFixed(2)}
                    {trade.exitReason ? ` · ${trade.exitReason}` : ""}
                    {trade.exitNote ? ` · ${trade.exitNote}` : ""}
                  </div>
                </td>
                <td>{trade.contracts}</td>
                <td>{trade.legs.map((leg) => `${leg.side} $${leg.strike} ${quote(leg.entryBid, leg.entryAsk)}`).join("; ")}</td>
                <td>{trade.legs.map((leg) => {
                  const mark = trade.status === "closed" ? quote(leg.exitBid, leg.exitAsk) : quote(leg.lastBid, leg.lastAsk);
                  return `${leg.side} ${mark}`;
                }).join("; ")}</td>
                <td style={{ color: pnl != null && pnl < 0 ? "#fca5a5" : "#86efac" }}>{money(pnl)}</td>
                {showRunning ? <td>{money(trade.runningPnlDollars)}</td> : null}
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
    <p style={{ color, background: "rgba(255,255,255,0.03)", border: `1px solid ${color}`, borderRadius: 8, padding: "10px 12px", margin: "0 0 12px", fontSize: 14 }}>
      {children}
    </p>
  );
}
