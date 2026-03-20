"use client";

import { useState, useEffect, useCallback } from "react";

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
// ★ Single-endpoint approach: fetch option-contracts, extract dates from
//   the returned contracts themselves so we never guess schema field names.
// ★ Step 1: Load Chain → fetch without expiration filter (limit=200)
//           → extract unique expiration dates from contract objects
//           → auto-select nearest future expiry
// ★ Step 2: User picks expiry OR it auto-selects → fetch with expiration_date
//           → build strike grid
// ═══════════════════════════════════════════════════════════════════════════
interface UWContract {
  // Option type — UW uses various names, we try all
  option_type?: string; // "C" or "P"
  type?: string;        // "call" or "put"
  side?: string;
  // Strike
  strike?: number | string;
  strike_price?: number | string;
  // Prices
  bid?: number | string;
  bid_price?: number | string;
  ask?: number | string;
  ask_price?: number | string;
  // IV — decimal (0-1) multiply × 100 for display
  iv?: number | string;
  implied_volatility?: number | string;
  // Greeks
  delta?: number | string;
  gamma?: number | string;
  theta?: number | string;
  vega?: number | string;
  // Volume / OI
  open_interest?: number | string;
  oi?: number | string;
  volume?: number | string;
  // Expiration — try all common field names
  expiration_date?: string;
  expiry?: string;
  exp_date?: string;
  expires_at?: string;
  // Option symbol — date embedded e.g. "SPY260327C00660000"
  option_symbol?: string;
  symbol?: string;
}

// Extract expiration date from a contract — try every known field name,
// then fall back to parsing the OCC option symbol (YYMMDD at chars 3-8)
function extractExpiry(c: any): string {
  const direct =
    c.expiration_date ?? c.expiry ?? c.exp_date ?? c.expires_at ??
    c.expiration ?? c.expire_date ?? c.expirationDate ?? "";
  if (direct) return direct.slice(0, 10); // normalize to YYYY-MM-DD

  // Parse from OCC symbol e.g. "SPY260327C00660000" → 260327 → 2026-03-27
  const sym: string = c.option_symbol ?? c.symbol ?? c.contract ?? "";
  const m = sym.match(/[A-Z]+(\d{2})(\d{2})(\d{2})[CP]/i);
  if (m) return `20${m[1]}-${m[2]}-${m[3]}`;

  return "";
}

// Extract option type: "C" or "P"
function extractOptionType(c: any): "C" | "P" | null {
  const raw = (c.option_type ?? c.type ?? c.side ?? c.call_put ?? "").toUpperCase();
  if (raw === "C" || raw === "CALL") return "C";
  if (raw === "P" || raw === "PUT")  return "P";
  // Try parsing from option symbol
  const sym: string = c.option_symbol ?? c.symbol ?? "";
  if (/[A-Z]\d{6}C/i.test(sym)) return "C";
  if (/[A-Z]\d{6}P/i.test(sym)) return "P";
  return null;
}

interface ChainRow { strike: number; call: UWContract | null; put: UWContract | null; }

function buildChainRows(contracts: UWContract[]): ChainRow[] {
  const map = new Map<number, ChainRow>();
  for (const c of contracts) {
    const strike = safeNum((c as any).strike ?? (c as any).strike_price, 0);
    if (strike === 0) continue;
    if (!map.has(strike)) map.set(strike, { strike, call: null, put: null });
    const row = map.get(strike)!;
    const ot = extractOptionType(c);
    if (ot === "C") row.call = c;
    else if (ot === "P") row.put = c;
  }
  return Array.from(map.values()).sort((a, b) => a.strike - b.strike);
}

