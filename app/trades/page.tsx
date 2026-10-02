"use client";

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { PageLinks } from "@/app/components/PageLinks";
import { formatContractCost, formatFlowPremium } from "@/app/lib/alertConfig";
import { openFlatTimeStopText } from "@/app/lib/exits";
import { MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import { PAPER_ENTRY_NOTE, type BucketPnl, type DailyStopState, type TradeMetrics, type TradeStats, type WeeklySummary } from "@/app/lib/trades";

interface TradeRow {
  id: string;
  openedAt: number;
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  contracts: number;
  entryPrice: number;
  entryPriceSource: "ask" | "typed" | null;
  flowPremium: number | null;
  structure: "single" | "debit-spread";
  alertId: string | null;
  alertVerdict: string | null;
  alertGrade: string | null;
  closedAt: number | null;
  exitPrice: number | null;
  exitNote: string | null;
  metrics: TradeMetrics;
  mark: number | null;
  markSource: "mid" | null;
  unrealizedPnl: number | null;
  flatTimeStop?: boolean;
}

interface AlertChoice {
  id: string;
  label: string;
}

interface PaperPreview {
  alertId: string;
  found: boolean;
  ticker: string;
  putCall: "call" | "put" | null;
  strike: number | null;
  expiration: string;
  grade: string | null;
  verdict: string | null;
  flowPremium: number | null;
  entryPrice: number | null;
  oneContractCost: number | null;
  blocked: string | null;
  openTradeId: string | null;
}

interface TradePage {
  trades: TradeRow[];
  stats: TradeStats;
  stop: DailyStopState;
  weekly: WeeklySummary;
  weeklyNote: string | null;
  alerts: AlertChoice[];
  stored: boolean;
  preview?: PaperPreview | null;
  entryNote?: string;
  exitDefaults?: string;
  alreadyOpen?: boolean;
  error?: string;
}

const INPUT: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  color: "#e2e8f0",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: "12px 14px",
  fontSize: 16,
  outline: "none",
  width: "100%",
  fontFamily: "inherit",
  minHeight: 48,
};

