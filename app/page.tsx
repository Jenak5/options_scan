"use client";

import React, { useState, useEffect, useCallback } from "react";

// ─── API helpers ───────────────────────────────────────────────────────────
async function fetchApi(base: string, params: Record<string, string>) {
  const url = new URL(base, window.location.origin);
  Object.entries(params).forEach(([k, v]) => { if (v) url.searchParams.set(k, v); });
  const res = await fetch(url.toString());
  const json = await res.json();
  if (json.error) throw new Error(json.error);
  return json.data;
}
const tt = (p: Record<string, string>) => fetchApi("/api/tastytrade",    p);
const uw = (p: Record<string, string>) => fetchApi("/api/unusualwhales", p);

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

// ─── Side badge ────────────────────────────────────────────────────────────
function SideBadge({ ratio }: { ratio: number | null }) {
  if (ratio === null) return <Badge color="gray">—</Badge>;
  if (ratio >= 0.65)  return <Badge color="green">AT ASK ▲</Badge>;
  if (ratio <= 0.35)  return <Badge color="red">AT BID ▼</Badge>;
  return <Badge color="amber">MID ↔</Badge>;
}

// ─── Opening / Closing badge ───────────────────────────────────────────────
function OpenCloseBadge({ allOpening, volOiRatio }: { allOpening?: boolean | null; volOiRatio?: number | null }) {
  if (allOpening === true  || (volOiRatio != null && volOiRatio > 1))    return <Badge color="cyan">OPENING</Badge>;
  if (allOpening === false || (volOiRatio != null && volOiRatio <= 0.2)) return <Badge color="gray">CLOSING</Badge>;
  return null;
}

// ─── Premium breakdown bar ─────────────────────────────────────────────────
function PremiumBar({ askPrem, bidPrem, total }: { askPrem: number; bidPrem: number; total: number }) {
  const sum = askPrem + bidPrem;
  if (sum === 0) {
    return <span style={{ color: "#f59e0b", fontWeight: 600, fontFamily: "monospace", fontSize: 15 }}>{fmtPremium(total)}</span>;
  }
  const askPct = Math.round((askPrem / sum) * 100);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 90 }}>
      <span style={{ color: "#f59e0b", fontWeight: 600, fontFamily: "monospace", fontSize: 15 }}>{fmtPremium(total)}</span>
      <div style={{ display: "flex", height: 5, borderRadius: 2, overflow: "hidden", background: "rgba(255,255,255,0.06)" }}>
        <div style={{ width: `${askPct}%`, background: "#10b981" }} />
        <div style={{ width: `${100 - askPct}%`, background: "#ef4444" }} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b" }}>
        <span style={{ color: "#10b981" }}>Ask {fmtPremium(askPrem)}</span>
        <span style={{ color: "#ef4444" }}>Bid {fmtPremium(bidPrem)}</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// FLOW SCANNER
// ═══════════════════════════════════════════════════════════════════════════
interface FlowAlert {
  id?: string;
  ticker?: string;
  strike?: string | number;
  type?: string;
  put_call?: string;
  expiry?: string | null;
  total_premium?: string | number | null;
  total_ask_side_prem?: string | number | null;
  total_bid_side_prem?: string | number | null;
  all_opening_trades?: boolean | null;
  volume_oi_ratio?: string | number | null;
  total_size?: number | null;
  size?: number | null;
  open_interest?: number | null;
  iv_start?: string | number | null;
  iv?: string | number | null;
  has_sweep?: boolean;
  is_sweep?: boolean;
  is_golden_sweep?: boolean;
  alert_rule?: string;
}

