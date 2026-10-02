"use client";

import React, { useState, useEffect, useCallback } from "react";
import { FlowTab } from "@/app/components/FlowTab";
import { SchwabBanner } from "@/app/components/SchwabBanner";
import { formatContractPriceLine, formatFlowPremium } from "@/app/lib/alertConfig";
import type { AlertSummary, StoredAlert } from "@/app/lib/alertBook";
import { notionalPremium } from "@/app/lib/flow";
import { formatLevelsSummary } from "@/app/lib/levels";
import { planExitsForAsk } from "@/app/lib/exits";
import { ACCOUNT_SIZE_DOLLARS, MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import { VOL_DEFINITIONS, VOL_DISCLAIMER, compareVolReadings, type VolArbReading } from "@/app/lib/volArb";
import type { AlertVerdict } from "@/app/lib/verdict";

// ─── API helpers ───────────────────────────────────────────────────────────
async function fetchApi(base: string, params: Record<string, string>) {
  const url = new URL(base, window.location.origin);
  Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
  const res = await fetch(url.toString());
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.data;
}
const tt = (p: Record<string, string>) => fetchApi("/api/tastytrade", p);

// ─── Safe number helpers ───────────────────────────────────────────────────
function safeNum(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : parseFloat(String(v));
  return isFinite(n) ? n : fallback;
}
function fmt(v: unknown, decimals: number, fallback = "—"): string {
  const n = safeNum(v, NaN);
  return isNaN(n) ? fallback : n.toFixed(decimals);
}
function fmtPremium(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v}`;
}
function fmtDate(d: string | undefined | null): string {
  if (!d) return "—";
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

// ─── Shared styles ──────────────────────────────────────────────────────────
// TH / TD base sizes — explicit so nothing overrides by inheritance
const TH: React.CSSProperties = {
  padding: "9px 12px", textAlign: "left",
  color: "#475569", fontWeight: 700,
  fontSize: 14, whiteSpace: "nowrap",
};
const TH_C: React.CSSProperties = { ...TH, textAlign: "center" };
const TD: React.CSSProperties  = {
  padding: "10px 12px", fontSize: 16,
};
const TD_C: React.CSSProperties = { ...TD, textAlign: "center" };
const TD_MONO: React.CSSProperties = { ...TD, fontFamily: "monospace" };
const TD_MONO_C: React.CSSProperties = { ...TD, fontFamily: "monospace", textAlign: "center" };

// ─── Shared UI ─────────────────────────────────────────────────────────────
type BadgeColor = "green" | "red" | "amber" | "blue" | "purple" | "cyan" | "gray";

const BC: Record<BadgeColor, { bg: string; text: string; border: string }> = {
  green:  { bg: "rgba(16,185,129,0.12)",  text: "#10b981", border: "rgba(16,185,129,0.3)"  },
  red:    { bg: "rgba(239,68,68,0.12)",   text: "#ef4444", border: "rgba(239,68,68,0.3)"   },
  amber:  { bg: "rgba(245,158,11,0.12)",  text: "#f59e0b", border: "rgba(245,158,11,0.3)"  },
  blue:   { bg: "rgba(59,130,246,0.12)",  text: "#3b82f6", border: "rgba(59,130,246,0.3)"  },
  purple: { bg: "rgba(168,85,247,0.12)",  text: "#a855f7", border: "rgba(168,85,247,0.3)"  },
  cyan:   { bg: "rgba(6,182,212,0.12)",   text: "#06b6d4", border: "rgba(6,182,212,0.3)"   },
  gray:   { bg: "rgba(100,116,139,0.10)", text: "#64748b", border: "rgba(100,116,139,0.25)" },
};

function Badge({ children, color = "gray" }: { children: React.ReactNode; color?: BadgeColor }) {
  const s = BC[color];
  return (
    <span style={{
      background: s.bg, color: s.text, border: `1px solid ${s.border}`,
      padding: "3px 8px", borderRadius: 4, fontSize: 12, fontWeight: 700,
      letterSpacing: "0.05em", whiteSpace: "nowrap", fontFamily: "monospace",
    }}>{children}</span>
  );
}

function Spinner() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
      <div style={{
        width: 28, height: 28,
        border: "3px solid rgba(6,182,212,0.15)",
        borderTopColor: "#06b6d4", borderRadius: "50%",
        animation: "oes-spin 0.75s linear infinite",
      }} />
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div style={{ background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: "14px 18px", textAlign: "center" }}>
      <div style={{ color: "#ef4444", fontSize: 14, marginBottom: 8 }}>{message}</div>
      {onRetry && <button onClick={onRetry} style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, padding: "6px 16px", fontSize: 13, cursor: "pointer" }}>Retry</button>}
    </div>
  );
}

const INPUT: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)", color: "#e2e8f0",
  border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6,
  padding: "8px 14px", fontSize: 15, outline: "none", fontFamily: "inherit",
};

const BTN = (color: "cyan" | "gray" | "ghost"): React.CSSProperties => {
  const map = {
    cyan:  { bg: "rgba(6,182,212,0.15)",   fg: "#06b6d4", border: "rgba(6,182,212,0.3)"   },
    gray:  { bg: "rgba(255,255,255,0.06)", fg: "#94a3b8", border: "rgba(255,255,255,0.1)" },
    ghost: { bg: "transparent",            fg: "#475569", border: "rgba(255,255,255,0.08)" },
  }[color];
  return { background: map.bg, color: map.fg, border: `1px solid ${map.border}`, borderRadius: 6, padding: "8px 16px", fontSize: 15, cursor: "pointer" };
};

function ExitLines({ ask, maxContracts }: { ask: number; maxContracts: number | null }) {
  const plan = planExitsForAsk(ask, maxContracts);
  if (!plan) return null;
  return (
    <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 4, lineHeight: 1.4 }}>
      {plan.lines.map((line) => <div key={line}>{line}</div>)}
    </div>
  );
}

function verdictColor(verdict: AlertVerdict["verdict"]): BadgeColor {
  if (verdict === "TAKE") return "green";
  if (verdict === "WATCH") return "amber";
  if (verdict === "STOP") return "purple";
  return "red";
}

function outcomeColor(outcome: StoredAlert["outcome"]): string {
  if (outcome === "win") return "#10b981";
  if (outcome === "miss") return "#ef4444";
  if (outcome === "flat") return "#94a3b8";
  return "#64748b";
}

function pctText(value: number | null | undefined): string {
  if (value == null || !isFinite(value)) return "—";
  const pct = value * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function hitText(rate: number | null, wins: number, graded: number): string {
  if (rate == null || graded === 0) return "—";
  return `${Math.round(rate * 100)}% (${wins}/${graded})`;
}

// ═══════════════════════════════════════════════════════════════════════════
// VOL ARB  — Schwab chain IV vs Schwab realized vol. Research only.
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULT_WATCHLIST = ["SPY","QQQ","AAPL","MSFT","NVDA","TSLA","AMZN","META","GOOGL","AMD","SMCI","COIN","MSTR","PLTR","ARM"];
const VOL_TICKER = /^[A-Z][A-Z0-9.\-]{0,9}$/;
const VOL_CHUNK = 4;

interface VolProblem { symbol: string; message: string; }

function volDefinition(label: string): string {
  return VOL_DEFINITIONS.find((item) => item.label === label)?.text ?? "";
}

function volPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(1)}%`;
}