export default function TradesPage() {
  const [page, setPage] = useState<TradePage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [focusAlert, setFocusAlert] = useState<string | null>(null);
  const [contracts, setContracts] = useState("1");
  const [notice, setNotice] = useState<string | null>(null);
  const [ticker, setTicker] = useState("");
  const [putCall, setPutCall] = useState<"call" | "put">("call");
  const [strike, setStrike] = useState("");
  const [expiration, setExpiration] = useState("");
  const [handContracts, setHandContracts] = useState("1");
  const [entryPrice, setEntryPrice] = useState("");
  const [structure, setStructure] = useState<"single" | "debit-spread">("single");
  const [alertId, setAlertId] = useState("");

  const load = useCallback(async (alert: string | null) => {
    const query = alert ? `?alert=${encodeURIComponent(alert)}` : "";
    const res = await fetch(`/api/trades${query}`);
    const json = await res.json();
    if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Trade log failed");
    setPage(json as TradePage);
  }, []);

  useEffect(() => {
    const alert = new URLSearchParams(window.location.search).get("alert");
    setFocusAlert(alert);
    load(alert).catch((err) => setError(err instanceof Error ? err.message : "Trade log failed"));
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
      if (json.alreadyOpen) setNotice("This alert already has an open paper trade.");
      else if (body.action === "paper") setNotice("Paper trade saved. It is a simulated entry, not an order.");
      else if (body.action === "close") setNotice("Trade closed.");
      else setNotice(null);
      if (typeof json.focusAlertId === "string" && json.focusAlertId) {
        const next = `/trades?alert=${encodeURIComponent(json.focusAlertId)}`;
        window.history.replaceState(null, "", next);
        setFocusAlert(json.focusAlertId);
      }
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
      contracts: Number(handContracts),
      entryPrice: Number(entryPrice),
      structure,
      alertId,
    });
  }

  const preview = page?.preview ?? null;
  const openTrades = (page?.trades ?? []).filter((trade) => trade.closedAt == null);
  const closedTrades = (page?.trades ?? []).filter((trade) => trade.closedAt != null);
  const count = Math.max(1, Math.round(Number(contracts) || 1));
  const previewRisk = preview?.entryPrice != null ? preview.entryPrice * count * 100 : null;

  return (
    <main style={{ minHeight: "100vh", background: "#0b0f1a", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "16px 16px 14px" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontFamily: "monospace" }}>
          <span style={{ color: "#06b6d4" }}>▣</span> Trade log
        </h1>
        <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 15, lineHeight: 1.45 }}>
          Paper trades only. Nothing on this page places an order.
        </p>
        {page?.exitDefaults && (
          <p style={{ margin: "8px 0 0", color: "#94a3b8", fontSize: 14, lineHeight: 1.45 }}>
            {page.exitDefaults}
          </p>
        )}
        <PageLinks current="trades" />
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        @media (max-width: 560px) { .grade-grid { grid-template-columns: 1fr !important; } }
      ` }} />
      <div style={{ padding: "16px 16px 40px", maxWidth: 760, margin: "0 auto" }}>
        {page && !page.stored && (
          <Banner color="#fbbf24">
            The private store is not configured, so a trade cannot be saved. It uses the same store as alerts.
          </Banner>
        )}
        {page?.stop.dailyStop && (
          <Banner color="#d8b4fe">
            Stop for the day. {page.stop.consecutiveLosses} losing closes in a row. A new paper trade waits until the next Chicago day.
          </Banner>
        )}
        {page?.weeklyNote && <Banner color="#fbbf24">{page.weeklyNote}</Banner>}
        {notice && <Banner color="#6ee7b7">{notice}</Banner>}
        {error && <Banner color="#fca5a5">{error}</Banner>}

        {preview && (
          <section style={cardStyle}>
            <div style={{ fontSize: 13, color: "#64748b", fontWeight: 700, letterSpacing: "0.04em" }}>PAPER TRADE</div>
            {!preview.found && <p style={{ margin: "8px 0 0", fontSize: 16 }}>{preview.blocked}</p>}
            {preview.found && (
              <>
                <h2 style={{ margin: "8px 0 4px", fontSize: 26 }}>
                  {preview.ticker} {preview.putCall === "put" ? "PUT" : "CALL"} ${preview.strike}
                </h2>
                <p style={{ margin: 0, color: "#94a3b8", fontSize: 16 }}>{preview.expiration}</p>
                <p style={{ margin: "10px 0 0", fontSize: 18, fontWeight: 700 }}>
                  {preview.verdict} {preview.grade}
                </p>
                <p style={{ margin: "8px 0 0", fontSize: 16 }}>
                  Entry {preview.entryPrice == null ? "—" : `$${preview.entryPrice.toFixed(2)}`} ask
                  {" · "}
                  {preview.oneContractCost == null ? "—" : formatContractCost(preview.entryPrice ?? 0)} a contract
                </p>
                <p style={{ margin: "6px 0 0", fontSize: 16 }}>
                  Flow premium {formatFlowPremium(preview.flowPremium)}
                </p>
                <p style={{ margin: "8px 0 0", color: "#94a3b8", fontSize: 14, lineHeight: 1.45 }}>
                  {page?.entryNote ?? PAPER_ENTRY_NOTE}
                </p>
                {page?.exitDefaults && (
                  <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 14, lineHeight: 1.45 }}>
                    {page.exitDefaults}
                  </p>
                )}
                {preview.openTradeId ? (
                  <p style={{ margin: "12px 0 0", fontSize: 16 }}>This alert already has an open paper trade.</p>
                ) : (
                  <>
                    <label style={{ display: "block", marginTop: 14 }}>
                      <span style={{ display: "block", fontSize: 13, color: "#64748b", fontWeight: 700, marginBottom: 6 }}>Contracts</span>
                      <input value={contracts} onChange={(e) => setContracts(e.target.value)} inputMode="numeric" style={{ ...INPUT, maxWidth: 120 }} />
                    </label>
                    {previewRisk != null && (
                      <p style={{ margin: "8px 0 0", fontSize: 15, color: previewRisk > MAX_LOSS_DOLLARS ? "#fbbf24" : "#94a3b8" }}>
                        {count} contract{count === 1 ? "" : "s"} risk about ${Math.round(previewRisk).toLocaleString("en-US")}. Ceiling is ${MAX_LOSS_DOLLARS}.
                      </p>
                    )}
                    <button
                      type="button"
                      disabled={pending || Boolean(preview.blocked) || (previewRisk != null && previewRisk > MAX_LOSS_DOLLARS)}
                      onClick={() => {
                        void send({ action: "paper", alertId: preview.alertId, contracts: count });
                      }}
                      style={primaryButton(pending || Boolean(preview.blocked) || (previewRisk != null && previewRisk > MAX_LOSS_DOLLARS))}
                    >
                      {pending ? "Saving…" : "Record paper trade"}
                    </button>
                    {preview.blocked && <p style={{ margin: "8px 0 0", color: "#fca5a5", fontSize: 15 }}>{preview.blocked}</p>}
                  </>
                )}
              </>
            )}
          </section>
        )}

        {page?.stats && <GradeStats stats={page.stats} />}

        <h2 style={sectionTitle}>Open</h2>
        {openTrades.length === 0 && <p style={{ color: "#64748b", fontSize: 16 }}>No open paper trades.</p>}
        {openTrades.map((trade) => (
          <TradeCard
            key={trade.id}
            trade={trade}
            pending={pending}
            highlight={focusAlert != null && trade.alertId === focusAlert}
            onClose={(exitPrice, exitNote) => { void send({ action: "close", id: trade.id, exitPrice, exitNote }); }}
            onRemove={() => { if (window.confirm("Remove this paper trade?")) void send({ action: "remove", id: trade.id }); }}
          />
        ))}

        <h2 style={sectionTitle}>Closed</h2>
        {closedTrades.length === 0 && <p style={{ color: "#64748b", fontSize: 16 }}>No closed paper trades yet.</p>}
        {closedTrades.map((trade) => (
          <TradeCard
            key={trade.id}
            trade={trade}
            pending={pending}
            highlight={false}
            onClose={() => undefined}
            onRemove={() => { if (window.confirm("Remove this paper trade?")) void send({ action: "remove", id: trade.id }); }}
          />
        ))}

        <p style={{ marginTop: 18 }}>
          <a href="/api/trades?format=csv" style={{ color: "#06b6d4", fontSize: 15 }}>Download CSV</a>
        </p>

        <details style={{ marginTop: 22 }}>
          <summary style={{ cursor: "pointer", fontSize: 16, color: "#94a3b8", minHeight: 44 }}>Enter a trade by hand</summary>
          <form onSubmit={onOpen} style={{ display: "grid", gap: 12, marginTop: 12 }}>
            <Field label="Ticker"><input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} style={INPUT} /></Field>
            <Field label="Call or put">
              <select value={putCall} onChange={(e) => setPutCall(e.target.value === "put" ? "put" : "call")} style={INPUT}>
                <option value="call">Call</option>
                <option value="put">Put</option>
              </select>
            </Field>
            <Field label="Strike"><input value={strike} onChange={(e) => setStrike(e.target.value)} inputMode="decimal" style={INPUT} /></Field>
            <Field label="Expiration"><input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} style={{ ...INPUT, colorScheme: "dark" }} /></Field>
            <Field label="Contracts"><input value={handContracts} onChange={(e) => setHandContracts(e.target.value)} inputMode="numeric" style={INPUT} /></Field>
            <Field label="Entry price you type"><input value={entryPrice} onChange={(e) => setEntryPrice(e.target.value)} inputMode="decimal" style={INPUT} /></Field>
            <Field label="Structure">
              <select value={structure} onChange={(e) => setStructure(e.target.value === "debit-spread" ? "debit-spread" : "single")} style={INPUT}>
                <option value="single">Single option</option>
                <option value="debit-spread">Debit spread (net debit)</option>
              </select>
            </Field>
            <Field label="Link to an alert">
              <select value={alertId} onChange={(e) => setAlertId(e.target.value)} style={INPUT}>
                <option value="">None</option>
                {(page?.alerts ?? []).map((alert) => (
                  <option key={alert.id} value={alert.id}>{alert.label}</option>
                ))}
              </select>
            </Field>
            <button type="submit" disabled={pending} style={primaryButton(pending)}>Save hand entry</button>
          </form>
        </details>
      </div>
    </main>
  );
}

function TradeCard({
  trade,
  pending,
  highlight,
  onClose,
  onRemove,
}: {
  trade: TradeRow;
  pending: boolean;
  highlight: boolean;
  onClose: (exitPrice: number, exitNote: string) => void;
  onRemove: () => void;
}) {
  const [exitPrice, setExitPrice] = useState("");
  const [exitNote, setExitNote] = useState("");
  const open = trade.closedAt == null;
  const pnl = open ? trade.unrealizedPnl : trade.metrics.pnlDollars;
  return (
    <article style={{ ...cardStyle, outline: highlight ? "2px solid rgba(6,182,212,0.7)" : undefined }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            {trade.ticker} {trade.putCall === "put" ? "PUT" : "CALL"} ${trade.strike}
          </div>
          <div style={{ color: "#94a3b8", fontSize: 15, marginTop: 2 }}>{trade.expiration} · {trade.contracts} contract{trade.contracts === 1 ? "" : "s"}</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{trade.alertGrade ?? "—"}</div>
          <div style={{ color: "#94a3b8", fontSize: 13 }}>{trade.alertVerdict ?? (trade.alertId ? "Unlinked" : "No alert")}</div>
        </div>
      </div>
      <p style={{ margin: "10px 0 0", fontSize: 15, lineHeight: 1.45 }}>
        In {stamp(trade.openedAt)} at ${trade.entryPrice.toFixed(2)} {entryLabel(trade.entryPriceSource)}
      </p>
      <p style={{ margin: "4px 0 0", fontSize: 15, color: "#94a3b8" }}>
        Flow premium {formatFlowPremium(trade.flowPremium)}
        {trade.alertId ? " · linked to the alert" : ""}
      </p>
      <p style={{ margin: "8px 0 0", fontSize: 18, fontWeight: 700, color: pnlColor(pnl, open ? null : trade.metrics.result) }}>
        {open
          ? (pnl == null ? "No quote right now" : `${money(pnl)} open`)
          : `${money(pnl ?? 0)} · ${trade.metrics.result ?? "closed"}`}
      </p>
      {open && trade.mark != null && (
        <p style={{ margin: "4px 0 0", color: "#94a3b8", fontSize: 14 }}>
          Mark ${trade.mark.toFixed(2)} midpoint. Entry was the ask, so this P/L is not a fill.
        </p>
      )}
      {!open && (
        <p style={{ margin: "4px 0 0", color: "#94a3b8", fontSize: 14 }}>
          Out {trade.closedAt ? stamp(trade.closedAt) : ""} at ${trade.exitPrice?.toFixed(2)}{trade.exitNote ? ` · ${trade.exitNote}` : ""}
        </p>
      )}
      <p style={{ margin: "4px 0 0", color: trade.metrics.riskBreachesCap ? "#fbbf24" : "#64748b", fontSize: 13 }}>
        Risk ${trade.metrics.riskDollars.toFixed(0)}{trade.metrics.riskBreachesCap ? ` over $${MAX_LOSS_DOLLARS}` : ""}
      </p>
      {open && trade.flatTimeStop && (
        <p style={{ margin: "8px 0 0", color: "#fbbf24", fontSize: 15, lineHeight: 1.4 }}>{openFlatTimeStopText()}</p>
      )}
      {open && (
        <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
          <button
            type="button"
            disabled={pending || trade.mark == null}
            onClick={() => onClose(trade.mark as number, "Closed at the midpoint")}
            style={primaryButton(pending || trade.mark == null)}
          >
            {trade.mark == null ? "No current price to close at" : `Close at $${trade.mark.toFixed(2)}`}
          </button>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={exitPrice}
              onChange={(e) => setExitPrice(e.target.value)}
              inputMode="decimal"
              placeholder="Exit price"
              aria-label="Exit price"
              style={{ ...INPUT, flex: 1 }}
            />
            <button
              type="button"
              disabled={pending || !(Number(exitPrice) > 0)}
              onClick={() => onClose(Number(exitPrice), exitNote)}
              style={{ ...primaryButton(pending || !(Number(exitPrice) > 0)), width: "auto", padding: "12px 16px" }}
            >
              Close
            </button>
          </div>
          <input
            value={exitNote}
            onChange={(e) => setExitNote(e.target.value)}
            placeholder="Note, optional"
            aria-label="Exit note"
            style={INPUT}
          />
        </div>
      )}
      <button type="button" onClick={onRemove} style={{ marginTop: 8, background: "transparent", color: "#64748b", border: "none", fontSize: 14, minHeight: 44, cursor: "pointer" }}>
        Remove
      </button>
    </article>
  );
}

function GradeStats({ stats }: { stats: TradeStats }) {
  const grades = stats.byGrade.filter((row) => row.key === "A" || row.key === "B");
  return (
    <section style={{ marginTop: 16 }}>
      <h2 style={{ ...sectionTitle, marginTop: 0 }}>By grade</h2>
      <div className="grade-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        {grades.map((row) => <GradeCard key={row.key} row={row} />)}
      </div>
      <p style={{ color: "#64748b", fontSize: 13, lineHeight: 1.45 }}>{stats.sampleNote}</p>
      <p style={{ color: "#94a3b8", fontSize: 14 }}>
        All closed trades {money(stats.totalPnl)} · win rate {stats.winRate == null ? "—" : `${Math.round(stats.winRate * 100)}%`}
      </p>
    </section>
  );
}

function GradeCard({ row }: { row: BucketPnl }) {
  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 28, fontWeight: 800 }}>{row.key}</div>
      <Stat label="Win rate" value={row.winRate == null ? "—" : `${Math.round(row.winRate * 100)}%`} />
      <Stat label="Average win" value={row.averageWin == null ? "—" : money(row.averageWin)} />
      <Stat label="Average loss" value={row.averageLoss == null ? "—" : money(-row.averageLoss)} />
      <Stat label="Total P/L" value={row.closed === 0 ? "—" : money(row.pnlDollars)} />
      <div style={{ color: "#64748b", fontSize: 13, marginTop: 6 }}>{row.closed} closed</div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 15, marginTop: 6 }}>
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span style={{ fontWeight: 700 }}>{value}</span>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 13, color: "#64748b", fontWeight: 700 }}>{label}</span>
      {children}
    </label>
  );
}

function Banner({ children, color }: { children: ReactNode; color: string }) {
  return (
    <div style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10, padding: "12px 14px", marginBottom: 12, color, fontSize: 16, lineHeight: 1.4 }}>
      {children}
    </div>
  );
}

function primaryButton(disabled: boolean): React.CSSProperties {
  return {
    width: "100%",
    minHeight: 48,
    marginTop: 8,
    background: "rgba(6,182,212,0.16)",
    color: "#06b6d4",
    border: "1px solid rgba(6,182,212,0.4)",
    borderRadius: 10,
    padding: "12px 16px",
    fontSize: 17,
    fontWeight: 700,
    cursor: disabled ? "wait" : "pointer",
    opacity: disabled ? 0.55 : 1,
  };
}

const cardStyle: React.CSSProperties = {
  background: "#111827",
  border: "1px solid rgba(255,255,255,0.08)",
  borderRadius: 12,
  padding: 16,
  marginBottom: 12,
};

const sectionTitle: React.CSSProperties = { fontSize: 16, margin: "22px 0 10px" };

function entryLabel(source: TradeRow["entryPriceSource"]): string {
  if (source === "ask") return "ask";
  if (source === "typed") return "typed";
  return "";
}

function stamp(ms: number): string {
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function money(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

function pnlColor(value: number | null, result: string | null): string {
  if (result === "win" || (result == null && value != null && value > 0)) return "#10b981";
  if (result === "loss" || (result == null && value != null && value < 0)) return "#ef4444";
  return "#94a3b8";
}