function FlowTab() {
  const [flows, setFlows] = useState<FlowAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({ ticker: "", sweepsOnly: false, minPremium: "50000", otmOnly: false });

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const p: Record<string, string> = { action: "flow", limit: "60", min_premium: filters.minPremium };
      if (filters.ticker)     p.ticker   = filters.ticker;
      if (filters.sweepsOnly) p.is_sweep = "true";
      if (filters.otmOnly)    p.is_otm   = "true";
      setFlows(await uw(p));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      {/* Filters */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Ticker…" value={filters.ticker}
          onChange={(e) => setFilters({ ...filters, ticker: e.target.value.toUpperCase() })}
          style={{ ...INPUT, width: 110 }} />
        <select value={filters.minPremium} onChange={(e) => setFilters({ ...filters, minPremium: e.target.value })} style={{ ...INPUT, cursor: "pointer" }}>
          <option value="10000">$10K+ prem</option>
          <option value="50000">$50K+ prem</option>
          <option value="100000">$100K+ prem</option>
          <option value="500000">$500K+ prem</option>
          <option value="1000000">$1M+ prem</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 15, color: "#94a3b8", cursor: "pointer" }}>
          <input type="checkbox" checked={filters.sweepsOnly} onChange={(e) => setFilters({ ...filters, sweepsOnly: e.target.checked })} />
          Sweeps only
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 15, color: "#94a3b8", cursor: "pointer" }}>
          <input type="checkbox" checked={filters.otmOnly} onChange={(e) => setFilters({ ...filters, otmOnly: e.target.checked })} />
          OTM only
        </label>
        <button onClick={load} style={BTN("cyan")}>↻ Refresh</button>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 16, marginBottom: 12, padding: "8px 14px", background: "rgba(255,255,255,0.025)", borderRadius: 6, flexWrap: "wrap" }}>
        <span style={{ color: "#64748b", fontSize: 13, fontWeight: 700 }}>SIDE</span>
        <span style={{ color: "#10b981", fontSize: 13 }}>▲ AT ASK — buyer-initiated (bullish)</span>
        <span style={{ color: "#ef4444", fontSize: 13 }}>▼ AT BID — seller-initiated (bearish)</span>
        <span style={{ color: "#f59e0b", fontSize: 13 }}>↔ MID — split fills</span>
        <span style={{ color: "#64748b", fontSize: 13, fontWeight: 700, marginLeft: 8 }}>POSITION</span>
        <span style={{ color: "#06b6d4", fontSize: 13 }}>OPENING — new contracts</span>
        <span style={{ color: "#64748b", fontSize: 13 }}>CLOSING — exiting</span>
      </div>

      {loading && <Spinner />}
      {error   && <ErrorBox message={error} onRetry={load} />}

      {!loading && !error && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid rgba(255,255,255,0.1)" }}>
                {["Ticker","Type","Strike","Expiry","Premium / Split","Size","OI","Vol/OI","IV","Side","Position","Flags"].map((h) => (
                  <th key={h} style={TH}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {flows.length === 0 && (
                <tr><td colSpan={12} style={{ ...TD, textAlign: "center", color: "#475569" }}>No flow alerts match current filters.</td></tr>
              )}
              {flows.map((f, i) => {
                const premium  = safeNum(f.total_premium, 0);
                const typeStr  = (f.type ?? f.put_call ?? "").toLowerCase();
                const isCall   = typeStr === "call";
                const askPrem  = safeNum(f.total_ask_side_prem, 0);
                const bidPrem  = safeNum(f.total_bid_side_prem, 0);
                const premSum  = askPrem + bidPrem;
                const sideRatio: number | null = premSum > 0 ? askPrem / premSum : null;
                const iv       = safeNum(f.iv_start ?? f.iv, 0);
                const volOi    = f.volume_oi_ratio != null ? safeNum(f.volume_oi_ratio, 0) : null;
                const size     = f.total_size ?? f.size ?? null;
                const isSweep  = f.has_sweep || f.is_sweep || (f.alert_rule ?? "").toLowerCase().includes("sweep");
                const isGolden = f.is_golden_sweep;

                return (
                  <tr key={f.id ?? i} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                    <td style={{ ...TD_MONO, fontWeight: 700, color: "#e2e8f0" }}>{f.ticker}</td>
                    <td style={TD}><Badge color={isCall ? "green" : "red"}>{isCall ? "CALL" : "PUT"}</Badge></td>
                    <td style={{ ...TD_MONO, color: "#94a3b8" }}>{f.strike ? `$${f.strike}` : "—"}</td>
                    <td style={{ ...TD, color: "#94a3b8", whiteSpace: "nowrap" }}>{fmtDate(f.expiry)}</td>
                    <td style={TD}><PremiumBar total={premium} askPrem={askPrem} bidPrem={bidPrem} /></td>
                    <td style={{ ...TD_MONO, color: "#e2e8f0" }}>{size?.toLocaleString() ?? "—"}</td>
                    <td style={{ ...TD_MONO, color: "#64748b" }}>{f.open_interest?.toLocaleString() ?? "—"}</td>
                    <td style={TD_MONO}>
                      {volOi != null ? (
                        <span style={{ color: volOi > 1 ? "#06b6d4" : volOi < 0.2 ? "#64748b" : "#94a3b8" }}>{fmt(volOi, 2)}x</span>
                      ) : "—"}
                    </td>
                    <td style={TD}>
                      {iv > 0 ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                          <span style={{ color: "#a855f7", fontFamily: "monospace", fontSize: 15 }}>{fmt(iv * 100, 0)}%</span>
                          <div style={{ width: 44, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
                            <div style={{ width: `${Math.min(iv / 2 * 100, 100)}%`, height: "100%", background: "#a855f7" }} />
                          </div>
                        </div>
                      ) : "—"}
                    </td>
                    <td style={TD}><SideBadge ratio={sideRatio} /></td>
                    <td style={TD}><OpenCloseBadge allOpening={f.all_opening_trades} volOiRatio={volOi} /></td>
                    <td style={TD}>
                      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
                        {isGolden && <Badge color="amber">GOLDEN ★</Badge>}
                        {isSweep  && <Badge color="cyan">SWEEP</Badge>}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// DARK POOL
// ═══════════════════════════════════════════════════════════════════════════
interface DarkPrint { ticker?: string; price?: number | null; size?: number | null; notional?: number | null; date?: string | null; exchange?: string | null; premium?: number | null; }

function DarkPoolTab() {
  const [prints, setPrints] = useState<DarkPrint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [ticker,  setTicker]  = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const p: Record<string, string> = { action: "darkpool", limit: "50" };
      if (ticker) p.ticker = ticker;
      setPrints(await uw(p));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [ticker]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <input placeholder="Filter ticker…" value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} style={{ ...INPUT, width: 140 }} />
        <button onClick={load} style={BTN("cyan")}>↻ Refresh</button>
      </div>
      {loading && <Spinner />}
      {error   && <ErrorBox message={error} onRetry={load} />}
      {!loading && !error && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid rgba(255,255,255,0.1)" }}>
                {["Ticker","Price","Size","Notional","Exchange","Time"].map((h) => (
                  <th key={h} style={TH}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prints.length === 0 && <tr><td colSpan={6} style={{ ...TD, textAlign: "center", color: "#475569" }}>No dark pool prints found.</td></tr>}
              {prints.map((p, i) => (
                <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                  <td style={{ ...TD_MONO, fontWeight: 700, color: "#e2e8f0" }}>{p.ticker}</td>
                  <td style={{ ...TD_MONO, color: "#94a3b8" }}>{p.price != null ? `$${fmt(p.price, 2)}` : "—"}</td>
                  <td style={{ ...TD_MONO, color: "#e2e8f0" }}>{p.size?.toLocaleString() ?? "—"}</td>
                  <td style={{ ...TD, color: "#f59e0b", fontWeight: 600 }}>{fmtPremium(p.notional ?? p.premium)}</td>
                  <td style={{ ...TD, color: "#64748b" }}>{p.exchange ?? "OTC"}</td>
                  <td style={{ ...TD, color: "#64748b" }}>{fmtDate(p.date)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// VOL ARB
// ═══════════════════════════════════════════════════════════════════════════
interface VolRow { ticker: string; iv: number; hv: number; ivRank: number; spread: number; }

const DEFAULT_WATCHLIST = ["SPY","QQQ","AAPL","MSFT","NVDA","TSLA","AMZN","META","GOOGL","AMD","SMCI","COIN","MSTR","PLTR","ARM"];

function volSignal(ivRank: number, spread: number) {
  if (ivRank < 25 && spread < 10)  return { label: "BUY FRIENDLY", color: "green"  as BadgeColor, bc: "#10b981", tip: "Low IV Rank + tight spread — best risk/reward for long calls/puts." };
  if (ivRank < 25 && spread >= 10) return { label: "CAUTION",      color: "amber"  as BadgeColor, bc: "#f59e0b", tip: "IV Rank low but spread wide — cheap vs history, expensive vs moves." };
  if (spread < 0)                  return { label: "BUY VOL",      color: "cyan"   as BadgeColor, bc: "#06b6d4", tip: "Options underpriced vs realized vol — rare edge, act fast." };
  if (spread > 20)                 return { label: "EXPENSIVE",    color: "red"    as BadgeColor, bc: "#ef4444", tip: "High spread — overpaying for volatility. Skip or sell." };
  return                                  { label: "NEUTRAL",      color: "blue"   as BadgeColor, bc: "#3b82f6", tip: "No strong signal. Wait for flow confirmation before entering." };
}

function VolArbTab() {
  const [rows, setRows]           = useState<VolRow[]>([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);
  const [watchlist, setWatchlist] = useState<string[]>(DEFAULT_WATCHLIST);
  const [newTicker, setNewTicker] = useState("");

  const addTicker = () => {
    const t = newTicker.trim().toUpperCase();
    if (t && !watchlist.includes(t)) setWatchlist((prev) => [...prev, t]);
    setNewTicker("");
  };
  const removeTicker = (t: string) => setWatchlist((prev) => prev.filter((x) => x !== t));

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const results: VolRow[] = [];
      for (const ticker of watchlist) {
        try {
          const d = await tt({ action: "volatility", symbol: ticker });
          const iv = safeNum(d["implied-volatility-30-day"] ?? d["implied-volatility-index"], 0);
          const hv = safeNum(d["historical-volatility-30-day"] ?? d["historical-volatility-60-day"], 0);
          const ivRankRaw = safeNum(d["implied-volatility-index-rank"] ?? d["tw-implied-volatility-index-rank"] ?? d["iv-rank"], 0.5);
          const ivRank = ivRankRaw <= 1 ? ivRankRaw * 100 : ivRankRaw;
          const spread = safeNum(d["iv-hv-30-day-difference"] ?? 0, iv - hv);
          results.push({ ticker, iv, hv, ivRank, spread });
        } catch { /* skip */ }
      }
      results.sort((a, b) => a.ivRank - b.ivRank);
      setRows(results);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [watchlist]);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
          <input placeholder="Add ticker… (e.g. HOOD)" value={newTicker}
            onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
            onKeyDown={(e) => e.key === "Enter" && addTicker()}
            style={{ ...INPUT, width: 180 }} />
          <button onClick={addTicker} style={BTN("cyan")}>+ Add</button>
          <button onClick={load}      style={BTN("gray")}>↻ Refresh</button>
          <button onClick={() => setWatchlist(DEFAULT_WATCHLIST)} style={BTN("ghost")}>Reset</button>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {watchlist.map((t) => (
            <div key={t} style={{ display: "flex", alignItems: "center", gap: 4, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 20, padding: "4px 10px 4px 14px", fontSize: 14 }}>
              <span style={{ color: "#e2e8f0", fontFamily: "monospace", fontWeight: 600 }}>{t}</span>
              <button onClick={() => removeTicker(t)} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "0 0 0 4px" }}>×</button>
            </div>
          ))}
        </div>
      </div>
      <div style={{ background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.15)", borderRadius: 8, padding: "10px 16px", marginBottom: 16, fontSize: 14, color: "#6ee7b7" }}>
        ✓ Cash Account Mode — long calls &amp; puts only. Sorted by IV Rank (lowest = best buying opportunity first).
      </div>
      {loading && <Spinner />}
      {error   && <ErrorBox message={error} onRetry={load} />}
      {!loading && !error && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(215px, 1fr))", gap: 12 }}>
          {rows.map((r) => {
            const sig = volSignal(r.ivRank, r.spread);
            return (
              <div key={r.ticker} style={{ background: "rgba(255,255,255,0.035)", border: `2px solid ${sig.bc}44`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700, fontSize: 18, color: "#e2e8f0", fontFamily: "monospace" }}>{r.ticker}</span>
                  <Badge color={sig.color}>{sig.label}</Badge>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 14 }}>
                  {[
                    { label: "IV 30d", val: `${fmt(r.iv, 1)}%`,  color: "#a855f7" },
                    { label: "HV 30d", val: `${fmt(r.hv, 1)}%`,  color: "#3b82f6" },
                    { label: "Spread", val: `${r.spread > 0 ? "+" : ""}${fmt(r.spread, 1)}%`, color: r.spread < 0 ? "#10b981" : r.spread > 15 ? "#ef4444" : "#f59e0b" },
                  ].map(({ label, val, color }) => (
                    <div key={label}>
                      <div style={{ color: "#475569", marginBottom: 2 }}>{label}</div>
                      <div style={{ color, fontWeight: 700, fontFamily: "monospace" }}>{val}</div>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#475569", marginBottom: 3 }}>
                    <span>IV Rank</span><span>{fmt(r.ivRank, 0)}%</span>
                  </div>
                  <div style={{ height: 5, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{ width: `${Math.min(r.ivRank, 100)}%`, height: "100%", borderRadius: 3, background: r.ivRank < 25 ? "#10b981" : r.ivRank > 75 ? "#ef4444" : "#f59e0b" }} />
                  </div>
                </div>
                <div style={{ color: "#64748b", fontSize: 13, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 8 }}>{sig.tip}</div>
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
  const [winPct,   setWinPct]   = useState(55);
  const [winMult,  setWinMult]  = useState(2.0);
  const [lossMult, setLossMult] = useState(1.0);
  const [bankroll, setBankroll] = useState(5000);

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
// OPTION CHAIN  — powered by Unusual Whales
// ★ Confirmed field names from live API response:
//   option_symbol, volume, implied_volatility, open_interest,
//   last_price, nbbo_ask, nbbo_bid, avg_price,
//   ask_volume, bid_volume, mid_volume, sweep_volume, total_premium
// ★ Strike, expiry, and option type are ALL encoded in option_symbol (OCC format)
//   e.g. "SPY   260327C00660000"
//        └ticker┘└YYMMDD┘└C/P┘└strike×1000┘
// ═══════════════════════════════════════════════════════════════════════════
interface UWContract {
  option_symbol?:       string;
  implied_volatility?:  number | string;
  nbbo_bid?:            number | string;
  nbbo_ask?:            number | string;
  last_price?:          number | string;
  avg_price?:           number | string;
  volume?:              number | string;
  open_interest?:       number | string;
  prev_oi?:             number | string;
  total_premium?:       number | string;
  ask_volume?:          number | string;
  bid_volume?:          number | string;
  sweep_volume?:        number | string;
}

// ── OCC symbol parser ─────────────────────────────────────────────────────
// OCC format (padded): "SPY   260327C00660000"
// Compact format:      "SPY260327C00660000"
// Fields: ticker (1-6 chars) | YYMMDD | C/P | strike*1000 (8 digits)
interface ParsedOCC {
  expiry:    string;  // "2026-03-27"
  optType:   "C" | "P";
  strike:    number;  // 660.0
}

function parseOCC(sym: string): ParsedOCC | null {
  if (!sym) return null;
  const s = sym.replace(/\s+/g, ""); // strip padding spaces
  const m = s.match(/^[A-Z1-9]+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/i);
  if (!m) return null;
  const [, yy, mm, dd, cp, strikePad] = m;
  return {
    expiry:  `20${yy}-${mm}-${dd}`,
    optType: cp.toUpperCase() as "C" | "P",
    strike:  parseInt(strikePad, 10) / 1000,
  };
}

function extractExpiry(c: UWContract): string {
  return parseOCC(c.option_symbol ?? "")?.expiry ?? "";
}

interface ChainRow { strike: number; call: UWContract | null; put: UWContract | null; }

function buildChainRows(contracts: UWContract[]): ChainRow[] {
  const map = new Map<number, ChainRow>();
  for (const c of contracts) {
    const parsed = parseOCC(c.option_symbol ?? "");
    if (!parsed) continue;
    const { strike, optType } = parsed;
    if (!map.has(strike)) map.set(strike, { strike, call: null, put: null });
    const row = map.get(strike)!;
    if (optType === "C") row.call = c;
    else                 row.put  = c;
  }
  return Array.from(map.values()).sort((a, b) => a.strike - b.strike);
}

function fmtChainIV(c: UWContract | null): string {
  if (!c) return "—";
  const raw = safeNum(c.implied_volatility, NaN);
  if (isNaN(raw) || raw === 0) return "—";
  // UW returns IV as decimal (0–1) — multiply × 100 for display
  return `${(raw * 100).toFixed(0)}%`;
}
function fmtChainBid(c: UWContract | null): string {
  if (!c) return "—";
  const v = safeNum(c.nbbo_bid, NaN);
  return isNaN(v) ? "—" : `$${v.toFixed(2)}`;
}
function fmtChainAsk(c: UWContract | null): string {
  if (!c) return "—";
  const v = safeNum(c.nbbo_ask, NaN);
  return isNaN(v) ? "—" : `$${v.toFixed(2)}`;
}

function ChainTab() {
  const [ticker,       setTicker]       = useState("SPY");
  const [input,        setInput]        = useState("SPY");
  const [expiries,     setExpiries]     = useState<string[]>([]);
  const [selExp,       setSelExp]       = useState("");
  const [rows,         setRows]         = useState<ChainRow[]>([]);
  const [allContracts, setAllContracts] = useState<UWContract[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [error,        setError]        = useState<string | null>(null);

  // Fetch all contracts → extract expiries from OCC symbols → auto-select nearest
  const loadAll = useCallback(async (sym: string) => {
    setLoading(true); setError(null); setExpiries([]); setRows([]); setAllContracts([]);
    try {
      const contracts: UWContract[] = await uw({ action: "option-chain", ticker: sym });
      const dateSet = new Set<string>();
      for (const c of contracts) {
        const d = extractExpiry(c);
        if (d) dateSet.add(d);
      }
      const dates = Array.from(dateSet).sort();
      setAllContracts(contracts);
      setExpiries(dates);

      const today = new Date().toISOString().slice(0, 10);
      const first = dates.find((d) => d > today) ?? dates[0] ?? "";
      setSelExp(first);
      if (first) setRows(buildChainRows(contracts.filter((c) => extractExpiry(c) === first)));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  const handleExpChange = (exp: string) => {
    setSelExp(exp);
    const filtered = allContracts.filter((c) => extractExpiry(c) === exp);
    if (filtered.length > 0) setRows(buildChainRows(filtered));
  };

  useEffect(() => { if (ticker) loadAll(ticker); }, [ticker]);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
        <input value={input} onChange={(e) => setInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && setTicker(input)}
          placeholder="Ticker…" style={{ ...INPUT, width: 120 }} />
        <button onClick={() => setTicker(input)} style={BTN("cyan")}>Load Chain</button>
        {expiries.length > 0 && (
          <select value={selExp} onChange={(e) => handleExpChange(e.target.value)} style={{ ...INPUT, cursor: "pointer" }}>
            {expiries.map((ex) => <option key={ex} value={ex}>{fmtDate(ex)}</option>)}
          </select>
        )}
        {ticker && <button onClick={() => loadAll(ticker)} style={BTN("gray")}>↻ Refresh</button>}
      </div>

      <div style={{ background: "rgba(6,182,212,0.06)", border: "1px solid rgba(6,182,212,0.15)", borderRadius: 8, padding: "8px 16px", marginBottom: 14, fontSize: 13, color: "#67e8f9" }}>
        Unusual Whales · NBBO bid/ask · IV · Volume breakdown per strike
      </div>

      {loading && <Spinner />}
      {error   && <ErrorBox message={error} />}

      {!loading && !error && rows.length === 0 && (
        <div style={{ textAlign: "center", padding: 48, color: "#475569", fontSize: 15 }}>
          Enter a ticker and click Load Chain.
        </div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ borderBottom: "2px solid rgba(255,255,255,0.1)" }}>
                <th style={{ ...TH_C, color: "#10b981" }}>Call Bid</th>
                <th style={{ ...TH_C, color: "#10b981" }}>Call Ask</th>
                <th style={{ ...TH_C, color: "#10b981" }}>Call IV</th>
                <th style={{ ...TH_C, color: "#10b981" }}>Call Vol</th>
                <th style={{ ...TH_C, background: "rgba(255,255,255,0.04)", color: "#e2e8f0", fontSize: 15 }}>STRIKE</th>
                <th style={{ ...TH_C, color: "#ef4444" }}>Put Vol</th>
                <th style={{ ...TH_C, color: "#ef4444" }}>Put IV</th>
                <th style={{ ...TH_C, color: "#ef4444" }}>Put Bid</th>
                <th style={{ ...TH_C, color: "#ef4444" }}>Put Ask</th>
                <th style={{ ...TH_C, color: "#64748b" }}>OI</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const callVol = safeNum(r.call?.volume, 0);
                const putVol  = safeNum(r.put?.volume,  0);
                const oi      = safeNum(r.call?.open_interest ?? r.put?.open_interest, 0);
                return (
                  <tr key={r.strike} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                    <td style={{ ...TD_MONO_C, color: "#10b981" }}>{fmtChainBid(r.call)}</td>
                    <td style={{ ...TD_MONO_C, color: "#10b981" }}>{fmtChainAsk(r.call)}</td>
                    <td style={{ ...TD_MONO_C, color: "#10b981" }}>{fmtChainIV(r.call)}</td>
                    <td style={{ ...TD_MONO_C, color: "#10b981" }}>{callVol > 0 ? callVol.toLocaleString() : "—"}</td>
                    <td style={{ ...TD_MONO_C, fontWeight: 700, color: "#e2e8f0", background: "rgba(255,255,255,0.04)", fontSize: 17 }}>${r.strike}</td>
                    <td style={{ ...TD_MONO_C, color: "#ef4444" }}>{putVol > 0 ? putVol.toLocaleString() : "—"}</td>
                    <td style={{ ...TD_MONO_C, color: "#ef4444" }}>{fmtChainIV(r.put)}</td>
                    <td style={{ ...TD_MONO_C, color: "#ef4444" }}>{fmtChainBid(r.put)}</td>
                    <td style={{ ...TD_MONO_C, color: "#ef4444" }}>{fmtChainAsk(r.put)}</td>
                    <td style={{ ...TD_MONO_C, color: "#64748b" }}>{oi > 0 ? oi.toLocaleString() : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
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
      const secret = prompt("Enter your CRON_SECRET to test:");
      if (!secret) { setTesting(false); return; }
      const res  = await fetch(`/api/cron?secret=${encodeURIComponent(secret)}&manual=true&debug=true`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setTestResult(`✅ Scan complete — ${json.alertsSent} alert(s) sent\n\nLog:\n${json.log?.join("\n") ?? ""}`);
    } catch (e: any) {
      setTestResult(`❌ ${e.message}`);
    } finally {
      setTesting(false);
    }
  };

  const ENV_VARS = [
    { name: "UNUSUAL_WHALES_API_TOKEN", note: "Already set ✓"       },
    { name: "TASTYTRADE_CLIENT_SECRET", note: "Already set ✓"       },
    { name: "TASTYTRADE_REFRESH_TOKEN", note: "Already set ✓"       },
    { name: "XAI_API_KEY",             note: "Your Grok API key"    },
    { name: "TELEGRAM_BOT_TOKEN",      note: "From @BotFather"      },
    { name: "TELEGRAM_CHAT_ID",        note: "Your chat ID"         },
    { name: "CRON_SECRET",             note: "Any random string"    },
  ];

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: "#e2e8f0", marginBottom: 4 }}>🔔 Automated Alert System</div>
      <div style={{ fontSize: 14, color: "#64748b", marginBottom: 24 }}>
        Scans every 15 min during market hours · Alerts when sweep + opening + ask-side + BUY FRIENDLY all align · Grok screens for red flags before sending
      </div>

      {/* How it works */}
      <div style={{ background: "rgba(6,182,212,0.06)", border: "1px solid rgba(6,182,212,0.15)", borderRadius: 8, padding: "14px 18px", marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "#06b6d4", marginBottom: 10 }}>How it works</div>
        {[
          "Every 15 min (9:30–4pm ET, weekdays), the scanner fetches fresh flow alerts",
          "Filters to sweeps ≥ $100K that are opening + ask-side (≥ 65%)",
          "Cross-checks each ticker's vol arb signal — only proceeds on BUY FRIENDLY or BUY VOL",
          "Sends the setup to Grok to screen for red flags (earnings, FDA, news)",
          "If clean → fires a Telegram alert to @PeachClawbot with full setup details",
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
        {testing ? "Scanning…" : "▶ Run Manual Scan Now"}
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
// RESEARCH TAB  — Claude-powered chat with live scanner context
// Requires ANTHROPIC_API_KEY in Vercel environment variables
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
          uw({ action: "flow", limit: "20", min_premium: "50000" }),
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
    "What does a call sweep mean vs a regular block trade?",
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
              {flows.length} flow alerts loaded
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
// ROOT
// ═══════════════════════════════════════════════════════════════════════════
const TABS = [
  { id: "flow",     label: "⊕ Flow Scanner" },
  { id: "darkpool", label: "◈ Dark Pool"    },
  { id: "volArb",   label: "◇ Vol Arb"      },
  { id: "account",  label: "⊞ Account"      },
  { id: "kelly",    label: "△ Kelly Lab"     },
  { id: "chain",    label: "≡ Chain"         },
  { id: "research", label: "◆ Research"      },
  { id: "alerts",   label: "⏰ Alerts"       },
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
              Unusual Whales Flow · Dark Pool · Vol Arb · Tastytrade Account · Kelly Sizing · Option Chain · AI Research
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ background: "rgba(16,185,129,0.12)", color: "#10b981", border: "1px solid rgba(16,185,129,0.25)", padding: "3px 10px", borderRadius: 4, fontSize: 12, fontWeight: 700 }}>LIVE</span>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#10b981", boxShadow: "0 0 8px rgba(16,185,129,0.6)", animation: "oes-pulse 2s ease-in-out infinite" }} />
          </div>
        </div>
        <div style={{ display: "flex", overflowX: "auto", padding: "0 24px" }}>
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
        {tab === "flow"     && <FlowTab     />}
        {tab === "darkpool" && <DarkPoolTab />}
        {tab === "volArb"   && <VolArbTab   />}
        {tab === "account"  && <AccountTab  />}
        {tab === "kelly"    && <KellyTab    />}
        {tab === "chain"    && <ChainTab    />}
        {tab === "research" && <ResearchTab />}
        {tab === "alerts"   && <AlertsTab   />}
      </div>

      <div style={{ padding: "12px 24px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between", color: "#334155", fontSize: 12 }}>
        <span>Options Edge Scanner v7 · Not financial advice · Read-only</span>
        <span>Tastytrade + Unusual Whales APIs</span>
      </div>
    </div>
  );
}
