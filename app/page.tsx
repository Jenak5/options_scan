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
const tt = (p: Record<string, string>) => fetchApi("/api/tastytrade", p);
const uw = (p: Record<string, string>) => fetchApi("/api/unusualwhales", p);

// ─── Shared UI ─────────────────────────────────────────────────────────────

type BadgeColor = "green" | "red" | "amber" | "blue" | "purple" | "cyan" | "gray";

const BADGE_COLORS: Record<BadgeColor, { bg: string; text: string; border: string }> = {
  green:  { bg: "rgba(16,185,129,0.12)",  text: "#10b981", border: "rgba(16,185,129,0.3)"  },
  red:    { bg: "rgba(239,68,68,0.12)",   text: "#ef4444", border: "rgba(239,68,68,0.3)"   },
  amber:  { bg: "rgba(245,158,11,0.12)",  text: "#f59e0b", border: "rgba(245,158,11,0.3)"  },
  blue:   { bg: "rgba(59,130,246,0.12)",  text: "#3b82f6", border: "rgba(59,130,246,0.3)"  },
  purple: { bg: "rgba(168,85,247,0.12)",  text: "#a855f7", border: "rgba(168,85,247,0.3)"  },
  cyan:   { bg: "rgba(6,182,212,0.12)",   text: "#06b6d4", border: "rgba(6,182,212,0.3)"   },
  gray:   { bg: "rgba(100,116,139,0.10)", text: "#64748b", border: "rgba(100,116,139,0.25)" },
};

function Badge({ children, color = "gray" }: { children: React.ReactNode; color?: BadgeColor }) {
  const s = BADGE_COLORS[color];
  return (
    <span style={{
      background: s.bg, color: s.text, border: `1px solid ${s.border}`,
      padding: "2px 7px", borderRadius: 4, fontSize: 10, fontWeight: 700,
      letterSpacing: "0.05em", whiteSpace: "nowrap",
      fontFamily: "'JetBrains Mono', 'Courier New', monospace",
    }}>{children}</span>
  );
}

function Spinner() {
  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "center", padding: 48 }}>
      <div style={{
        width: 28, height: 28,
        border: "3px solid rgba(6,182,212,0.15)",
        borderTopColor: "#06b6d4",
        borderRadius: "50%",
        animation: "spin 0.75s linear infinite",
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div style={{
      background: "rgba(239,68,68,0.07)", border: "1px solid rgba(239,68,68,0.2)",
      borderRadius: 8, padding: "14px 18px", textAlign: "center",
    }}>
      <div style={{ color: "#ef4444", fontSize: 12, marginBottom: 8 }}>{message}</div>
      {onRetry && (
        <button onClick={onRetry} style={{
          background: "rgba(239,68,68,0.15)", color: "#ef4444",
          border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6,
          padding: "5px 14px", fontSize: 11, cursor: "pointer",
        }}>Retry</button>
      )}
    </div>
  );
}

const INPUT: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)", color: "#e2e8f0",
  border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6,
  padding: "6px 11px", fontSize: 12, outline: "none", fontFamily: "inherit",
};

