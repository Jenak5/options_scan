"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { BucketPnl, DailyStopState, TradeMetrics, TradeStats, WeeklySummary } from "@/app/lib/trades";
import { exitDefaultsSummary, planExits } from "@/app/lib/exits";

interface TradeRow {
  id: string;
  openedAt: number;
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  contracts: number;
  entryPrice: number;
  structure: "single" | "debit-spread";
  alertId: string | null;
  alertVerdict: string | null;
  alertGrade: string | null;
  closedAt: number | null;
  exitPrice: number | null;
  exitNote: string | null;
  metrics: TradeMetrics;
}

interface AlertChoice {
  id: string;
  label: string;
}

interface TradePage {
  trades: TradeRow[];
  stats: TradeStats;
  stop: DailyStopState;
  weekly: WeeklySummary;
  weeklyNote: string | null;
  alerts: AlertChoice[];
  stored: boolean;
  exitDefaults?: string;
  error?: string;
}

const INPUT: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  color: "#e2e8f0",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 6,
  padding: "8px 12px",
  fontSize: 15,
  outline: "none",
  width: "100%",
  fontFamily: "inherit",
};

export default function TradesPage() {
  const [page, setPage] = useState<TradePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [ticker, setTicker] = useState("");
  const [putCall, setPutCall] = useState<"call" | "put">("call");
  const [strike, setStrike] = useState("");
  const [expiration, setExpiration] = useState("");
  const [contracts, setContracts] = useState("1");
  const [entryPrice, setEntryPrice] = useState("");
  const [structure, setStructure] = useState<"single" | "debit-spread">("single");
  const [alertId, setAlertId] = useState("");
  const [closeId, setCloseId] = useState("");
  const [exitPrice, setExitPrice] = useState("");
  const [exitNote, setExitNote] = useState("");

  const load = useCallback(async () => {
    const res = await fetch("/api/trades");
    const json = await res.json();
    if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Trade log failed");
    setPage(json as TradePage);
  }, []);

  useEffect(() => {
    load().catch((err) => setError(err instanceof Error ? err.message : "Trade log failed"));
  }, [load]);

  async function send(body: Record<string, unknown>) {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/trades", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Trade log failed");
      setPage(json as TradePage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Trade log failed");
    } finally {
      setPending(false);
    }
  }

  function onOpen(event: FormEvent) {
    event.preventDefault();
    void send({
      action: "open",
      ticker,
      putCall,
      strike: Number(strike),
      expiration,
      contracts: Number(contracts),
      entryPrice: Number(entryPrice),
      structure,
      alertId,
    });
  }

  function onClose(event: FormEvent) {
    event.preventDefault();
    void send({
      action: "close",
      id: closeId,
      exitPrice: Number(exitPrice),
      exitNote,
    });
  }

  const stats = page?.stats;
  const preview = planExits({
    premium: Number(entryPrice),
    contracts: Number(contracts),
    structure,
  });

  return (
    <main style={{ minHeight: "100vh", background: "#0b0f1a", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: `
        .trade-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
        @media (max-width: 720px) { .trade-form { grid-template-columns: 1fr; } }
      ` }} />
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "16px 24px", display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontFamily: "monospace" }}>
            <span style={{ color: "#06b6d4" }}>▣</span> Trade log
          </h1>
          <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 14 }}>
            Manual entries only. No order placement and no broker fill import.
          </p>
        </div>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <a href="/api/trades?format=csv" style={{ color: "#06b6d4", fontSize: 14 }}>Download CSV</a>
          <a href="/" style={{ color: "#06b6d4", fontSize: 14 }}>Back to scanner</a>
        </div>
      </div>

      <div style={{ padding: 24, maxWidth: 980 }}>
        <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.5, marginTop: 0 }}>
          {page?.exitDefaults ?? exitDefaultsSummary()}
        </p>

        {page && !page.stored && (
          <Banner color="#fbbf24">
            The private store is not configured, so a trade cannot be saved. It uses the same KV, Upstash, or Blob store as alerts. Nothing new to set.
          </Banner>
        )}
        {page?.stop.dailyStop && (
          <Banner color="#d8b4fe">
            Daily stop is on. {page.stop.consecutiveLosses} closed losses in a row today, so a TAKE shows STOP for today.
          </Banner>
        )}
        {page?.weeklyNote && <Banner color="#fbbf24">{page.weeklyNote}</Banner>}
        {error && <Banner color="#fca5a5">{error}</Banner>}

        {stats && <StatsPanel stats={stats} />}

        <h2 style={{ fontSize: 16, margin: "22px 0 10px" }}>Enter a trade</h2>
        <form onSubmit={onOpen} className="trade-form">
          <Field label="Ticker"><input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} style={INPUT} /></Field>
          <Field label="Call or put">
            <select value={putCall} onChange={(e) => setPutCall(e.target.value === "put" ? "put" : "call")} style={INPUT}>
              <option value="call">Call</option>
              <option value="put">Put</option>
            </select>
          </Field>
          <Field label="Strike"><input value={strike} onChange={(e) => setStrike(e.target.value)} inputMode="decimal" style={INPUT} /></Field>
          <Field label="Expiration"><input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} style={{ ...INPUT, colorScheme: "dark" }} /></Field>
          <Field label="Contracts"><input value={contracts} onChange={(e) => setContracts(e.target.value)} inputMode="numeric" style={INPUT} /></Field>
          <Field label="Entry price"><input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} inputMode="decimal" style={INPUT} /></Field>
          <Field label="Structure">
            <select value={structure} onChange={(e) => setStructure(e.target.value === "debit-spread" ? "debit-spread" : "single")} style={INPUT}>
              <option value="single">Single option</option>
              <option value="debit-spread">Debit spread (net debit)</option>
            </select>
          </Field>
          <Field label="Link to an alert (optional)">
            <select value={alertId} onChange={(e) => setAlertId(e.target.value)} style={INPUT}>
              <option value="">None</option>
              {(page?.alerts ?? []).map((alert) => (
                <option key={alert.id} value={alert.id}>{alert.label}</option>
              ))}
            </select>
          </Field>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" disabled={pending} style={buttonStyle(pending)}>Save entry</button>
          </div>
        </form>
        {preview && (
          <div style={{ color: "#94a3b8", fontSize: 13, lineHeight: 1.45, marginTop: 10 }}>
            {preview.lines.map((line) => <div key={line}>{line}</div>)}
          </div>
        )}

        <h2 style={{ fontSize: 16, margin: "22px 0 10px" }}>Close a trade</h2>
        <form onSubmit={onClose} className="trade-form">
          <Field label="Open trade">
            <select value={closeId} onChange={(e) => setCloseId(e.target.value)} style={INPUT}>
              <option value="">Choose</option>
              {(page?.trades ?? []).filter((trade) => trade.closedAt == null).map((trade) => (
                <option key={trade.id} value={trade.id}>
                  {trade.ticker} {trade.putCall.toUpperCase()} ${trade.strike} · {trade.contracts} @ {trade.entryPrice}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Exit price"><input value={exitPrice} onChange={(e) => setExitPrice(e.target.value)} inputMode="decimal" style={INPUT} /></Field>
          <Field label="Why" wide>
            <input value={exitNote} onChange={(e) => setExitNote(e.target.value)} placeholder="Short note" style={INPUT} />
          </Field>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" disabled={pending || !closeId} style={buttonStyle(pending || !closeId)}>Close trade</button>
          </div>
        </form>

        <h2 style={{ fontSize: 16, margin: "22px 0 10px" }}>Log</h2>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ color: "#64748b", textAlign: "left" }}>
                {["When", "Contract", "Alert", "Risk", "P&L", "Result", "Hold", ""].map((head) => (
                  <th key={head} style={{ padding: "8px 10px", fontWeight: 700 }}>{head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(page?.trades ?? []).map((trade) => (
                <tr key={trade.id} style={{ borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                  <td style={{ padding: "8px 10px", whiteSpace: "nowrap" }}>{stamp(trade.openedAt)}</td>
                  <td style={{ padding: "8px 10px" }}>
                    {trade.ticker} {trade.putCall.toUpperCase()} ${trade.strike}
                    <div style={{ color: "#64748b" }}>{trade.expiration} · {trade.contracts} @ {trade.entryPrice}{trade.structure === "debit-spread" ? " debit" : ""}</div>
                    {trade.closedAt != null && (
                      <div style={{ color: "#94a3b8" }}>Out {stamp(trade.closedAt)} @ {trade.exitPrice}{trade.exitNote ? ` · ${trade.exitNote}` : ""}</div>
                    )}
                  </td>
                  <td style={{ padding: "8px 10px" }}>
                    {trade.alertVerdict ? `${trade.alertVerdict} ${trade.alertGrade ?? ""}` : trade.alertId ? "Link not in the alert book" : "—"}
                  </td>
                  <td style={{ padding: "8px 10px", color: trade.metrics.riskBreachesCap ? "#fbbf24" : "#94a3b8" }}>
                    ${trade.metrics.riskDollars.toFixed(0)}{trade.metrics.riskBreachesCap ? " over $450" : ""}
                  </td>
                  <td style={{ padding: "8px 10px", color: pnlColor(trade.metrics) }}>
                    {trade.metrics.pnlDollars == null ? "Open" : `${money(trade.metrics.pnlDollars)} · ${pct(trade.metrics.pnlFraction)}`}
                  </td>
                  <td style={{ padding: "8px 10px" }}>{trade.metrics.result ?? "open"}</td>
                  <td style={{ padding: "8px 10px", color: "#94a3b8" }}>{trade.metrics.holdMinutes == null ? "—" : `${trade.metrics.holdMinutes} min`}</td>
                  <td style={{ padding: "8px 10px" }}>
                    <button type="button" onClick={() => { if (window.confirm("Remove this manual entry?")) void send({ action: "remove", id: trade.id }); }} style={{ background: "transparent", color: "#64748b", border: "none", cursor: "pointer" }}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
              {page && page.trades.length === 0 && (
                <tr><td colSpan={8} style={{ padding: 16, color: "#475569" }}>No trades yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

function StatsPanel({ stats }: { stats: TradeStats }) {
  const cells = [
    ["Closed", String(stats.closed)],
    ["Win rate", stats.winRate == null ? "—" : `${Math.round(stats.winRate * 100)}%`],
    ["Average win", stats.averageWin == null ? "—" : money(stats.averageWin)],
    ["Average loss", stats.averageLoss == null ? "—" : money(-stats.averageLoss)],
    ["Expectancy", stats.expectancy == null ? "—" : money(stats.expectancy)],
    ["Total P&L", money(stats.totalPnl)],
    ["This week", `${money(stats.week.pnlDollars)} · ${stats.week.closed} closed`],
  ];
  return (
    <section style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 16, marginBottom: 12 }}>
        {cells.map(([label, value]) => (
          <div key={label}>
            <div style={{ color: "#64748b", fontSize: 12 }}>{label}</div>
            <div style={{ fontFamily: "monospace", fontWeight: 700 }}>{value}</div>
          </div>
        ))}
      </div>
      <Bucket title="By grade" rows={stats.byGrade} />
      <Bucket title="By checklist" rows={stats.byVerdict} />
      <div style={{ color: "#64748b", fontSize: 12, marginTop: 8 }}>{stats.sampleNote}</div>
    </section>
  );
}

function Bucket({ title, rows }: { title: string; rows: BucketPnl[] }) {
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ color: "#94a3b8", fontSize: 12, marginBottom: 4 }}>{title}</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10, fontSize: 13 }}>
        {rows.map((row) => (
          <span key={row.key} style={{ color: "#cbd5e1" }}>
            {row.key} {row.closed === 0 ? "—" : `${money(row.pnlDollars)} (${row.closed})`}
          </span>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, gridColumn: wide ? "1 / -1" : undefined }}>
      <span style={{ fontSize: 12, color: "#64748b", fontWeight: 700 }}>{label}</span>
      {children}
    </label>
  );
}

function Banner({ children, color }: { children: ReactNode; color: string }) {
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "10px 12px", marginBottom: 12, color, fontSize: 14 }}>
      {children}
    </div>
  );
}

function buttonStyle(disabled: boolean): React.CSSProperties {
  return {
    background: "rgba(6,182,212,0.15)",
    color: "#06b6d4",
    border: "1px solid rgba(6,182,212,0.35)",
    borderRadius: 6,
    padding: "10px 16px",
    fontSize: 15,
    fontWeight: 700,
    cursor: disabled ? "wait" : "pointer",
    opacity: disabled ? 0.6 : 1,
  };
}

function stamp(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function money(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

function pct(value: number | null): string {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function pnlColor(metrics: TradeMetrics): string {
  if (metrics.result === "win") return "#10b981";
  if (metrics.result === "loss") return "#ef4444";
  return "#94a3b8";
}
