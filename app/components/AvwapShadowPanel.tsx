"use client";

import { useEffect, useState, type ReactNode } from "react";

interface Mark {
  at: number;
  bid: number;
  ask: number;
  spread: number;
}

interface Trade {
  id: string;
  symbol: string;
  strike: number;
  expiration: string;
  contracts: number;
  entryBid: number;
  entryAsk: number;
  entrySpread: number;
  lastBid: number | null;
  lastAsk: number | null;
  status: "open" | "closed";
  exitBid: number | null;
  exitAsk: number | null;
  exitReason: string | null;
  exitNote: string | null;
  pnlDollars: number | null;
  unrealizedPnlDollars: number | null;
  openedAt: number;
  closedAt: number | null;
  markCount: number;
  marks: Mark[];
}

interface Month {
  month: string;
  closed: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnlDollars: number;
}

interface Book {
  id: string;
  label: string;
  rule: string;
  openCount: number;
  closedCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netPnlDollars: number;
  openUnrealizedDollars: number;
  byMonth: Month[];
  open: Trade[];
  closed: Trade[];
}

interface Decision {
  action: "taken" | "skipped";
  reason: string;
}

interface Signal {
  id: string;
  symbol: string;
  side: "put";
  dayOfWeek: string;
  signalAt: number;
  gap: number;
  gapDirection: "up" | "down";
  vwapDistance: number;
  entryBid: number | null;
  entryAsk: number | null;
  books: {
    main: Decision;
    "skip-monday": Decision;
    "skip-before-945": Decision;
  };
}

interface Section {
  label: string;
  note: string;
  paperOnly: true;
  telegram: false;
  stored: boolean;
  books: Book[];
  signals: Signal[];
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

function rate(value: number | null): string {
  if (value == null) return "—";
  return `${Math.round(value * 100)}%`;
}

function record(wins: number, losses: number): string {
  return `${wins}W ${losses}L`;
}

function monthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1));
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", year: "numeric" }).format(date);
}

function decisionText(decision: Decision | undefined): string {
  if (!decision) return "—";
  return decision.action === "taken" ? "taken" : "skipped";
}