function fmtChainIV(c: UWContract | null): string {
  if (!c) return "—";
  const raw = safeNum((c as any).iv ?? (c as any).implied_volatility ?? (c as any).impliedVolatility, NaN);
  if (isNaN(raw) || raw === 0) return "—";
  // UW returns IV as decimal (0-1) — multiply × 100
  const pct = raw > 5 ? raw : raw * 100; // guard against already-% values
  return `${pct.toFixed(0)}%`;
}
function fmtChainPrice(c: UWContract | null, field: "bid" | "ask"): string {
  if (!c) return "—";
  const v = safeNum(
    field === "bid" ? ((c as any).bid ?? (c as any).bid_price) : ((c as any).ask ?? (c as any).ask_price),
    NaN
  );
  return isNaN(v) ? "—" : `$${v.toFixed(2)}`;
}
function fmtChainDelta(c: UWContract | null): string {
  if (!c) return "—";
  const v = safeNum((c as any).delta, NaN);
  return isNaN(v) ? "—" : v.toFixed(2);
}

function ChainTab() {
  const [ticker,      setTicker]      = useState("SPY");
  const [input,       setInput]       = useState("SPY");
  const [expiries,    setExpiries]    = useState<string[]>([]);
  const [selExp,      setSelExp]      = useState("");
  const [rows,        setRows]        = useState<ChainRow[]>([]);
  const [allContracts,setAllContracts]= useState<UWContract[]>([]);
  const [loading,     setLoading]     = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [rawSample,   setRawSample]   = useState<string>(""); // debug: first contract keys

  // ── Step 1: Load all contracts (no expiration filter) to discover dates ──
  const loadAll = useCallback(async (sym: string) => {
    setLoading(true); setError(null); setExpiries([]); setRows([]); setAllContracts([]);
    try {
      const contracts: any[] = await uw({ action: "option-chain", ticker: sym });

      // Debug: capture field names of first contract
      if (contracts.length > 0) {
        setRawSample(Object.keys(contracts[0]).join(", "));
      }

      // Extract unique expiration dates
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

      // Build rows for the auto-selected expiry
      if (first) {
        const filtered = contracts.filter((c) => extractExpiry(c) === first);
        setRows(buildChainRows(filtered));
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  // ── Step 2: User changes expiry → fetch filtered from API ──────────────
  const loadByExpiry = useCallback(async (exp: string) => {
    if (!ticker || !exp) return;
    setLoading(true); setError(null);
    try {
      const contracts: any[] = await uw({ action: "option-chain", ticker, expiration: exp });
      setRows(buildChainRows(contracts));
      // Also update allContracts & expiry list from this call
      if (expiries.length === 0) {
        const dateSet = new Set<string>();
        for (const c of contracts) { const d = extractExpiry(c); if (d) dateSet.add(d); }
        setExpiries(Array.from(dateSet).sort());
      }
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [ticker, expiries]);

  // When ticker changes → load all
  useEffect(() => { if (ticker) loadAll(ticker); }, [ticker]);

  // When user manually changes expiry dropdown
  const handleExpChange = (exp: string) => {
    setSelExp(exp);
    // Try filtering from cached contracts first
    const filtered = allContracts.filter((c) => extractExpiry(c) === exp);
    if (filtered.length > 0) {
      setRows(buildChainRows(filtered));
    } else {
      loadByExpiry(exp);
    }
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
        <input value={input} onChange={(e) => setInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && setTicker(input)}
          placeholder="Ticker…" style={{ ...INPUT, width: 120 }} />
        <button onClick={() => setTicker(input)} style={BTN("cyan")}>Load Chain</button>
        {expiries.length > 0 && (
          <select value={selExp} onChange={(e) => handleExpChange(e.target.value)} style={{ ...INPUT, cursor: "pointer" }}>
            {expiries.map((ex) => (
              <option key={ex} value={ex}>{fmtDate(ex)}</option>
            ))}
          </select>
        )}
        {selExp && <button onClick={() => loadByExpiry(selExp)} style={BTN("gray")}>↻ Refresh</button>}
      </div>

      <div style={{ background: "rgba(6,182,212,0.06)", border: "1px solid rgba(6,182,212,0.15)", borderRadius: 8, padding: "8px 16px", marginBottom: 14, fontSize: 13, color: "#67e8f9" }}>
        Powered by Unusual Whales · Live bid/ask/IV/delta per strike
      </div>

      {/* Debug banner — shows actual field names from API so we can fix mapping if needed */}
      {rawSample && rows.length === 0 && !loading && (
        <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 6, padding: "8px 14px", marginBottom: 12, fontSize: 12, color: "#f59e0b", wordBreak: "break-all" }}>
          ⚠ Contracts received but no rows rendered. API fields: {rawSample}
        </div>
      )}

      {loading && <Spinner />}
      {error   && <ErrorBox message={error} />}

      {!loading && !error && rows.length === 0 && !rawSample && (
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
                <th style={{ ...TH_C, color: "#10b981" }}>Call Δ</th>
                <th style={{ ...TH_C, background: "rgba(255,255,255,0.04)", color: "#e2e8f0", fontSize: 15 }}>STRIKE</th>
                <th style={{ ...TH_C, color: "#ef4444" }}>Put Δ</th>
                <th style={{ ...TH_C, color: "#ef4444" }}>Put IV</th>
                <th style={{ ...TH_C, color: "#ef4444" }}>Put Bid</th>
                <th style={{ ...TH_C, color: "#ef4444" }}>Put Ask</th>
                <th style={{ ...TH_C, color: "#64748b" }}>OI</th>
                <th style={{ ...TH_C, color: "#64748b" }}>Vol</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.strike} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                  <td style={{ ...TD_MONO_C, color: "#10b981" }}>{fmtChainPrice(r.call, "bid")}</td>
                  <td style={{ ...TD_MONO_C, color: "#10b981" }}>{fmtChainPrice(r.call, "ask")}</td>
                  <td style={{ ...TD_MONO_C, color: "#10b981" }}>{fmtChainIV(r.call)}</td>
                  <td style={{ ...TD_MONO_C, color: "#10b981" }}>{fmtChainDelta(r.call)}</td>
                  <td style={{ ...TD_MONO_C, fontWeight: 700, color: "#e2e8f0", background: "rgba(255,255,255,0.04)", fontSize: 17 }}>${r.strike}</td>
                  <td style={{ ...TD_MONO_C, color: "#ef4444" }}>{fmtChainDelta(r.put)}</td>
                  <td style={{ ...TD_MONO_C, color: "#ef4444" }}>{fmtChainIV(r.put)}</td>
                  <td style={{ ...TD_MONO_C, color: "#ef4444" }}>{fmtChainPrice(r.put, "bid")}</td>
                  <td style={{ ...TD_MONO_C, color: "#ef4444" }}>{fmtChainPrice(r.put, "ask")}</td>
                  <td style={{ ...TD_MONO_C, color: "#64748b" }}>{safeNum((r.call as any)?.open_interest ?? (r.call as any)?.oi ?? (r.put as any)?.open_interest ?? (r.put as any)?.oi, 0) || "—"}</td>
                  <td style={{ ...TD_MONO_C, color: "#64748b" }}>{safeNum((r.call as any)?.volume ?? (r.put as any)?.volume, 0) || "—"}</td>
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
// ALERTS
// ═══════════════════════════════════════════════════════════════════════════
function AlertsTab() {
  return (
    <div style={{ textAlign: "center", padding: 48 }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔔</div>
      <div style={{ fontSize: 16, color: "#64748b" }}>Telegram alerts configured via Vercel cron.</div>
      <div style={{ fontSize: 14, marginTop: 8, color: "#475569" }}>Alerts fire when Vol Arb signals BUY FRIENDLY or BUY VOL and flow confirms.</div>
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
              Unusual Whales Flow · Dark Pool · Vol Arb · Tastytrade Account · Kelly Sizing · Option Chain
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
        {tab === "alerts"   && <AlertsTab   />}
      </div>

      <div style={{ padding: "12px 24px", borderTop: "1px solid rgba(255,255,255,0.05)", display: "flex", justifyContent: "space-between", color: "#334155", fontSize: 12 }}>
        <span>Options Edge Scanner v7 · Not financial advice · Read-only</span>
        <span>Tastytrade + Unusual Whales APIs</span>
      </div>
    </div>
  );
}