function fmtPremium(v: number | null | undefined) {
  if (v == null || isNaN(v)) return "—";
  if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`;
  return `$${v}`;
}
function fmtDate(d: string | undefined | null) {
  if (!d) return "—";
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit" });
}

// ═══════════════════════════════════════════════════════════════════════════
// BID/ASK SIDE BADGE
// Source field: ask_side_ratio (0.0–1.0 from Unusual Whales)
// ≥ 0.65 → AT ASK (buyer-initiated, bullish)
// ≤ 0.35 → AT BID (seller-initiated, bearish)
// else   → MID (split/neutral)
// ═══════════════════════════════════════════════════════════════════════════
function SideBadge({ askSideRatio }: { askSideRatio?: number | null }) {
  if (askSideRatio == null) return <Badge color="gray">—</Badge>;
  if (askSideRatio >= 0.65) return <Badge color="green">AT ASK ▲</Badge>;
  if (askSideRatio <= 0.35) return <Badge color="red">AT BID ▼</Badge>;
  return <Badge color="amber">MID ↔</Badge>;
}

// ═══════════════════════════════════════════════════════════════════════════
// OPENING / CLOSING BADGE
// Source fields:
//   all_opening_trades (bool) — UW flags the trade as opening
//   volume_oi_ratio (number)  — volume / open_interest
//     ratio > 1.0 → almost certainly opening (more contracts traded than exist)
//     ratio ≤ 0.2 → likely closing
// ═══════════════════════════════════════════════════════════════════════════
function OpenCloseBadge({
  allOpening, volumeOiRatio,
}: { allOpening?: boolean | null; volumeOiRatio?: number | null }) {
  // Explicit UW flag takes priority
  if (allOpening === true)  return <Badge color="cyan">OPENING</Badge>;
  if (allOpening === false) return <Badge color="gray">CLOSING</Badge>;
  // Fall back to volume/OI ratio
  if (volumeOiRatio != null) {
    if (volumeOiRatio > 1.0)  return <Badge color="cyan">OPENING</Badge>;
    if (volumeOiRatio <= 0.2) return <Badge color="gray">CLOSING</Badge>;
  }
  return null; // ambiguous — show nothing
}

// ═══════════════════════════════════════════════════════════════════════════
// PREMIUM BREAKDOWN
// Source fields:
//   ask_premium  — dollar premium paid on the ask side (buyer-initiated)
//   bid_premium  — dollar premium paid on the bid side (seller-initiated)
// Shows a small stacked bar so you can see the split at a glance.
// ═══════════════════════════════════════════════════════════════════════════
function PremiumBreakdown({
  askPremium, bidPremium, total,
}: { askPremium?: number | null; bidPremium?: number | null; total: number }) {
  if (!askPremium && !bidPremium) return <span style={{ color: "#94a3b8" }}>{fmtPremium(total)}</span>;
  const ask  = askPremium ?? 0;
  const bid  = bidPremium ?? 0;
  const sum  = ask + bid || total || 1;
  const askPct = Math.round((ask / sum) * 100);
  const bidPct = 100 - askPct;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 90 }}>
      <span style={{ color: "#f59e0b", fontWeight: 600, fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>
        {fmtPremium(total)}
      </span>
      {/* stacked bar */}
      <div style={{ display: "flex", height: 4, borderRadius: 2, overflow: "hidden", background: "rgba(255,255,255,0.06)" }}>
        <div style={{ width: `${askPct}%`, background: "#10b981" }} title={`Ask: ${fmtPremium(ask)}`} />
        <div style={{ width: `${bidPct}%`, background: "#ef4444" }} title={`Bid: ${fmtPremium(bid)}`} />
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#64748b" }}>
        <span style={{ color: "#10b981" }}>Ask {fmtPremium(ask)}</span>
        <span style={{ color: "#ef4444" }}>Bid {fmtPremium(bid)}</span>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab: Flow Scanner
// ═══════════════════════════════════════════════════════════════════════════

interface FlowAlert {
  id?: string;
  ticker?: string;
  strike?: string | number;
  put_call?: string;
  expiry?: string | null;
  // Premium
  total_premium?: number | null;
  premium?: number | null;
  ask_premium?: number | null;     // ★ ask-side premium
  bid_premium?: number | null;     // ★ bid-side premium
  // Side
  ask_side_ratio?: number | null;  // ★ 0.0–1.0
  // Opening/Closing
  all_opening_trades?: boolean | null;  // ★ UW explicit flag
  volume_oi_ratio?: number | null;      // ★ volume / OI
  // Other
  size?: number | null;
  open_interest?: number | null;
  iv_start?: number | null;
  iv?: number | null;
  has_sweep?: boolean;
  is_sweep?: boolean;
  is_golden_sweep?: boolean;
}

function FlowTab() {
  const [flows, setFlows] = useState<FlowAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({
    ticker: "", sweepsOnly: false, minPremium: "50000", otmOnly: false,
  });

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const p: Record<string, string> = {
        action: "flow", limit: "60", min_premium: filters.minPremium,
      };
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
      {/* ── Filters ── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap", alignItems: "center" }}>
        <input
          placeholder="Ticker…" value={filters.ticker}
          onChange={(e) => setFilters({ ...filters, ticker: e.target.value.toUpperCase() })}
          style={{ ...INPUT, width: 100 }}
        />
        <select
          value={filters.minPremium}
          onChange={(e) => setFilters({ ...filters, minPremium: e.target.value })}
          style={{ ...INPUT, cursor: "pointer" }}
        >
          <option value="10000">$10K+ prem</option>
          <option value="50000">$50K+ prem</option>
          <option value="100000">$100K+ prem</option>
          <option value="500000">$500K+ prem</option>
          <option value="1000000">$1M+ prem</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#94a3b8", cursor: "pointer" }}>
          <input type="checkbox" checked={filters.sweepsOnly}
            onChange={(e) => setFilters({ ...filters, sweepsOnly: e.target.checked })} />
          Sweeps only
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#94a3b8", cursor: "pointer" }}>
          <input type="checkbox" checked={filters.otmOnly}
            onChange={(e) => setFilters({ ...filters, otmOnly: e.target.checked })} />
          OTM only
        </label>
        <button onClick={load} style={{
          background: "rgba(6,182,212,0.15)", color: "#06b6d4",
          border: "1px solid rgba(6,182,212,0.3)", borderRadius: 6,
          padding: "6px 14px", fontSize: 12, cursor: "pointer",
        }}>↻ Refresh</button>
      </div>

      {/* ── Legend ── */}
      <div style={{
        display: "flex", gap: 20, marginBottom: 12, padding: "7px 12px",
        background: "rgba(255,255,255,0.025)", borderRadius: 6, flexWrap: "wrap",
      }}>
        <span style={{ color: "#64748b", fontSize: 10, fontWeight: 700, letterSpacing: "0.06em" }}>SIDE</span>
        <span style={{ color: "#10b981", fontSize: 10 }}>▲ AT ASK — buyer-initiated (bullish)</span>
        <span style={{ color: "#ef4444", fontSize: 10 }}>▼ AT BID — seller-initiated (bearish)</span>
        <span style={{ color: "#f59e0b", fontSize: 10 }}>↔ MID — split fills</span>
        <span style={{ color: "#64748b", fontSize: 10, fontWeight: 700, marginLeft: 8 }}>POSITION</span>
        <span style={{ color: "#06b6d4", fontSize: 10 }}>OPENING — new contracts</span>
        <span style={{ color: "#64748b", fontSize: 10 }}>CLOSING — exiting existing</span>
      </div>

      {loading && <Spinner />}
      {error   && <ErrorBox message={error} onRetry={load} />}

      {!loading && !error && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                {["Ticker","Type","Strike","Expiry","Premium / Split","Size","OI","Vol/OI","IV","Side","Position","Flags"].map((h) => (
                  <th key={h} style={{
                    padding: "7px 10px", textAlign: "left", color: "#475569",
                    fontWeight: 700, letterSpacing: "0.06em", fontSize: 10,
                    whiteSpace: "nowrap", userSelect: "none",
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {flows.length === 0 && (
                <tr>
                  <td colSpan={12} style={{ padding: 32, textAlign: "center", color: "#475569" }}>
                    No flow alerts match current filters.
                  </td>
                </tr>
              )}
              {flows.map((f, i) => {
                const premium     = f.total_premium ?? f.premium ?? 0;
                const iv          = f.iv_start ?? f.iv ?? 0;
                const isSweep     = f.has_sweep || f.is_sweep;
                const isGolden    = f.is_golden_sweep;
                const isCall      = (f.put_call ?? "").toUpperCase().startsWith("C");
                const volOiRatio  = f.volume_oi_ratio ?? null;

                return (
                  <tr
                    key={f.id ?? i}
                    style={{
                      borderBottom: "1px solid rgba(255,255,255,0.04)",
                      background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)",
                    }}
                  >
                    {/* Ticker */}
                    <td style={{ padding: "9px 10px", fontWeight: 700, color: "#e2e8f0", fontFamily: "monospace" }}>
                      {f.ticker}
                    </td>

                    {/* CALL / PUT */}
                    <td style={{ padding: "9px 10px" }}>
                      <Badge color={isCall ? "green" : "red"}>{isCall ? "CALL" : "PUT"}</Badge>
                    </td>

                    {/* Strike */}
                    <td style={{ padding: "9px 10px", color: "#94a3b8", fontFamily: "monospace" }}>
                      {f.strike ? `$${f.strike}` : "—"}
                    </td>

                    {/* Expiry */}
                    <td style={{ padding: "9px 10px", color: "#94a3b8", whiteSpace: "nowrap" }}>
                      {fmtDate(f.expiry)}
                    </td>

                    {/* ★ Premium + split bar */}
                    <td style={{ padding: "9px 10px" }}>
                      <PremiumBreakdown
                        total={premium}
                        askPremium={f.ask_premium}
                        bidPremium={f.bid_premium}
                      />
                    </td>

                    {/* Size */}
                    <td style={{ padding: "9px 10px", color: "#e2e8f0", fontFamily: "monospace" }}>
                      {f.size?.toLocaleString() ?? "—"}
                    </td>

                    {/* OI */}
                    <td style={{ padding: "9px 10px", color: "#64748b", fontFamily: "monospace" }}>
                      {f.open_interest?.toLocaleString() ?? "—"}
                    </td>

                    {/* Vol/OI ratio */}
                    <td style={{ padding: "9px 10px", fontFamily: "monospace" }}>
                      {volOiRatio != null ? (
                        <span style={{ color: volOiRatio > 1 ? "#06b6d4" : volOiRatio < 0.2 ? "#64748b" : "#94a3b8" }}>
                          {volOiRatio.toFixed(2)}x
                        </span>
                      ) : "—"}
                    </td>

                    {/* IV */}
                    <td style={{ padding: "9px 10px" }}>
                      {iv ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                          <span style={{ color: "#a855f7", fontFamily: "monospace" }}>
                            {(iv * 100).toFixed(0)}%
                          </span>
                          <div style={{ width: 48, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
                            <div style={{ width: `${Math.min(iv / 2 * 100, 100)}%`, height: "100%", background: "#a855f7", borderRadius: 2 }} />
                          </div>
                        </div>
                      ) : "—"}
                    </td>

                    {/* ★ Bid/Ask Side */}
                    <td style={{ padding: "9px 10px" }}>
                      <SideBadge askSideRatio={f.ask_side_ratio} />
                    </td>

                    {/* ★ Opening / Closing */}
                    <td style={{ padding: "9px 10px" }}>
                      <OpenCloseBadge
                        allOpening={f.all_opening_trades}
                        volumeOiRatio={volOiRatio}
                      />
                    </td>

                    {/* Flags */}
                    <td style={{ padding: "9px 10px" }}>
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
// Tab: Dark Pool
// ═══════════════════════════════════════════════════════════════════════════

interface DarkPrint {
  ticker?: string;
  price?: number | null;
  size?: number | null;
  notional?: number | null;
  date?: string | null;
  exchange?: string | null;
  premium?: number | null;
}

function DarkPoolTab() {
  const [prints, setPrints] = useState<DarkPrint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]   = useState<string | null>(null);
  const [ticker, setTicker] = useState("");

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
        <input
          placeholder="Filter ticker…" value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          style={{ ...INPUT, width: 120 }}
        />
        <button onClick={load} style={{
          background: "rgba(6,182,212,0.15)", color: "#06b6d4",
          border: "1px solid rgba(6,182,212,0.3)", borderRadius: 6,
          padding: "6px 14px", fontSize: 12, cursor: "pointer",
        }}>↻ Refresh</button>
      </div>
      {loading && <Spinner />}
      {error   && <ErrorBox message={error} onRetry={load} />}
      {!loading && !error && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                {["Ticker","Price","Size","Notional","Exchange","Time"].map((h) => (
                  <th key={h} style={{ padding: "7px 10px", textAlign: "left", color: "#475569", fontWeight: 700, fontSize: 10 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {prints.length === 0 && (
                <tr><td colSpan={6} style={{ padding: 32, textAlign: "center", color: "#475569" }}>No dark pool prints found.</td></tr>
              )}
              {prints.map((p, i) => (
                <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                  <td style={{ padding: "9px 10px", fontWeight: 700, color: "#e2e8f0", fontFamily: "monospace" }}>{p.ticker}</td>
                  <td style={{ padding: "9px 10px", color: "#94a3b8", fontFamily: "monospace" }}>{p.price != null ? `$${p.price.toFixed(2)}` : "—"}</td>
                  <td style={{ padding: "9px 10px", color: "#e2e8f0", fontFamily: "monospace" }}>{p.size?.toLocaleString() ?? "—"}</td>
                  <td style={{ padding: "9px 10px", color: "#f59e0b", fontWeight: 600 }}>{fmtPremium(p.notional ?? p.premium)}</td>
                  <td style={{ padding: "9px 10px", color: "#64748b" }}>{p.exchange ?? "OTC"}</td>
                  <td style={{ padding: "9px 10px", color: "#64748b" }}>{fmtDate(p.date)}</td>
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
// Tab: Vol Arb — v4, five signals
// ═══════════════════════════════════════════════════════════════════════════

interface VolRow {
  ticker: string; iv: number; hv: number; ivRank: number; spread: number;
}

const WATCHLIST = [
  "SPY","QQQ","AAPL","MSFT","NVDA","TSLA","AMZN","META","GOOGL",
  "AMD","SMCI","COIN","MSTR","PLTR","ARM",
];

function volSignal(ivRank: number, spread: number) {
  if (ivRank < 25 && spread < 10) return { label: "BUY FRIENDLY", color: "green"  as BadgeColor, borderColor: "#10b981", tip: "Low IV Rank + tight spread — best risk/reward for long calls/puts." };
  if (ivRank < 25 && spread >= 10) return { label: "CAUTION",     color: "amber"  as BadgeColor, borderColor: "#f59e0b", tip: "IV Rank low but spread wide — cheap vs history, expensive vs moves." };
  if (spread < 0)                   return { label: "BUY VOL",    color: "cyan"   as BadgeColor, borderColor: "#06b6d4", tip: "Options underpriced vs realized vol — rare edge, act fast." };
  if (spread > 20)                  return { label: "EXPENSIVE",  color: "red"    as BadgeColor, borderColor: "#ef4444", tip: "High spread — you're overpaying for volatility. Skip or sell." };
  return                                   { label: "NEUTRAL",    color: "blue"   as BadgeColor, borderColor: "#3b82f6", tip: "No strong signal. Wait for flow confirmation before entering." };
}

function VolArbTab() {
  const [rows, setRows]   = useState<VolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const results: VolRow[] = [];
      for (const ticker of WATCHLIST) {
        try {
          const d      = await tt({ action: "volatility", symbol: ticker });
          const iv     = parseFloat(d["implied-volatility-30-day"]   ?? d.iv     ?? "0");
          const hv     = parseFloat(d["historical-volatility-30-day"] ?? d.hv     ?? "0");
          const ivRank = parseFloat(d["iv-rank"]                      ?? d.ivRank ?? "50");
          results.push({ ticker, iv: iv * 100, hv: hv * 100, ivRank, spread: (iv - hv) * 100 });
        } catch { /* skip individual failures silently */ }
      }
      results.sort((a, b) => a.ivRank - b.ivRank);
      setRows(results);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <div style={{
        background: "rgba(16,185,129,0.06)", border: "1px solid rgba(16,185,129,0.15)",
        borderRadius: 8, padding: "10px 16px", marginBottom: 16, fontSize: 12, color: "#6ee7b7",
      }}>
        ✓ Cash Account Mode — long calls &amp; puts only. Sorted by IV Rank (lowest = best buying opportunity first).
      </div>
      {loading && <Spinner />}
      {error   && <ErrorBox message={error} onRetry={load} />}
      {!loading && !error && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(215px, 1fr))", gap: 12 }}>
          {rows.map((r) => {
            const sig = volSignal(r.ivRank, r.spread);
            return (
              <div key={r.ticker} style={{
                background: "rgba(255,255,255,0.035)", border: `2px solid ${sig.borderColor}44`,
                borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 10,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontWeight: 700, fontSize: 16, color: "#e2e8f0", fontFamily: "monospace" }}>{r.ticker}</span>
                  <Badge color={sig.color}>{sig.label}</Badge>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 11 }}>
                  {[
                    { label: "IV 30d",   val: `${r.iv.toFixed(1)}%`,      color: "#a855f7" },
                    { label: "HV 30d",   val: `${r.hv.toFixed(1)}%`,      color: "#3b82f6" },
                    { label: "Spread",   val: `${r.spread > 0 ? "+" : ""}${r.spread.toFixed(1)}%`, color: r.spread < 0 ? "#10b981" : r.spread > 15 ? "#ef4444" : "#f59e0b" },
                  ].map(({ label, val, color }) => (
                    <div key={label}>
                      <div style={{ color: "#475569", marginBottom: 2 }}>{label}</div>
                      <div style={{ color, fontWeight: 700, fontFamily: "monospace" }}>{val}</div>
                    </div>
                  ))}
                </div>
                <div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#475569", marginBottom: 3 }}>
                    <span>IV Rank</span><span>{r.ivRank.toFixed(0)}%</span>
                  </div>
                  <div style={{ height: 5, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
                    <div style={{
                      width: `${r.ivRank}%`, height: "100%", borderRadius: 3,
                      background: r.ivRank < 25 ? "#10b981" : r.ivRank > 75 ? "#ef4444" : "#f59e0b",
                    }} />
                  </div>
                </div>
                <div style={{ color: "#64748b", fontSize: 10, borderTop: "1px solid rgba(255,255,255,0.06)", paddingTop: 8 }}>
                  {sig.tip}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab: Account
// ═══════════════════════════════════════════════════════════════════════════

interface Position {
  symbol?: string; quantity?: number;
  "close-price"?: string; "average-open-price"?: string;
  "unrealized-day-gain-loss"?: string;
}

function AccountTab() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [balances,  setBalances]  = useState<any>(null);
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [pos, bal] = await Promise.all([
        tt({ action: "positions" }),
        tt({ action: "balances" }),
      ]);
      setPositions(Array.isArray(pos) ? pos : pos?.items ?? []);
      setBalances(bal);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const netLiq     = balances?.["net-liquidating-value"] ?? balances?.net_liq ?? "—";
  const buyPower   = balances?.["derivative-buying-power"] ?? balances?.buying_power ?? "—";
  const cashBal    = balances?.["cash-balance"] ?? balances?.cash ?? "—";

  return (
    <div>
      {loading && <Spinner />}
      {error   && <ErrorBox message={error} onRetry={load} />}
      {!loading && !error && (
        <>
          <div style={{ display: "flex", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
            {[
              { label: "NET LIQ",      value: `$${parseFloat(netLiq).toLocaleString()}`,   color: "#10b981" },
              { label: "BUYING POWER", value: `$${parseFloat(buyPower).toLocaleString()}`, color: "#06b6d4" },
              { label: "CASH",         value: `$${parseFloat(cashBal).toLocaleString()}`,  color: "#e2e8f0" },
            ].map(({ label, value, color }) => (
              <div key={label} style={{
                background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: 8, padding: "14px 20px",
              }}>
                <div style={{ color: "#475569", fontSize: 10, letterSpacing: "0.08em", marginBottom: 4 }}>{label}</div>
                <div style={{ color, fontSize: 20, fontWeight: 700, fontFamily: "monospace" }}>{value}</div>
              </div>
            ))}
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                {["Symbol","Qty","Avg Open","Last","Unrealized P&L"].map((h) => (
                  <th key={h} style={{ padding: "7px 10px", textAlign: "left", color: "#475569", fontWeight: 700, fontSize: 10 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {positions.length === 0 && (
                <tr><td colSpan={5} style={{ padding: 32, textAlign: "center", color: "#475569" }}>No open positions.</td></tr>
              )}
              {positions.map((p, i) => {
                const pnl = parseFloat(p["unrealized-day-gain-loss"] ?? "0");
                return (
                  <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                    <td style={{ padding: "9px 10px", fontWeight: 700, color: "#e2e8f0", fontFamily: "monospace" }}>{p.symbol}</td>
                    <td style={{ padding: "9px 10px", color: "#94a3b8", fontFamily: "monospace" }}>{p.quantity}</td>
                    <td style={{ padding: "9px 10px", color: "#94a3b8", fontFamily: "monospace" }}>${p["average-open-price"]}</td>
                    <td style={{ padding: "9px 10px", color: "#e2e8f0", fontFamily: "monospace" }}>${p["close-price"]}</td>
                    <td style={{ padding: "9px 10px", fontFamily: "monospace" }}>
                      <span style={{ color: pnl >= 0 ? "#10b981" : "#ef4444", fontWeight: 600 }}>
                        {pnl >= 0 ? "+" : ""}{pnl.toFixed(2)}
                      </span>
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
// Tab: Kelly Lab
// ═══════════════════════════════════════════════════════════════════════════

function KellyTab() {
  const [winPct,    setWinPct]    = useState(55);
  const [winMult,   setWinMult]   = useState(2.0);
  const [lossMult,  setLossMult]  = useState(1.0);
  const [bankroll,  setBankroll]  = useState(5000);

  const q     = (100 - winPct) / 100;
  const p     = winPct / 100;
  const b     = winMult / lossMult;
  const kelly = Math.max(0, (b * p - q) / b);
  const half  = kelly / 2;
  const trade = bankroll * half;

  const points = Array.from({ length: 20 }, (_, i) => {
    const f   = i / 19;
    const pct = (p * Math.log(1 + b * f) + q * Math.log(1 - f)) * 100;
    return { f: Math.round(f * 100), g: parseFloat(pct.toFixed(3)) };
  });
  const maxG = Math.max(...points.map((p) => p.g));
  const minG = Math.min(...points.map((p) => p.g));

  return (
    <div style={{ maxWidth: 680 }}>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 24 }}>
        {[
          { label: "Win Rate (%)", value: winPct, set: setWinPct, min: 1, max: 99, step: 1 },
          { label: "Win Multiplier (×)", value: winMult, set: setWinMult, min: 0.1, max: 10, step: 0.1 },
          { label: "Loss Multiplier (×)", value: lossMult, set: setLossMult, min: 0.1, max: 10, step: 0.1 },
          { label: "Bankroll ($)", value: bankroll, set: setBankroll, min: 100, max: 1000000, step: 100 },
        ].map(({ label, value, set, min, max, step }) => (
          <div key={label}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "#64748b", marginBottom: 4 }}>
              <span>{label}</span>
              <span style={{ color: "#e2e8f0", fontFamily: "monospace", fontWeight: 600 }}>{value}</span>
            </div>
            <input type="range" min={min} max={max} step={step} value={value}
              onChange={(e) => set(parseFloat(e.target.value))}
              style={{ width: "100%", accentColor: "#06b6d4" }} />
          </div>
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, marginBottom: 24, flexWrap: "wrap" }}>
        {[
          { label: "FULL KELLY", value: `${(kelly * 100).toFixed(1)}%`, color: "#ef4444" },
          { label: "HALF KELLY (use this)", value: `${(half * 100).toFixed(1)}%`, color: "#10b981" },
          { label: "TRADE SIZE", value: `$${trade.toFixed(0)}`, color: "#f59e0b" },
        ].map(({ label, value, color }) => (
          <div key={label} style={{
            background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)",
            borderRadius: 8, padding: "12px 18px",
          }}>
            <div style={{ color: "#475569", fontSize: 10, letterSpacing: "0.06em", marginBottom: 4 }}>{label}</div>
            <div style={{ color, fontSize: 22, fontWeight: 700, fontFamily: "monospace" }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Growth curve chart */}
      <div style={{ position: "relative", height: 140, background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "12px 16px" }}>
        <div style={{ position: "absolute", top: 8, left: 12, fontSize: 10, color: "#475569" }}>Expected log-growth rate vs bet fraction</div>
        <svg viewBox={`0 0 400 100`} style={{ width: "100%", height: "100%" }} preserveAspectRatio="none">
          <polyline
            fill="none" stroke="#06b6d4" strokeWidth="2"
            points={points.map((pt, i) => {
              const x = (i / (points.length - 1)) * 400;
              const y = 90 - ((pt.g - minG) / (maxG - minG || 1)) * 80;
              return `${x},${y}`;
            }).join(" ")}
          />
          {/* Half-kelly marker */}
          {(() => {
            const idx   = Math.round(half * (points.length - 1));
            const x     = (idx / (points.length - 1)) * 400;
            const pt    = points[idx];
            const y     = pt ? 90 - ((pt.g - minG) / (maxG - minG || 1)) * 80 : 50;
            return <line x1={x} y1={0} x2={x} y2={100} stroke="#10b981" strokeWidth="1" strokeDasharray="3,2" />;
          })()}
        </svg>
        <div style={{ position: "absolute", bottom: 8, right: 16, fontSize: 9, color: "#475569" }}>← 0%    bet fraction   100% →</div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Tab: Option Chain (Tastytrade)
// ═══════════════════════════════════════════════════════════════════════════

interface Expiry   { expiration_date?: string; "expiration-date"?: string; }
interface Strike   {
  "strike-price"?: string; strike_price?: string;
  call?: ChainLeg; put?: ChainLeg;
}
interface ChainLeg {
  symbol?: string; delta?: string; gamma?: string;
  theta?: string; vega?: string; iv?: string;
  bid?: string; ask?: string;
}

function ChainTab() {
  const [ticker,   setTicker]   = useState("SPY");
  const [input,    setInput]    = useState("SPY");
  const [expiries, setExpiries] = useState<Expiry[]>([]);
  const [selExp,   setSelExp]   = useState("");
  const [strikes,  setStrikes]  = useState<Strike[]>([]);
  const [loading,  setLoading]  = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  const loadExpiries = useCallback(async (sym: string) => {
    setLoading(true); setError(null); setExpiries([]); setStrikes([]);
    try {
      const data = await tt({ action: "expirations", symbol: sym });
      const list: Expiry[] = Array.isArray(data) ? data : data?.items ?? [];
      setExpiries(list);
      const first = list[0]?.expiration_date ?? list[0]?.["expiration-date"] ?? "";
      setSelExp(first);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  const loadStrikes = useCallback(async () => {
    if (!ticker || !selExp) return;
    setLoading(true); setError(null);
    try {
      const data = await tt({ action: "chain", symbol: ticker, expiration: selExp });
      setStrikes(Array.isArray(data) ? data : data?.items ?? []);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [ticker, selExp]);

  useEffect(() => { if (ticker) loadExpiries(ticker); }, [ticker]);
  useEffect(() => { if (selExp) loadStrikes(); }, [selExp]);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center", flexWrap: "wrap" }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => e.key === "Enter" && setTicker(input)}
          placeholder="Ticker…"
          style={{ ...INPUT, width: 110 }}
        />
        <button onClick={() => setTicker(input)} style={{
          background: "rgba(6,182,212,0.15)", color: "#06b6d4",
          border: "1px solid rgba(6,182,212,0.3)", borderRadius: 6,
          padding: "6px 14px", fontSize: 12, cursor: "pointer",
        }}>Load Chain</button>
        {expiries.length > 0 && (
          <select value={selExp} onChange={(e) => setSelExp(e.target.value)} style={{ ...INPUT, cursor: "pointer" }}>
            {expiries.map((ex, i) => {
              const d = ex.expiration_date ?? ex["expiration-date"] ?? "";
              return <option key={i} value={d}>{fmtDate(d)}</option>;
            })}
          </select>
        )}
      </div>
      {loading && <Spinner />}
      {error   && <ErrorBox message={error} />}
      {!loading && !error && strikes.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                {["Call Bid","Call Ask","Call IV","Call Δ","Strike","Put Δ","Put IV","Put Bid","Put Ask"].map((h) => (
                  <th key={h} style={{ padding: "7px 8px", textAlign: "center", color: "#475569", fontWeight: 700, fontSize: 9 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {strikes.map((s, i) => {
                const strike = s["strike-price"] ?? s.strike_price ?? "—";
                const call   = s.call ?? {};
                const put    = s.put  ?? {};
                return (
                  <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)", background: i % 2 === 0 ? "transparent" : "rgba(255,255,255,0.015)" }}>
                    {[call.bid, call.ask, call.iv ? `${(parseFloat(call.iv)*100).toFixed(0)}%` : "—", call.delta].map((v, j) => (
                      <td key={j} style={{ padding: "7px 8px", textAlign: "center", color: "#10b981", fontFamily: "monospace" }}>{v ?? "—"}</td>
                    ))}
                    <td style={{ padding: "7px 8px", textAlign: "center", fontWeight: 700, color: "#e2e8f0", fontFamily: "monospace", background: "rgba(255,255,255,0.04)" }}>${strike}</td>
                    {[put.delta, put.iv ? `${(parseFloat(put.iv)*100).toFixed(0)}%` : "—", put.bid, put.ask].map((v, j) => (
                      <td key={j} style={{ padding: "7px 8px", textAlign: "center", color: "#ef4444", fontFamily: "monospace" }}>{v ?? "—"}</td>
                    ))}
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
// Tab: Alerts
// ═══════════════════════════════════════════════════════════════════════════

function AlertsTab() {
  return (
    <div style={{ textAlign: "center", padding: 48, color: "#475569" }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔔</div>
      <div style={{ fontSize: 14, color: "#64748b" }}>Telegram alerts configured via Vercel cron.</div>
      <div style={{ fontSize: 12, marginTop: 8, color: "#475569" }}>
        Alerts fire when Vol Arb signals BUY FRIENDLY or BUY VOL and flow confirms.
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Root App
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
    <div style={{
      minHeight: "100vh", background: "#0b0f1a", color: "#e2e8f0",
      fontFamily: "system-ui, -apple-system, sans-serif",
    }}>
      {/* Header */}
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", background: "rgba(255,255,255,0.02)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px 0" }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em", fontFamily: "'JetBrains Mono', monospace" }}>
              <span style={{ color: "#06b6d4" }}>◆</span> OPTIONS EDGE SCANNER
            </h1>
            <p style={{ margin: "3px 0 0", color: "#475569", fontSize: 11 }}>
              Unusual Whales Flow · Dark Pool · Vol Arb · Tastytrade Account · Kelly Sizing · Option Chain
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{
              background: "rgba(16,185,129,0.12)", color: "#10b981",
              border: "1px solid rgba(16,185,129,0.25)", padding: "2px 8px",
              borderRadius: 4, fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
            }}>LIVE</span>
            <div style={{
              width: 8, height: 8, borderRadius: "50%", background: "#10b981",
              boxShadow: "0 0 8px rgba(16,185,129,0.6)", animation: "pulse 2s ease-in-out infinite",
            }} />
            <style>{`@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }`}</style>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: "flex", gap: 0, overflowX: "auto", padding: "0 24px" }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "10px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer",
              background: "transparent", border: "none",
              borderBottom: tab === t.id ? "2px solid #06b6d4" : "2px solid transparent",
              color: tab === t.id ? "#06b6d4" : "#475569",
              letterSpacing: "0.03em", whiteSpace: "nowrap", transition: "all 0.15s",
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

      {/* Footer */}
      <div style={{
        padding: "12px 24px", borderTop: "1px solid rgba(255,255,255,0.05)",
        display: "flex", justifyContent: "space-between",
        color: "#334155", fontSize: 10,
      }}>
        <span>Options Edge Scanner v5 · Not financial advice · Read-only</span>
        <span>Tastytrade + Unusual Whales APIs</span>
      </div>
    </div>
  );
}