function volPoints(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(1)}`;
}

function volBadge(signal: VolArbReading["signal"]): { label: string; color: BadgeColor; bc: string } {
  if (signal === "CHEAP") return { label: "CHEAP", color: "green", bc: "#10b981" };
  if (signal === "RICH") return { label: "RICH", color: "red", bc: "#ef4444" };
  if (signal === "NEUTRAL") return { label: "NEUTRAL", color: "blue", bc: "#3b82f6" };
  return { label: "NO READ", color: "gray", bc: "#64748b" };
}

function spreadColor(value: number | null): string {
  if (value == null) return "#94a3b8";
  if (value <= -5) return "#10b981";
  if (value >= 8) return "#ef4444";
  return "#f59e0b";
}

function VolArbTab() {
  const [rows, setRows] = useState<VolArbReading[]>([]);
  const [problems, setProblems] = useState<VolProblem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [reconnect, setReconnect] = useState("/api/schwab/connect");
  const [watchlist, setWatchlist] = useState<string[]>(DEFAULT_WATCHLIST);
  const [newTicker, setNewTicker] = useState("");
  const [tickerNote, setTickerNote] = useState<string | null>(null);
  const requestId = React.useRef(0);

  const addTicker = () => {
    const t = newTicker.trim().toUpperCase();
    if (!t) return;
    if (!VOL_TICKER.test(t)) {
      setTickerNote("Use a ticker like HOOD.");
      return;
    }
    if (watchlist.length >= 20) {
      setTickerNote("The list holds 20 tickers.");
      return;
    }
    setTickerNote(null);
    if (!watchlist.includes(t)) setWatchlist((prev) => [...prev, t]);
    setNewTicker("");
  };
  const removeTicker = (t: string) => setWatchlist((prev) => prev.filter((x) => x !== t));

  const load = useCallback(async (fresh = false) => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    setDisconnected(false);
    setProblems([]);
    if (watchlist.length === 0) {
      setRows([]);
      setLoading(false);
      return;
    }
    const collected: VolArbReading[] = [];
    const found: VolProblem[] = [];
    try {
      for (let i = 0; i < watchlist.length; i += VOL_CHUNK) {
        const slice = watchlist.slice(i, i + VOL_CHUNK);
        const url = new URL("/api/vol", window.location.origin);
        url.searchParams.set("symbols", slice.join(","));
        if (fresh) url.searchParams.set("fresh", "true");
        const res = await fetch(url.toString());
        const json = await res.json();
        if (requestId.current !== id) return;
        if (json.connected === false || res.status === 409 || res.status === 503) {
          setDisconnected(true);
          setReconnect(typeof json.reconnect === "string" ? json.reconnect : "");
          setError(typeof json.error === "string" ? json.error : "Schwab is not connected. Use Reconnect Schwab.");
          setRows([]);
          return;
        }
        if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Vol scan failed");
        if (Array.isArray(json.rows)) collected.push(...json.rows);
        if (Array.isArray(json.errors)) {
          for (const item of json.errors) {
            if (!item || typeof item.symbol !== "string") continue;
            found.push({
              symbol: item.symbol,
              message: typeof item.message === "string" ? item.message : "Schwab market data request failed",
            });
          }
        }
      }
      if (requestId.current !== id) return;
      collected.sort(compareVolReadings);
      setRows(collected);
      setProblems(found);
    } catch (e: unknown) {
      if (requestId.current !== id) return;
      collected.sort(compareVolReadings);
      setRows(collected);
      setProblems(found);
      setError(e instanceof Error ? e.message : "Vol scan failed");
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, [watchlist]);

  useEffect(() => { load(false); }, [load]);

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
          <input placeholder="Add ticker… (e.g. HOOD)" value={newTicker}
            onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && addTicker()}
            style={{ ...INPUT, width: 180 }} />
          <button onClick={addTicker} style={BTN("cyan")}>+ Add</button>
          <button onClick={() => load(true)} style={BTN("gray")}>↻ Refresh</button>
          <button onClick={() => { setTickerNote(null); setWatchlist(DEFAULT_WATCHLIST); }} style={BTN("ghost")}>Reset</button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {watchlist.map((t) => (
            <div key={t} style={{ display: "flex", alignItems: "center", gap: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "4px 10px 4px 14px", fontSize: 14 }}>
              <span style={{ color: "#e2e8f0", fontFamily: "monospace", fontWeight: 600 }}>{t}</span>
              <button onClick={() => removeTicker(t)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 0 0 4px" }}>×</button>
            </div>
          ))}
        </div>
        {tickerNote && <div style={{ color: "#f59e0b", fontSize: 13, marginTop: 8 }}>{tickerNote}</div>}
      </div>
      <div style={{ background: "rgba(6,182,212,0.06)", border: "1px solid rgba(6,182,212,0.18)", borderRadius: 8, padding: "12px 16px", marginBottom: 16, fontSize: 13, color: "#94a3b8", lineHeight: 1.45 }}>
        <div style={{ color: "#e2e8f0", fontWeight: 700, marginBottom: 6 }}>{VOL_DISCLAIMER}</div>
        {VOL_DEFINITIONS.map((item) => (
          <div key={item.label} style={{ marginTop: 4 }}>
            <span style={{ color: "#e2e8f0", fontWeight: 700 }}>{item.label}. </span>
            {item.text}
          </div>
        ))}
      </div>
      {disconnected && (
        <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.35)", borderRadius: 8, padding: "16px 18px", marginBottom: 12 }}>
          <div style={{ color: "#fbbf24", fontSize: 15, fontWeight: 700, marginBottom: 8 }}>{error}</div>
          <div style={{ color: "#94a3b8", fontSize: 13, marginBottom: reconnect ? 8 : 0 }}>Vol Arb needs a live Schwab chain. Nothing is estimated from a delayed feed.</div>
          {reconnect && <a href={reconnect} style={{ color: "#06b6d4", fontWeight: 700 }}>Reconnect Schwab</a>}
        </div>
      )}
      {loading && <Spinner />}
      {!disconnected && error && <ErrorBox message={error} onRetry={() => load(true)} />}
      {!loading && !disconnected && problems.length > 0 && (
        <div style={{ color: "#f59e0b", fontSize: 13, marginBottom: 8 }}>
          Some tickers did not load: {problems.map((item) => `${item.symbol} (${item.message})`).join(" · ")}
        </div>
      )}
      {!loading && !disconnected && !error && watchlist.length === 0 && (
        <div style={{ color: "#94a3b8", fontSize: 14 }}>Add a ticker. Vol Arb reads that symbol from Schwab.</div>
      )}
      {!loading && !disconnected && !error && watchlist.length > 0 && rows.length === 0 && (
        <div style={{ color: "#94a3b8", fontSize: 14 }}>No vol readings came back. Check the ticker or use Refresh.</div>
      )}
      {!loading && !disconnected && rows.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
          {rows.map((r) => {
            const sig = volBadge(r.signal);
            const skewHow = r.skewMethod === "25-delta" ? "near 25 delta" : r.skewMethod === "otm" ? "about 5% from the stock" : "";
            return (
              <div key={r.symbol} style={{ background: "rgba(255,255,255,0.035)", border: `2px solid ${sig.bc}44`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontWeight: 700, fontSize: 18, color: "#e2e8f0", fontFamily: "monospace" }}>{r.symbol}</span>
                  <Badge color={sig.color}>{sig.label}</Badge>
                </div>
                {(r.underlyingPrice != null || r.atmExpiration) && (
                  <div style={{ color: "#64748b", fontSize: 12 }}>
                    {[
                      r.underlyingPrice != null ? `Stock $${r.underlyingPrice.toFixed(2)}` : null,
                      r.atmExpiration ? `ATM exp ${fmtDate(r.atmExpiration)} · ${r.atmDte ?? "—"}d` : null,
                    ].filter(Boolean).join(" · ")}
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 14 }}>
                  {[
                    { label: "ATM IV (~30d)", val: volPct(r.atmIv30), color: "#a855f7" },
                    { label: "RV 20d", val: volPct(r.rv20), color: "#3b82f6" },
                    { label: "IV − RV", val: volPoints(r.ivRvSpread), color: spreadColor(r.ivRvSpread) },
                  ].map(({ label, val, color }) => (
                    <div key={label} title={volDefinition(label)}>
                      <div style={{ color: "#475569", marginBottom: 2, fontSize: 12 }}>{label}</div>
                      <div style={{ color, fontWeight: 700, fontFamily: "monospace" }}>{val}</div>
                    </div>
                  ))}
                </div>
                <div title={volDefinition("RV 10d")} style={{ color: "#64748b", fontSize: 12 }}>RV 10d {volPct(r.rv10)} — last 10 sessions</div>
                <div title={volDefinition("Term")} style={{ fontSize: 13, color: "#cbd5e1" }}>
                  <span style={{ color: "#475569" }}>Term </span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{volPoints(r.termSlope)}</span>
                  <div style={{ color: "#64748b", fontSize: 12 }}>
                    {r.frontDte != null && r.backDte != null
                      ? `${r.frontDte}d ${volPct(r.frontAtmIv)} → ${r.backDte}d ${volPct(r.backAtmIv)}`
                      : "Needs two expirations at least 7 days out."}
                  </div>
                </div>
                <div title={volDefinition("Skew")} style={{ fontSize: 13, color: "#cbd5e1" }}>
                  <span style={{ color: "#475569" }}>Skew </span>
                  <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{volPoints(r.skew)}</span>
                  <div style={{ color: "#64748b", fontSize: 12 }}>
                    {r.skewPutStrike != null && r.skewCallStrike != null
                      ? `${r.skewPutStrike}P ${volPct(r.skewPutIv)} vs ${r.skewCallStrike}C ${volPct(r.skewCallIv)}${skewHow ? ` · ${skewHow}` : ""}`
                      : "Not enough strikes to compare put and call IV."}
                  </div>
                </div>
                {r.status === "ok" && (
                  <div title={volDefinition("Cheap / rich strikes")}>
                    <div style={{ color: "#475569", fontSize: 12, marginBottom: 4 }}>Cheap / rich strikes</div>
                    {r.notable.length === 0 && (
                      <div style={{ color: "#64748b", fontSize: 12 }}>None far from this expiration&apos;s ATM IV.</div>
                    )}
                    {r.notable.map((item) => (
                      <div key={`${item.expiration}-${item.strike}-${item.putCall}`} style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: 13, fontFamily: "monospace", color: "#cbd5e1" }}>
                        <span>{item.strike}{item.putCall === "call" ? "C" : "P"}</span>
                        <span>{item.ivPercent.toFixed(1)}%</span>
                        <span style={{ color: item.label === "CHEAP" ? "#10b981" : "#ef4444" }}>{item.label} {item.versusAtm > 0 ? "+" : ""}{item.versusAtm.toFixed(1)}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ color: "#64748b", fontSize: 13, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 8 }}>{r.signalNote}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ACCOUNT
// ═══════════════════════════════════════════════════════════════════════════
interface Position { symbol?: string; quantity?: number; "close-price"?: string; "average-open-price"?: string; "unrealized-day-gain-loss"?: string; }

function AccountTab() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [balances,  setBalances]  = useState<any>(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [pos, bal] = await Promise.all([tt({ action: "positions" }), tt({ action: "balances" })]);
      setPositions(Array.isArray(pos) ? pos : pos?.items ?? []);
      setBalances(bal);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const fmtBal = (v: unknown) => {
    const n = safeNum(v, NaN);
    return isNaN(n) ? "—" : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div>
      {loading && <Spinner />}
      {error   && <ErrorBox message={error} onRetry={load} />}
      {!loading && !error && (
        <>
          <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
            {[
              { label: "NET LIQ",      value: fmtBal(balances?.["net-liquidating-value"]   ?? balances?.net_liq),      color: "#10b981" },
              { label: "BUYING POWER", value: fmtBal(balances?.["derivative-buying-power"] ?? balances?.buying_power), color: "#06b6d4" },
              { label: "CASH",         value: fmtBal(balances?.["cash-balance"]             ?? balances?.cash),         color: "#e2e8f0" },
            ].map(({ label, value, color }) => (
              <div key={label} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "14px 22px" }}>
                <div style={{ color: "#475569", fontSize: 11, letterSpacing: "0.08em", marginBottom: 5 }}>{label}</div>
                <div style={{ color, fontSize: 22, fontWeight: 700, fontFamily: "monospace" }}>{value}</div>
              </div>
            ))}
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid rgba(255,255,255,0.1)" }}>
                {["Symbol","Qty","Avg Open","Last","Unrealized P&L"].map((h) => (
                  <th key={h} style={TH}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 && <tr><td colSpan={5} style={{ ...TD, textAlign: "center", color: "#475569" }}>No open positions.</td></tr>}
              {positions.map((p, i) => {
                const pnl = safeNum(p["unrealized-day-gain-loss"], 0);
                return (
                  <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    <td style={{ ...TD_MONO, fontWeight: 700, color: "#e2e8f0" }}>{p.symbol}</td>
                    <td style={{ ...TD_MONO, color: "#94a3b8" }}>{p.quantity}</td>
                    <td style={{ ...TD_MONO, color: "#94a3b8" }}>{p["average-open-price"] ? `$${p["average-open-price"]}` : "—"}</td>
                    <td style={{ ...TD_MONO, color: "#e2e8f0" }}>{p["close-price"] ? `$${p["close-price"]}` : "—"}</td>
                    <td style={TD_MONO}>
                      <span style={{ color: pnl >= 0 ? "#10b981" : "#ef4444", fontWeight: 600 }}>{pnl >= 0 ? "+" : ""}{fmt(pnl, 2)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// KELLY LAB
// ═══════════════════════════════════════════════════════════════════════════
function KellyTab() {
  const [winPct,   setWinPct]   = useState(50);
  const [winMult,  setWinMult]  = useState(2.0);
  const [lossMult, setLossMult] = useState(1.0);
  const [bankroll, setBankroll] = useState(ACCOUNT_SIZE_DOLLARS);

  const p     = winPct / 100;
  const q     = 1 - p;
  const b     = lossMult > 0 ? winMult / lossMult : 0;
  const kelly = b > 0 ? Math.max(0, (b * p - q) / b) : 0;
  const half  = kelly / 2;
  const trade = bankroll * half;

  const points = Array.from({ length: 20 }, (_, i) => {
    const f   = Math.min(i / 19, 0.999);
    const raw = b > 0 ? p * Math.log(1 + b * f) + q * Math.log(1 - f) : 0;
    return { g: isFinite(raw) ? raw * 100 : 0 };
  });
  const gs   = points.map((pt) => pt.g);
  const maxG = Math.max(...gs);
  const minG = Math.min(...gs);
  const rng  = maxG - minG || 1;

  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.3)", borderRadius: 8, padding: "12px 14px", marginBottom: 16, color: "#fbbf24", fontSize: 14, lineHeight: 1.5 }}>
        Retired as the sizing model. This lab used to assume a $5,000 account and a 55% win rate. Those assumptions are not used. The account is ${ACCOUNT_SIZE_DOLLARS.toLocaleString()}, and the Gate caps a trade at ${MAX_LOSS_DOLLARS}. The sliders below are only an illustration.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        {([
          { label: "Win Rate (%)",        value: winPct,   set: setWinPct,   min: 1,   max: 99,      step: 1   },
          { label: "Win Multiplier (×)",  value: winMult,  set: setWinMult,  min: 0.1, max: 10,      step: 0.1 },
          { label: "Loss Multiplier (×)", value: lossMult, set: setLossMult, min: 0.1, max: 10,      step: 0.1 },
          { label: "Bankroll ($)",        value: bankroll, set: setBankroll, min: 100, max: 1000000, step: 100 },
        ] as const).map(({ label, value, set, min, max, step }) => (
          <div key={label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#64748b", marginBottom: 4 }}>
              <span>{label}</span>
              <span style={{ color: "#e2e8f0", fontFamily: "monospace", fontWeight: 600 }}>{value}</span>
            </div>
            <input type="range" min={min} max={max} step={step} value={value}
              onChange={(e) => (set as any)(parseFloat(e.target.value))}
              style={{ width: "100%", accentColor: "#06b6d4" }} />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        {[
          { label: "FULL KELLY",            value: `${fmt(kelly * 100, 1)}%`, color: "#ef4444" },
          { label: "HALF KELLY (use this)", value: `${fmt(half  * 100, 1)}%`, color: "#10b981" },
          { label: "TRADE SIZE",            value: `$${fmt(trade, 0)}`,        color: "#f59e0b" },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "12px 20px" }}>
            <div style={{ color: "#475569", fontSize: 11, letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>
            <div style={{ color, fontSize: 24, fontWeight: 700, fontFamily: "monospace" }}>{value}</div>
          </div>
        ))}
      </div>
      <div style={{ position: "relative", height: 140, background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "12px 16px" }}>
        <div style={{ position: "absolute", top: 8, left: 12, fontSize: 11, color: "#475569" }}>Expected log-growth rate vs bet fraction</div>
        <svg viewBox="0 0 400 100" style={{ width: "100%", height: "100%" }} preserveAspectRatio="none">
          <polyline fill="none" stroke="#06b6d4" strokeWidth="2"
            points={points.map((pt, i) => {
              const x = (i / (points.length - 1)) * 400;
              const y = 90 - ((pt.g - minG) / rng) * 80;
              return `${x},${isFinite(y) ? y : 50}`;
            }).join(" ")}
          />
          {(() => {
            const idx = Math.min(Math.round(half * (points.length - 1)), points.length - 1);
            const x   = (idx / (points.length - 1)) * 400;
            return <line x1={x} y1={0} x2={x} y2={100} stroke="#10b981" strokeWidth="1.5" strokeDasharray="3,2" />;
          })()}
        </svg>
        <div style={{ position: "absolute", bottom: 8, right: 16, fontSize: 10, color: "#475569" }}>← 0%  bet fraction  100% →</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ALERTS
// ═══════════════════════════════════════════════════════════════════════════
function AlertsTab() {
  const [testing,    setTesting]    = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  const testAlert = async () => {
    setTesting(true); setTestResult(null);
    try {
      const res = await fetch("/api/alerts?action=test");
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || "Test failed");
      setTestResult(json.message || (json.success ? "Test alert sent." : "Telegram did not accept the alert."));
    } catch (e: any) {
      setTestResult(`❌ ${e.message}`);
    } finally {
      setTesting(false);
    }
  };

  const ENV_VARS = [
    { name: "APP_PASSWORD",             note: "App sign-in" },
    { name: "SESSION_SECRET",           note: "Signs the session cookie" },
    { name: "CRON_SECRET",              note: "Bearer header only — never in a URL" },
    { name: "TASTYTRADE_CLIENT_SECRET", note: "OAuth, read-only scope" },
    { name: "TASTYTRADE_REFRESH_TOKEN", note: "OAuth refresh token" },
    { name: "XAI_API_KEY",              note: "Grok API key" },
    { name: "TELEGRAM_BOT_TOKEN",       note: "From @BotFather" },
    { name: "TELEGRAM_CHAT_ID",         note: "Your chat ID" },
    { name: "FLOW_WATCHLIST",           note: "Optional ticker list for the flow scan" },
    { name: "ALERT_MAX_PER_DAY",        note: "Optional · A/B alerts per day, default 5" },
    { name: "SCHWAB_CLIENT_ID",         note: "Sensitive · Market Data app key" },
    { name: "SCHWAB_CLIENT_SECRET",     note: "Sensitive · Market Data secret" },
    { name: "SCHWAB_REDIRECT_URI",      note: "Sensitive · must match the callback URL" },
    { name: "KV_REST_API_URL",          note: "Sensitive · token store, or Upstash or Blob" },
    { name: "KV_REST_API_TOKEN",        note: "Sensitive · token store" },
    { name: "BLOB_READ_WRITE_TOKEN",    note: "Sensitive · private Blob token store" },
  ];

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>🔔 Automated Alert System</div>
      <div style={{ fontSize: 14, color: "#64748b", marginBottom: 24 }}>
        Scheduled scan every 15 min, weekdays, 8:30am–3:00pm Central. Vercel fires 13:30–21:00 UTC so both CST and CDT are covered. Grok screens for red flags before a Telegram alert is sent.
      </div>

      {/* How it works */}
      <div style={{ background: "rgba(6,182,212,0.06)", border: "1px solid rgba(6,182,212,0.15)", borderRadius: 8, padding: "14px 18px", marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#06b6d4", marginBottom: 10 }}>How it works</div>
        {[
          "Every 15 min on weekdays, from 8:30am to 3:00pm Central, the scanner reads Schwab chains for the watchlist. Outside that window it exits.",
          "Considers contracts that pass the gate liquidity filters: open interest at least 500, volume at least 100, and spread at most 5% of mid. Estimated flow premium (volume × mid × 100) still has to clear ALERT_MIN_PREMIUM, which defaults to $50,000. Illiquid contracts never grade A or B.",
          "Side is estimated from the last price versus the bid and ask. This is not a sweep. Flow premium is that volume estimate, not an exchange-reported sweep.",
          "Grades every candidate. Only a TAKE graded A or B can alert. An A needs at least $100,000 of flow premium and a B needs at least $50,000. The ask has to be at least $0.50, and one contract can cost up to $875. Expiration is about 2 to 6 weeks out (14 to 42 days). C and D stay on the Flow tab.",
          "Sends at most 5 Telegram alerts per Chicago day unless ALERT_MAX_PER_DAY says otherwise. An A goes out before a B. The same ticker, call or put, and expiration is not sent again that day.",
          "Cross-checks the ticker's vol arb signal and asks Grok to screen for red flags (earnings, FDA, news) before that send.",
          "The message includes the checklist grade and the exit defaults. Two losing closes in a row turn TAKE into STOP for today, and that STOP is not sent.",
          "The same cron later re-quotes the mid at about 15 minutes, 1 hour, and the close. Alert Report compares those mids. That is an estimate, not a fill.",
        ].map((step, i) => (
          <div key={i} style={{ display: "flex", gap: 10, marginBottom: 6, fontSize: 14, color: "#94a3b8" }}>
            <span style={{ color: "#06b6d4", fontWeight: 700, minWidth: 20 }}>{i + 1}.</span>
            <span>{step}</span>
          </div>
        ))}
      </div>

      {/* Required env vars */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#e2e8f0", marginBottom: 10 }}>
          Required Vercel Environment Variables
        </div>
        <div style={{ fontSize: 13, color: "#475569", marginBottom: 10 }}>
          Vercel dashboard → your project → Settings → Environment Variables
        </div>
        {ENV_VARS.map((v) => (
          <div key={v.name} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)", borderRadius: 6, marginBottom: 6 }}>
            <span style={{ fontFamily: "monospace", fontSize: 13, color: "#e2e8f0" }}>{v.name}</span>
            <span style={{ fontSize: 12, color: v.note.includes("✓") ? "#10b981" : "#f59e0b" }}>{v.note}</span>
          </div>
        ))}
      </div>

      {/* vercel.json reminder */}
      <div style={{ background: "rgba(168,85,247,0.06)", border: "1px solid rgba(168,85,247,0.2)", borderRadius: 8, padding: "12px 16px", marginBottom: 20, fontSize: 13, color: "#c4b5fd" }}>
        <span style={{ fontWeight: 700 }}>Also deploy:</span> add <code style={{ background: "rgba(255,255,255,0.08)", padding: "1px 5px", borderRadius: 3 }}>vercel.json</code> to root of your repo to activate the cron schedule.
      </div>

      {/* Test button */}
      <button onClick={testAlert} disabled={testing}
        style={{ ...BTN("cyan"), opacity: testing ? 0.5 : 1, marginBottom: 16 }}>
        {testing ? "Sending…" : "Send test Telegram alert"}
      </button>

      {testResult && (
        <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "12px 16px", fontSize: 13, color: "#94a3b8", whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
          {testResult}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// RESEARCH TAB  — Grok-powered chat with live scanner context
// Requires XAI_API_KEY in Vercel environment variables (Sensitive)
// ═══════════════════════════════════════════════════════════════════════════
interface ChatMessage { role: "user" | "assistant"; content: string; }

function ResearchTab() {
  const [messages,   setMessages]   = useState<ChatMessage[]>([]);
  const [input,      setInput]      = useState("");
  const [loading,    setLoading]    = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  // Live scanner context loaded on mount
  const [volRows,    setVolRows]    = useState<any[]>([]);
  const [flows,      setFlows]      = useState<any[]>([]);
  const [ctxLoaded,  setCtxLoaded]  = useState(false);
  const bottomRef = React.useRef<HTMLDivElement>(null);

  // ── Load live context once on mount ───────────────────────────────────
  useEffect(() => {
    (async () => {
      try {
        const [flowData, ...volData] = await Promise.allSettled([
          fetch("/api/flow?limit=20&minPremium=50000").then(async (res) => {
            const json = await res.json();
            if (!res.ok || json.connected === false) return [];
            return json.data ?? [];
          }),
          ...["SPY","QQQ","AAPL","MSFT","NVDA","TSLA"].map((t) =>
            tt({ action: "volatility", symbol: t })
              .then((d: any) => ({
                ticker: t,
                iv:     safeNum(d["implied-volatility-30-day"], 0),
                hv:     safeNum(d["historical-volatility-30-day"], 0),
                ivRank: safeNum(d["implied-volatility-index-rank"], 0.5) * 100,
                spread: safeNum(d["iv-hv-30-day-difference"], 0),
              }))
              .catch(() => null)
          ),
        ]);
        if (flowData.status === "fulfilled") setFlows(flowData.value ?? []);
        setVolRows(volData.filter((r) => r.status === "fulfilled" && (r as any).value).map((r) => (r as any).value));
      } catch { /* silent */ }
      finally { setCtxLoaded(true); }
    })();
  }, []);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const send = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setError(null);

    const newMessages: ChatMessage[] = [...messages, { role: "user", content: text }];
    setMessages(newMessages);
    setLoading(true);

    try {
      const res = await fetch("/api/research", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Only send last 10 messages to keep token usage reasonable
          messages: newMessages.slice(-10),
          // Inject live scanner context only on first message
          context: messages.length === 0 ? { flows, volRows } : undefined,
        }),
      });
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setMessages([...newMessages, { role: "assistant", content: json.text }]);
    } catch (e: any) {
      setError(e.message);
      // Remove the user message we just added if the call failed
      setMessages(messages);
    } finally {
      setLoading(false);
    }
  };

  const SUGGESTIONS = [
    "What's the most notable flow in the scanner right now?",
    "Which watchlist ticker has the best options buying setup?",
    "Explain the vol arb signals I'm seeing today",
    "How should I read estimated flow from volume and open interest?",
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 180px)", maxWidth: 860 }}>

      {/* Context badge */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.25)", color: "#a855f7", padding: "3px 10px", borderRadius: 4, fontSize: 12, fontWeight: 700 }}>
          ◆ Grok {ctxLoaded ? "3 fast" : "loading…"}
        </span>
        {ctxLoaded && (
          <>
            <span style={{ background: "rgba(6,182,212,0.08)", border: "1px solid rgba(6,182,212,0.2)", color: "#06b6d4", padding: "3px 10px", borderRadius: 4, fontSize: 12 }}>
              {flows.length} estimated flow rows loaded
            </span>
            <span style={{ background: "rgba(16,185,129,0.08)", border: "1px solid rgba(16,185,129,0.2)", color: "#10b981", padding: "3px 10px", borderRadius: 4, fontSize: 12 }}>
              {volRows.length} vol arb rows loaded
            </span>
          </>
        )}
      </div>

      {/* Chat history */}
      <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column", gap: 16, paddingBottom: 8 }}>

        {/* Empty state with suggestions */}
        {messages.length === 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: "24px 0" }}>
            <div style={{ fontSize: 15, color: "#475569", marginBottom: 4 }}>Ask anything about your scanner data or options concepts:</div>
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => { setInput(s); }}
                style={{ textAlign: "left", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "10px 14px", color: "#94a3b8", fontSize: 14, cursor: "pointer" }}>
                {s}
              </button>
            ))}
          </div>
        )}

        {messages.map((m, i) => (
          <div key={i} style={{
            display: "flex",
            justifyContent: m.role === "user" ? "flex-end" : "flex-start",
          }}>
            <div style={{
              maxWidth: "82%",
              background: m.role === "user"
                ? "rgba(6,182,212,0.12)"
                : "rgba(255,255,255,0.04)",
              border: `1px solid ${m.role === "user" ? "rgba(6,182,212,0.25)" : "rgba(255,255,255,0.08)"}`,
              borderRadius: m.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
              padding: "12px 16px",
              fontSize: 15,
              color: m.role === "user" ? "#e2e8f0" : "#cbd5e1",
              whiteSpace: "pre-wrap",
              lineHeight: 1.6,
            }}>
              {m.content}
            </div>
          </div>
        ))}

        {loading && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: "16px 16px 16px 4px", padding: "12px 18px" }}>
              <div style={{ display: "flex", gap: 5, alignItems: "center" }}>
                {[0, 1, 2].map((i) => (
                  <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#a855f7", animation: `oes-pulse 1.2s ease-in-out ${i * 0.2}s infinite` }} />
                ))}
              </div>
            </div>
          </div>
        )}

        {error && <ErrorBox message={error} />}

        <div ref={bottomRef} />
      </div>

      {/* Input row */}
      <div style={{ display: "flex", gap: 8, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
          placeholder="Ask about flow, vol arb signals, a ticker… (Enter to send, Shift+Enter for newline)"
          rows={2}
          style={{ ...INPUT, flex: 1, resize: "none", lineHeight: 1.5 }}
        />
        <button onClick={send} disabled={loading || !input.trim()}
          style={{ ...BTN("cyan"), alignSelf: "stretch", padding: "0 20px", opacity: loading || !input.trim() ? 0.4 : 1 }}>
          ↑ Send
        </button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ALERT REPORT
// ═══════════════════════════════════════════════════════════════════════════
interface AlertReportPayload {
  alerts: StoredAlert[];
  summary: AlertSummary;
  notes: { sample: string; outcome: string; checklist: string };
}

function checkpointLabel(point: StoredAlert["checkpoints"]["m15"]): string {
  if (point.status === "quoted") return pctText(point.midChangePct);
  if (point.status === "no_quote") return "no quote";
  if (point.status === "expired") return "expired";
  if (point.status === "missed") return "missed";
  return "pending";
}

function checkpointTitle(point: StoredAlert["checkpoints"]["m15"]): string {
  const mid = point.mid == null ? "—" : point.mid.toFixed(2);
  const underlying = point.underlying == null ? "—" : point.underlying.toFixed(2);
  return `mid ${mid} · underlying ${underlying} · ${point.status}`;
}

function AlertReportTab() {
  const [report, setReport] = useState<AlertReportPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/alert-report");
      const json = await res.json();
      if (!res.ok || json.error) throw new Error(json.error || "Alert report failed");
      setReport(json as AlertReportPayload);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Alert report failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const summary = report?.summary;

  return (
    <div>
      <div style={{ fontSize: 17, fontWeight: 700, color: "#e2e8f0", marginBottom: 6 }}>Alert Report</div>
      <div style={{ fontSize: 14, color: "#94a3b8", lineHeight: 1.5, marginBottom: 8, maxWidth: 760 }}>
        Each saved alert is an A or a B from the moment Telegram accepted it. C and D are not stored. Later rows are a midpoint check at about 15 minutes, 1 hour, and the same-day close.
      </div>
      {report && (
        <div style={{ fontSize: 13, color: "#64748b", lineHeight: 1.5, marginBottom: 16, maxWidth: 760 }}>
          <div>{report.notes.checklist}</div>
          <div>{report.notes.outcome}</div>
          <div>{report.notes.sample}</div>
        </div>
      )}

      {loading && <Spinner />}
      {error && <ErrorBox message={error} onRetry={load} />}

      {!loading && !error && summary && (
        <>
          <div style={{ display: "flex", gap: 12, marginBottom: 18, flexWrap: "wrap" }}>
            {[
              { label: "HIT RATE", value: hitText(summary.hitRate, summary.wins, summary.graded), color: "#10b981" },
              { label: "AVG MOVE AT 1 HOUR", value: pctText(summary.avgHourPct), color: "#06b6d4" },
              { label: "AVG MOVE AT CLOSE", value: pctText(summary.avgClosePct), color: "#f59e0b" },
              { label: "GRADED / SAVED", value: `${summary.graded} / ${summary.total}`, color: "#e2e8f0" },
            ].map((card) => (
              <div key={card.label} style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8, padding: "12px 18px", minWidth: 150 }}>
                <div style={{ color: "#475569", fontSize: 11, letterSpacing: "0.06em", marginBottom: 4 }}>{card.label}</div>
                <div style={{ color: card.color, fontSize: 22, fontWeight: 700, fontFamily: "monospace" }}>{card.value}</div>
              </div>
            ))}
          </div>

          <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
            Hit rate is wins divided by graded alerts. Graded means win, miss, or flat. Pending and unscored alerts stay out of the rate. A win is the option mid up 20% or more at any checkpoint. A miss is the close mid down 20% or more with no earlier win. Anything else with a close mid is flat.
          </div>

          <ReportTable
            title="Checklist grade, then what the mid did"
            headers={["Verdict", "Saved", "Graded", "Hit rate", "Avg close mid"]}
            rows={summary.byVerdict.filter((row) => row.count > 0).map((row) => [
              row.verdict === "STOP" ? "STOP for today" : row.verdict,
              String(row.count),
              String(row.graded),
              hitText(row.hitRate, row.wins, row.graded),
              pctText(row.avgClosePct),
            ])}
          />
          <ReportTable
            title="By ticker"
            headers={["Ticker", "Saved", "Graded", "Hit rate", "Avg 1 hour", "Avg close"]}
            rows={summary.byTicker.map((row) => [
              row.label,
              String(row.count),
              String(row.graded),
              hitText(row.hitRate, row.wins, row.graded),
              pctText(row.avgHourPct),
              pctText(row.avgClosePct),
            ])}
          />
          <ReportTable
            title="Gate liquidity"
            headers={["Liquidity", "Saved", "Graded", "Hit rate", "Avg 1 hour", "Avg close"]}
            rows={summary.byLiquidity.map((row) => [
              row.label,
              String(row.count),
              String(row.graded),
              hitText(row.hitRate, row.wins, row.graded),
              pctText(row.avgHourPct),
              pctText(row.avgClosePct),
            ])}
          />

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ borderBottom: "2px solid rgba(255,255,255,0.1)" }}>
                  {["Sent", "Contract", "Checklist", "15 min", "1 hour", "Close", "Outcome"].map((header) => (
                    <th key={header} style={TH}>{header}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.alerts.length === 0 && (
                  <tr>
                    <td colSpan={7} style={{ ...TD, textAlign: "center", color: "#475569" }}>
                      No alerts saved yet. The cron stores one when Telegram accepts an A or a B.
                    </td>
                  </tr>
                )}
                {report.alerts.map((alert) => (
                  <tr key={alert.id} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", verticalAlign: "top" }}>
                    <td style={{ ...TD, color: "#94a3b8", whiteSpace: "nowrap" }}>
                      {new Date(alert.sentAt).toLocaleString("en-US", {
                        timeZone: "America/Chicago",
                        month: "short",
                        day: "numeric",
                        hour: "numeric",
                        minute: "2-digit",
                      })}
                    </td>
                    <td style={TD_MONO}>
                      <div style={{ color: "#e2e8f0", fontWeight: 700 }}>{alert.ticker} {alert.putCall.toUpperCase()}</div>
                      <div style={{ color: "#94a3b8" }}>${alert.strike} · {alert.expiration}</div>
                      <div style={{ color: "#64748b", fontSize: 12 }}>
                        {formatContractPriceLine(alert.ask)}
                      </div>
                      <div style={{ color: "#64748b", fontSize: 12 }}>
                        flow premium {formatFlowPremium(notionalPremium(alert.volume, alert.mid))}
                      </div>
                      <div style={{ color: "#64748b", fontSize: 12 }}>
                        mid {alert.mid == null ? "—" : alert.mid.toFixed(2)} · underlying {alert.underlyingPrice == null ? "—" : alert.underlyingPrice.toFixed(2)}
                      </div>
                    </td>
                    <td style={{ ...TD, minWidth: 220 }}>
                      <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                        <Badge color={verdictColor(alert.verdict)}>{alert.verdictLabel}</Badge>
                        <span style={{ fontFamily: "monospace", fontWeight: 800 }}>{alert.grade}</span>
                      </div>
                      <ul style={{ margin: 0, paddingLeft: 16, color: "#94a3b8", fontSize: 12, lineHeight: 1.4 }}>
                        {alert.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                      </ul>
                      {alert.levels && (
                        <div style={{ color: "#cbd5e1", fontSize: 12, marginTop: 4 }}>{formatLevelsSummary(alert.levels)}</div>
                      )}
                      {alert.levelsNote && (
                        <div style={{ color: "#64748b", fontSize: 12, marginTop: 4 }}>{alert.levelsNote}</div>
                      )}
                      {alert.eventLine && (
                        <div style={{ color: "#fbbf24", fontSize: 12, marginTop: 4 }}>{alert.eventLine}</div>
                      )}
                      <ExitLines ask={alert.ask} maxContracts={alert.maxContracts} />
                    </td>
                    {(["m15", "h1", "close"] as const).map((name) => (
                      <td key={name} style={{ ...TD_MONO, color: "#e2e8f0" }} title={checkpointTitle(alert.checkpoints[name])}>
                        {checkpointLabel(alert.checkpoints[name])}
                      </td>
                    ))}
                    <td style={{ ...TD_MONO, color: outcomeColor(alert.outcome), fontWeight: 700 }}>{alert.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function ReportTable({ title, headers, rows }: { title: string; headers: string[]; rows: string[][] }) {
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 700, color: "#94a3b8", marginBottom: 8 }}>{title}</div>
      <table style={{ width: "100%", borderCollapse: "collapse", maxWidth: 720 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
            {headers.map((header) => <th key={header} style={TH}>{header}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.join("|")} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
              {row.map((cell, index) => (
                <td key={`${cell}-${index}`} style={index === 0 ? TD : TD_MONO}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════════════
const TABS = [
  { id: "flow",     label: "⊕ Flow Scanner" },
  { id: "volArb",   label: "◇ Vol Arb"      },
  { id: "account",  label: "⊞ Account"      },
  { id: "kelly",    label: "△ Kelly (retired)" },
  { id: "research", label: "◆ Research"      },
  { id: "alerts",   label: "⏰ Alerts"       },
  { id: "report",   label: "▣ Alert Report" },
];

export default function OptionsEdgeScanner() {
  const [tab, setTab] = useState("flow");
  return (
    <div style={{ minHeight: "100vh", background: "#0b0f1a", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif", fontSize: 16 }}>
      <style>{`
        @keyframes oes-spin  { to { transform: rotate(360deg); } }
        @keyframes oes-pulse { 0%,100%{opacity:1} 50%{opacity:.35} }
        * { box-sizing: border-box; }
      `}</style>

      {/* Header */}
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px 0" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", fontFamily: "monospace" }}>
              <span style={{ color: "#06b6d4" }}>◆</span> OPTIONS EDGE SCANNER
            </h1>
            <p style={{ margin: "3px 0 0", color: "#475569", fontSize: 14 }}>
              Estimated flow · Verdict · Alert Report · Trade Gate · Trade log
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ background: "rgba(16,185,129,0.12)", color: "#10b981", border: "1px solid rgba(16,185,129,0.25)", padding: "3px 10px", borderRadius: 4, fontSize: 12, fontWeight: 700 }}>READ ONLY</span>
            <button
              type="button"
              onClick={async () => {
                await fetch("/api/auth/logout", { method: "POST" });
                window.location.href = "/login";
              }}
              style={{ background: "transparent", color: "#64748b", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 4, padding: "3px 10px", fontSize: 12, cursor: "pointer" }}
            >Log out</button>
          </div>
        </div>
        <div style={{ display: "flex", overflowX: "auto", padding: "0 24px" }}>
          <a href="/trades" style={{
            padding: "12px 18px", fontSize: 14, fontWeight: 600,
            color: "#475569", letterSpacing: "0.03em", whiteSpace: "nowrap", textDecoration: "none",
          }}>▣ Trades</a>
          <a href="/gate" style={{
            padding: "12px 18px", fontSize: 14, fontWeight: 600,
            color: "#475569", letterSpacing: "0.03em", whiteSpace: "nowrap", textDecoration: "none",
          }}>▣ Gate</a>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "12px 18px", fontSize: 14, fontWeight: 600, cursor: "pointer",
              background: "transparent", border: "none",
              borderBottom: tab === t.id ? "2px solid #06b6d4" : "2px solid transparent",
              color: tab === t.id ? "#06b6d4" : "#475569",
              letterSpacing: "0.03em", whiteSpace: "nowrap", transition: "color 0.15s",
            }}>{t.label}</button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div style={{ padding: 24 }}>
        <SchwabBanner />
        {tab === "flow"     && <FlowTab     />}
        {tab === "volArb"   && <VolArbTab   />}
        {tab === "account"  && <AccountTab  />}
        {tab === "kelly"    && <KellyTab    />}
        {tab === "research" && <ResearchTab />}
        {tab === "alerts"   && <AlertsTab   />}
        {tab === "report"   && <AlertReportTab />}
      </div>

      <div style={{ padding: "12px 24px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between", color: "#334155", fontSize: 12 }}>
        <span>Options Edge Scanner · Not financial advice · Read-only · never places orders</span>
        <span>Schwab market data · Tastytrade</span>
      </div>
    </div>
  );
}