export function AvwapShadowPanel() {
  const [page, setPage] = useState<Section | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let gone = false;
    fetch("/api/avwap-shadow")
      .then(async (res) => {
        const body = await res.json() as Section;
        if (!res.ok) throw new Error(body.error ?? "The AVWAP shadow log could not be read.");
        if (!gone) setPage(body);
      })
      .catch((err: unknown) => {
        if (!gone) setError(err instanceof Error ? err.message : "The AVWAP shadow log could not be read.");
      });
    return () => {
      gone = true;
    };
  }, []);

  const signals = page?.signals.slice(0, 12) ?? [];
  return (
    <section style={{ marginTop: 28, paddingTop: 8, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
      <h2 style={{ fontSize: 18, margin: "0 0 8px" }}>Shadow books</h2>
      <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.5, margin: "0 0 12px" }}>
        Paper only. No order is placed. No Telegram alert is sent. Same signal and same quote as the live book. Each book keeps its own ticker slot.
      </p>
      {error && <Banner color="#fca5a5">{error}</Banner>}
      {page && !page.stored && (
        <Banner color="#fbbf24">The private store is not configured, so a shadow row cannot be saved. It uses the same store as the AVWAP paper log.</Banner>
      )}
      {page?.books.map((book) => (
        <article key={book.id} style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "12px 12px 4px", marginBottom: 14 }}>
          <h3 style={{ fontSize: 15, margin: "0 0 4px" }}>{book.label}</h3>
          <p style={{ color: "#94a3b8", fontSize: 13, margin: "0 0 10px" }}>{book.rule}</p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 8, marginBottom: 10 }}>
            <Stat label="Open" value={String(book.openCount)} />
            <Stat label="Closed" value={String(book.closedCount)} />
            <Stat label="W / L" value={record(book.wins, book.losses)} />
            <Stat label="Win rate" value={rate(book.winRate)} />
            <Stat label="Net P&L" value={money(book.netPnlDollars)} />
            <Stat label="Open mark" value={money(book.openUnrealizedDollars)} />
          </div>
          <h4 style={{ fontSize: 13, margin: "0 0 6px", color: "#94a3b8" }}>By month</h4>
          {book.byMonth.length === 0 ? (
            <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 10px" }}>No closed month yet.</p>
          ) : (
            <div style={{ overflowX: "auto", marginBottom: 10 }}>
              <table>
                <thead>
                  <tr>
                    <th>Month</th>
                    <th>Closed</th>
                    <th>W / L</th>
                    <th>Win rate</th>
                    <th>Net P&L</th>
                  </tr>
                </thead>
                <tbody>
                  {book.byMonth.map((month) => (
                    <tr key={month.month}>
                      <td>{monthLabel(month.month)}</td>
                      <td>{month.closed}</td>
                      <td>{record(month.wins, month.losses)}</td>
                      <td>{rate(month.winRate)}</td>
                      <td style={{ color: month.netPnlDollars < 0 ? "#fca5a5" : "#86efac" }}>{money(month.netPnlDollars)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h4 style={{ fontSize: 13, margin: "0 0 6px", color: "#94a3b8" }}>Open positions</h4>
          <TradeRows rows={book.open} empty="No open position in this book." />
          <h4 style={{ fontSize: 13, margin: "12px 0 6px", color: "#94a3b8" }}>Closed trades</h4>
          <TradeRows rows={book.closed.slice(0, 20)} empty="No closed trade in this book." closed />
          {book.closed.length > 20 && (
            <p style={{ color: "#64748b", fontSize: 12, margin: "6px 0 10px" }}>Showing 20 of {book.closed.length} closed trades. The API returns the stored rows.</p>
          )}
        </article>
      ))}
      {page && (
        <>
          <h3 style={{ fontSize: 15, margin: "6px 0 8px" }}>Signal log</h3>
          {signals.length === 0 ? (
            <p style={{ color: "#64748b", fontSize: 14 }}>No AVWAP signal recorded yet.</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Side</th>
                    <th>NY day</th>
                    <th>Signal bar</th>
                    <th>Gap</th>
                    <th>Vs VWAP</th>
                    <th>Entry bid / ask</th>
                    <th>Live</th>
                    <th>Skip Monday</th>
                    <th>Skip before 9:45</th>
                  </tr>
                </thead>
                <tbody>
                  {signals.map((signal) => (
                    <tr key={signal.id}>
                      <td>{signal.symbol}</td>
                      <td>{signal.side}</td>
                      <td>{signal.dayOfWeek}</td>
                      <td>{when(signal.signalAt)}</td>
                      <td>{signal.gapDirection} {(signal.gap * 100).toFixed(2)}%</td>
                      <td>{signal.vwapDistance.toFixed(2)}</td>
                      <td>{quote(signal.entryBid, signal.entryAsk)}</td>
                      <td>{decisionText(signal.books.main)}</td>
                      <td>{decisionText(signal.books["skip-monday"])}</td>
                      <td>{decisionText(signal.books["skip-before-945"])}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function TradeRows({ rows, empty, closed = false }: { rows: Trade[]; empty: string; closed?: boolean }) {
  if (rows.length === 0) return <p style={{ color: "#64748b", fontSize: 13, margin: "0 0 8px" }}>{empty}</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table>
        <thead>
          <tr>
            <th>Symbol</th>
            <th>Contract</th>
            <th>Entry bid / ask</th>
            <th>Spread</th>
            <th>{closed ? "Exit bid / ask" : "Last bid / ask"}</th>
            <th>Marks</th>
            <th>Exit</th>
            <th>P&L</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((trade) => {
            const pnl = trade.status === "closed" ? trade.pnlDollars : trade.unrealizedPnlDollars;
            const shown = trade.status === "closed" ? quote(trade.exitBid, trade.exitAsk) : quote(trade.lastBid, trade.lastAsk);
            return (
              <tr key={trade.id}>
                <td>{trade.symbol}</td>
                <td>${trade.strike} put {trade.expiration}</td>
                <td>{quote(trade.entryBid, trade.entryAsk)}</td>
                <td>{money(trade.entrySpread)}</td>
                <td>{shown}</td>
                <td>{trade.markCount}</td>
                <td>{trade.exitReason ?? "—"}{trade.exitNote ? ` · ${trade.exitNote}` : ""}</td>
                <td style={{ color: pnl != null && pnl < 0 ? "#fca5a5" : "#86efac" }}>{money(pnl)}</td>
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
    <div style={{ border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: "8px 10px" }}>
      <div style={{ color: "#64748b", fontSize: 11, fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{value}</div>
    </div>
  );
}

function Banner({ children, color }: { children: ReactNode; color: string }) {
  return (
    <p style={{ color, border: `1px solid ${color}`, borderRadius: 8, padding: "8px 10px", fontSize: 13, lineHeight: 1.45, margin: "0 0 10px" }}>
      {children}
    </p>
  );
}
