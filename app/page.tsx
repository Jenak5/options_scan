"use client";

import { useState, useEffect, useMemo, useCallback } from "react";

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

function Badge({ children, color }: { children: React.ReactNode; color: string }) {
  const c: Record<string, { bg: string; text: string; border: string }> = {
    green: { bg: "rgba(16,185,129,0.12)", text: "#10b981", border: "rgba(16,185,129,0.25)" },
    red: { bg: "rgba(239,68,68,0.12)", text: "#ef4444", border: "rgba(239,68,68,0.25)" },
    amber: { bg: "rgba(245,158,11,0.12)", text: "#f59e0b", border: "rgba(245,158,11,0.25)" },
    blue: { bg: "rgba(59,130,246,0.12)", text: "#3b82f6", border: "rgba(59,130,246,0.25)" },
    purple: { bg: "rgba(168,85,247,0.12)", text: "#a855f7", border: "rgba(168,85,247,0.25)" },
    cyan: { bg: "rgba(6,182,212,0.12)", text: "#06b6d4", border: "rgba(6,182,212,0.25)" },
  };
  const s = c[color] || c.blue;
  return <span style={{ background: s.bg, color: s.text, border: `1px solid ${s.border}`, padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 600, letterSpacing: "0.03em", whiteSpace: "nowrap" }}>{children}</span>;
}

function MiniBar({ value, max, color = "#06b6d4" }: { value: number; max: number; color?: string }) {
  return (
    <div style={{ width: 60, height: 6, background: "rgba(255,255,255,0.06)", borderRadius: 3, overflow: "hidden" }}>
      <div style={{ width: `${Math.min(Math.abs(value) / max * 100, 100)}%`, height: "100%", background: color, borderRadius: 3 }} />
    </div>
  );
}

function StatCard({ label, value, color = "#e2e8f0" }: { label: string; value: string; color?: string }) {
  return (
    <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: "12px 16px" }}>
      <div style={{ color: "#64748b", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
      <div style={{ color, fontSize: 20, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace", marginTop: 4 }}>{value}</div>
    </div>
  );
}

function LoadingSpinner() {
  return <div style={{ display: "flex", justifyContent: "center", padding: 40 }}><div style={{ width: 32, height: 32, border: "3px solid rgba(255,255,255,0.1)", borderTopColor: "#06b6d4", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} /></div>;
}

function ErrorMsg({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, padding: 16, textAlign: "center" }}>
      <div style={{ color: "#ef4444", fontSize: 13, marginBottom: 8 }}>{message}</div>
      {onRetry && <button onClick={onRetry} style={{ background: "rgba(239,68,68,0.15)", color: "#ef4444", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 6, padding: "6px 16px", fontSize: 12, cursor: "pointer" }}>Retry</button>}
    </div>
  );
}

function FlowTab() {
  const [flows, setFlows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState({ ticker: "", sweepsOnly: false, minPremium: "50000", otmOnly: false });

  const loadFlows = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params: Record<string, string> = { action: "flow", limit: "50", min_premium: filters.minPremium };
      if (filters.ticker) params.ticker = filters.ticker;
      if (filters.sweepsOnly) params.is_sweep = "true";
      if (filters.otmOnly) params.is_otm = "true";
      setFlows(await uw(params));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [filters]);

  useEffect(() => { loadFlows(); }, [loadFlows]);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input placeholder="Filter ticker..." value={filters.ticker} onChange={(e) => setFilters({ ...filters, ticker: e.target.value.toUpperCase() })} style={{ background: "rgba(255,255,255,0.06)", color: "#e2e8f0", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "6px 12px", fontSize: 13, outline: "none", width: 140 }} />
        <select value={filters.minPremium} onChange={(e) => setFilters({ ...filters, minPremium: e.target.value })}>
          <option value="10000">$10K+ Premium</option>
          <option value="50000">$50K+ Premium</option>
          <option value="100000">$100K+ Premium</option>
          <option value="500000">$500K+ Premium</option>
          <option value="1000000">$1M+ Premium</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#94a3b8", cursor: "pointer" }}>
          <input type="checkbox" checked={filters.sweepsOnly} onChange={(e) => setFilters({ ...filters, sweepsOnly: e.target.checked })} style={{ accentColor: "#06b6d4" }} /> Sweeps Only
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "#94a3b8", cursor: "pointer" }}>
          <input type="checkbox" checked={filters.otmOnly} onChange={(e) => setFilters({ ...filters, otmOnly: e.target.checked })} style={{ accentColor: "#06b6d4" }} /> OTM Only
        </label>
        <button onClick={loadFlows} style={{ background: "#06b6d4", color: "#0f172a", border: "none", borderRadius: 6, padding: "6px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Refresh</button>
      </div>
      {loading && <LoadingSpinner />}
      {error && <ErrorMsg message={error} onRetry={loadFlows} />}
      {!loading && !error && (
        <div style={{ overflowX: "auto" }}>
          <table><thead><tr>
            {["Ticker", "Type", "Strike", "Exp", "Premium", "Vol", "OI", "IV", "Flags", "Time"].map(h => <th key={h}>{h}</th>)}
          </tr></thead><tbody>
            {flows.map((f: any, i: number) => {
              const prem = parseFloat(f.total_premium) || 0;
              const iv = parseFloat(f.iv_start) || 0;
              const volOi = parseFloat(f.volume_oi_ratio) || 0;
              const price = parseFloat(f.underlying_price) || 0;
              const strike = parseFloat(f.strike) || 0;
              const isOtm = f.type === "call" ? strike > price : strike < price;
              return (
                <tr key={i}>
                  <td style={{ fontWeight: 600, color: "#e2e8f0" }}>{f.ticker}</td>
                  <td><Badge color={f.type === "call" ? "green" : "red"}>{f.type === "call" ? "CALL" : "PUT"}</Badge></td>
                  <td>${f.strike}</td>
                  <td>{f.expiry}</td>
                  <td style={{ fontWeight: 600, color: prem >= 500000 ? "#f59e0b" : "#e2e8f0" }}>${(prem / 1000).toFixed(0)}K</td>
                  <td>{f.volume?.toLocaleString()}</td>
                  <td>{f.open_interest?.toLocaleString()}</td>
                  <td>{(iv * 100).toFixed(1)}%</td>
                  <td><div style={{ display: "flex", gap: 4 }}>
                    {f.has_sweep && <Badge color="amber">SWEEP</Badge>}
                    {f.has_floor && <Badge color="purple">FLOOR</Badge>}
                    {f.has_multileg && <Badge color="blue">MULTI</Badge>}
                    {isOtm && <Badge color="purple">OTM</Badge>}
                    {volOi > 1 && <Badge color="cyan">NEW</Badge>}
                  </div></td>
                  <td style={{ fontSize: 11, color: "#64748b" }}>{new Date(f.created_at).toLocaleTimeString()}</td>
                </tr>
              );
            })}
          </tbody></table>
          {flows.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "#64748b" }}>No flow alerts match your filters</div>}
        </div>
      )}
    </div>
  );
}

function DarkPoolTab() {
  const [prints, setPrints] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ticker, setTicker] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params: Record<string, string> = { action: "darkpool" };
      if (ticker) params.ticker = ticker;
      setPrints(await uw(params));
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [ticker]);

  useEffect(() => { load(); }, [load]);

  const totalNotional = useMemo(() => prints.reduce((s, p) => {
    const px = parseFloat(p.price) || 0;
    const sz = parseFloat(p.size) || parseFloat(p.volume) || 0;
    return s + (px * sz || parseFloat(p.notional) || 0);
  }, 0), [prints]);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <input placeholder="Filter ticker..." value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} style={{ background: "rgba(255,255,255,0.06)", color: "#e2e8f0", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "6px 12px", fontSize: 13, outline: "none", width: 140 }} />
        <button onClick={load} style={{ background: "#06b6d4", color: "#0f172a", border: "none", borderRadius: 6, padding: "6px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Refresh</button>
        {prints.length > 0 && <span style={{ fontSize: 12, color: "#64748b", marginLeft: "auto" }}>{prints.length} prints · ${(totalNotional / 1_000_000).toFixed(1)}M total</span>}
      </div>
      {loading && <LoadingSpinner />}
      {error && <ErrorMsg message={error} onRetry={load} />}
      {!loading && !error && (
        <div style={{ overflowX: "auto" }}>
          <table><thead><tr>{["Ticker", "Price", "Size", "Notional", "Type", "Time"].map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{prints.slice(0, 100).map((p: any, i: number) => {
            const px = parseFloat(p.price) || 0;
            const sz = parseFloat(p.size) || parseFloat(p.volume) || 0;
            const notional = px * sz || parseFloat(p.notional) || 0;
            return (
              <tr key={i}>
                <td style={{ fontWeight: 600, color: "#e2e8f0" }}>{p.ticker}</td>
                <td>${px.toFixed(2)}</td>
                <td>{sz.toLocaleString()}</td>
                <td style={{ fontWeight: 600, color: notional >= 1_000_000 ? "#f59e0b" : "#e2e8f0" }}>${(notional / 1000).toFixed(0)}K</td>
                <td><Badge color="blue">{p.tracking_type || p.trade_type || "BLOCK"}</Badge></td>
                <td style={{ fontSize: 11, color: "#64748b" }}>{new Date(p.executed_at || p.created_at).toLocaleTimeString()}</td>
              </tr>
            );
          })}</tbody></table>
        </div>
      )}
    </div>
  );
}

function AccountTab() {
  const [positions, setPositions] = useState<any[]>([]);
  const [balances, setBalances] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [pos, bal] = await Promise.all([tt({ action: "positions" }), tt({ action: "balances" })]);
      setPositions(pos); setBalances(bal);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const fmt = (v: any) => {
    if (!v) return "$0";
    const n = typeof v === "string" ? parseFloat(v) : v;
    return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  };

  return (
    <div>
      {loading && <LoadingSpinner />}
      {error && <ErrorMsg message={error} onRetry={load} />}
      {!loading && !error && <>
        {balances && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginBottom: 24 }}>
            <StatCard label="Net Liq Value" value={fmt(balances["net-liquidating-value"])} color="#06b6d4" />
            <StatCard label="Cash Balance" value={fmt(balances["cash-balance"])} color="#10b981" />
            <StatCard label="Equity BP" value={fmt(balances["equity-buying-power"])} color="#e2e8f0" />
            <StatCard label="Options BP" value={fmt(balances["derivative-buying-power"])} color="#a855f7" />
            <StatCard label="Day Trade BP" value={fmt(balances["day-trading-buying-power"])} color="#f59e0b" />
            <StatCard label="Maint Req" value={fmt(balances["maintenance-requirement"])} color="#ef4444" />
          </div>
        )}
        <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>Open Positions ({positions.length})</h3>
        <div style={{ overflowX: "auto" }}>
          <table><thead><tr>{["Symbol", "Type", "Qty", "Avg Cost", "Current", "P&L"].map(h => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>{positions.map((p: any, i: number) => {
            const qty = p.quantity * (p["quantity-direction"] === "Short" ? -1 : 1);
            const pnl = (p["close-price"] - p["average-open-price"]) * Math.abs(qty) * (p.multiplier || 1);
            return (
              <tr key={i}>
                <td style={{ fontWeight: 600, color: "#e2e8f0" }}>{p.symbol}</td>
                <td><Badge color="blue">{p["instrument-type"]}</Badge></td>
                <td style={{ color: qty > 0 ? "#10b981" : "#ef4444" }}>{qty > 0 ? "+" : ""}{qty}</td>
                <td>{fmt(p["average-open-price"])}</td>
                <td>{fmt(p["close-price"])}</td>
                <td style={{ fontWeight: 600, color: pnl >= 0 ? "#10b981" : "#ef4444" }}>{pnl >= 0 ? "+" : ""}{fmt(pnl)}</td>
              </tr>
            );
          })}</tbody></table>
          {positions.length === 0 && <div style={{ textAlign: "center", padding: 40, color: "#64748b" }}>No open positions</div>}
        </div>
      </>}
    </div>
  );
}

function VolArbTab() {
  const [metrics, setMetrics] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setMetrics(await tt({ action: "metrics", symbols: "SPY,QQQ,AAPL,TSLA,NVDA,AMZN,META" })); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <p style={{ color: "#94a3b8", fontSize: 13, marginBottom: 16 }}>IV vs Realized Vol — overpriced = sell premium, underpriced = buy premium.</p>
      {loading && <LoadingSpinner />}
      {error && <ErrorMsg message={error} onRetry={load} />}
      {!loading && !error && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 12 }}>
          {metrics.map((m: any, i: number) => {
            const iv = (m["implied-volatility-index"] || m["implied-volatility"] || 0) * 100;
            const hv = (m["historical-volatility-index"] || m["historical-volatility"] || 0) * 100;
            const spread = iv - hv;
            const signal = spread > 5 ? "SELL VOL" : spread < -5 ? "BUY VOL" : "NEUTRAL";
            return (
              <div key={i} style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                  <span style={{ fontWeight: 700, fontSize: 16 }}>{m.symbol}</span>
                  <Badge color={signal === "SELL VOL" ? "red" : signal === "BUY VOL" ? "green" : "blue"}>{signal}</Badge>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8 }}>
                  <div><div style={{ color: "#64748b", fontSize: 10, textTransform: "uppercase" }}>IV</div><div style={{ fontSize: 18, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{iv.toFixed(1)}%</div></div>
                  <div><div style={{ color: "#64748b", fontSize: 10, textTransform: "uppercase" }}>HV</div><div style={{ fontSize: 18, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{hv.toFixed(1)}%</div></div>
                  <div><div style={{ color: "#64748b", fontSize: 10, textTransform: "uppercase" }}>Spread</div><div style={{ color: spread > 5 ? "#ef4444" : spread < -5 ? "#10b981" : "#94a3b8", fontSize: 18, fontWeight: 700, fontFamily: "'JetBrains Mono', monospace" }}>{spread > 0 ? "+" : ""}{spread.toFixed(1)}</div></div>
                </div>
                {m["iv-rank"] !== undefined && (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#64748b", marginBottom: 3 }}><span>IV Rank</span><span>{(m["iv-rank"] * 100).toFixed(0)}%</span></div>
                    <div style={{ height: 4, background: "rgba(255,255,255,0.08)", borderRadius: 2 }}><div style={{ width: `${m["iv-rank"] * 100}%`, height: "100%", background: m["iv-rank"] > 0.5 ? "#f59e0b" : "#3b82f6", borderRadius: 2 }} /></div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function KellyTab() {
  const [winProb, setWinProb] = useState(55);
  const [winAmt, setWinAmt] = useState(200);
  const [lossAmt, setLossAmt] = useState(100);
  const [bankroll, setBankroll] = useState(10000);
  const [fraction, setFraction] = useState(0.25);

  const b = lossAmt > 0 ? winAmt / lossAmt : 0;
  const fullKelly = lossAmt > 0 ? Math.max(0, Math.min(((winProb / 100) * b - (1 - winProb / 100)) / b, 1)) : 0;
  const adjKelly = fullKelly * fraction;
  const positionSize = bankroll * adjKelly;
  const ev = (winProb / 100) * winAmt - (1 - winProb / 100) * lossAmt;

  const curve = useMemo(() => {
    const pts = [];
    for (let f = 0; f <= 1; f += 0.02) {
      const g = (winProb / 100) * Math.log(1 + f * (winAmt / Math.max(lossAmt, 1))) + (1 - winProb / 100) * Math.log(Math.max(1 - f, 0.001));
      pts.push({ f: Math.round(f * 100), g: isFinite(g) ? g : -2 });
    }
    return pts;
  }, [winProb, winAmt, lossAmt]);

  const maxG = Math.max(...curve.map(p => p.g));
  const minG = Math.min(...curve.filter(p => p.g > -2).map(p => p.g));

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(280px, 320px) 1fr", gap: 20 }}>
      <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 20 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>Parameters</h3>
        {[
          { label: "Win Probability", value: winProb, set: setWinProb, min: 1, max: 99, suffix: "%" },
          { label: "Win Amount ($)", value: winAmt, set: setWinAmt, min: 1, max: 10000, suffix: "" },
          { label: "Loss Amount ($)", value: lossAmt, set: setLossAmt, min: 1, max: 10000, suffix: "" },
          { label: "Bankroll ($)", value: bankroll, set: setBankroll, min: 100, max: 100000, suffix: "" },
        ].map(({ label, value, set, min, max, suffix }) => (
          <div key={label} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <label style={{ color: "#94a3b8", fontSize: 12 }}>{label}</label>
              <span style={{ color: "#e2e8f0", fontSize: 12, fontWeight: 600, fontFamily: "'JetBrains Mono', monospace" }}>{value.toLocaleString()}{suffix}</span>
            </div>
            <input type="range" min={min} max={max} value={value} onChange={(e) => set(Number(e.target.value))} style={{ width: "100%" }} />
          </div>
        ))}
        <div style={{ marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <label style={{ color: "#94a3b8", fontSize: 12 }}>Kelly Fraction</label>
            <span style={{ color: "#e2e8f0", fontSize: 12, fontWeight: 600 }}>{fraction}x</span>
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            {[0.125, 0.25, 0.5, 0.75, 1].map(f => (
              <button key={f} onClick={() => setFraction(f)} style={{ flex: 1, padding: "6px 0", borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: "pointer", background: fraction === f ? "#06b6d4" : "rgba(255,255,255,0.06)", color: fraction === f ? "#0f172a" : "#94a3b8", border: fraction === f ? "1px solid #06b6d4" : "1px solid rgba(255,255,255,0.08)" }}>
                {f === 1 ? "Full" : `${f}x`}
              </button>
            ))}
          </div>
        </div>
        <div style={{ borderTop: "1px solid rgba(255,255,255,0.08)", paddingTop: 16, marginTop: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <StatCard label="Full Kelly" value={`${(fullKelly * 100).toFixed(1)}%`} color="#f59e0b" />
            <StatCard label="Adj Kelly" value={`${(adjKelly * 100).toFixed(1)}%`} color="#06b6d4" />
            <StatCard label="Position Size" value={`$${Math.round(positionSize).toLocaleString()}`} color="#10b981" />
            <StatCard label="Expected Value" value={`$${ev.toFixed(2)}`} color={ev > 0 ? "#10b981" : "#ef4444"} />
          </div>
        </div>
      </div>
      <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 20 }}>
        <h3 style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Kelly Growth Curve</h3>
        <p style={{ color: "#64748b", fontSize: 11, marginBottom: 16 }}>Peak = optimal Kelly · Beyond = ruin risk</p>
        <svg viewBox="0 0 600 280" style={{ width: "100%" }}>
          {[0, 0.25, 0.5, 0.75, 1].map(f => <g key={f}><line x1={60 + f * 520} y1={20} x2={60 + f * 520} y2={250} stroke="rgba(255,255,255,0.05)" /><text x={60 + f * 520} y={268} fill="#475569" fontSize={10} textAnchor="middle">{Math.round(f * 100)}%</text></g>)}
          <path d={curve.map((p, i) => { const x = 60 + (p.f / 100) * 520; const range = maxG - minG || 1; const y = 250 - ((p.g - minG) / range) * 220; return `${i === 0 ? "M" : "L"}${x},${isFinite(y) ? Math.max(20, Math.min(250, y)) : 250}`; }).join(" ")} fill="none" stroke="#06b6d4" strokeWidth={2.5} />
          {fullKelly > 0 && fullKelly < 1 && <g><line x1={60 + fullKelly * 520} y1={20} x2={60 + fullKelly * 520} y2={250} stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4,4" /><text x={60 + fullKelly * 520} y={14} fill="#f59e0b" fontSize={10} textAnchor="middle">Kelly {(fullKelly * 100).toFixed(0)}%</text></g>}
          {adjKelly > 0 && <line x1={60 + adjKelly * 520} y1={20} x2={60 + adjKelly * 520} y2={250} stroke="#10b981" strokeWidth={1.5} strokeDasharray="2,4" />}
        </svg>
      </div>
    </div>
  );
}

function ChainTab() {
  const [ticker, setTicker] = useState("SPY");
  const [chain, setChain] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try { setChain(await tt({ action: "chain", symbol: ticker })); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }, [ticker]);

  return (
    <div>
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <input value={ticker} onChange={(e) => setTicker(e.target.value.toUpperCase())} placeholder="Enter ticker..." style={{ background: "rgba(255,255,255,0.06)", color: "#e2e8f0", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "6px 12px", fontSize: 13, outline: "none", width: 140, fontFamily: "'JetBrains Mono', monospace" }} onKeyDown={(e) => e.key === "Enter" && load()} />
        <button onClick={load} style={{ background: "#06b6d4", color: "#0f172a", border: "none", borderRadius: 6, padding: "6px 16px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>Load Chain</button>
      </div>
      {loading && <LoadingSpinner />}
      {error && <ErrorMsg message={error} onRetry={load} />}
      {!loading && !error && chain && chain.expirations?.slice(0, 4).map((exp: any, ei: number) => (
        <div key={ei} style={{ marginBottom: 20 }}>
          <h4 style={{ color: "#06b6d4", fontSize: 13, marginBottom: 8, fontWeight: 600 }}>{exp["expiration-date"]} · {exp["days-to-expiration"]} DTE <Badge color="blue">{exp["expiration-type"]}</Badge></h4>
          <div style={{ overflowX: "auto" }}>
            <table><thead><tr><th>Strike</th><th>Call</th><th>Put</th></tr></thead>
            <tbody>{exp.strikes?.slice(0, 15).map((s: any, si: number) => (
              <tr key={si}>
                <td style={{ fontWeight: 600 }}>${s["strike-price"]}</td>
                <td style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>{s["call-streamer-symbol"] || s.call}</td>
                <td style={{ fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>{s["put-streamer-symbol"] || s.put}</td>
              </tr>
            ))}</tbody></table>
          </div>
        </div>
      ))}
      {!loading && !error && !chain && <div style={{ textAlign: "center", padding: 60, color: "#64748b" }}>Enter a ticker and click Load Chain</div>}
    </div>
  );
}

function AlertsTab() {
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const testAlert = async () => {
    setLoading(true); setStatus(null);
    try {
      const res = await fetch("/api/alerts?action=test");
      const json = await res.json();
      setStatus(json.success ? "✅ Test alert sent to Telegram!" : `❌ ${json.message}`);
    } catch (e: any) { setStatus(`❌ ${e.message}`); }
    finally { setLoading(false); }
  };

  const scanNow = async () => {
    setLoading(true); setStatus(null);
    try {
      const res = await fetch("/api/alerts?action=scan");
      const json = await res.json();
      setStatus(`✅ Scanned ${json.scanned} flows · Sent ${json.alerts_sent} alerts`);
    } catch (e: any) { setStatus(`❌ ${e.message}`); }
    finally { setLoading(false); }
  };

  return (
    <div>
      <div style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: 24, maxWidth: 600 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>📱 Telegram Alerts</h3>
        <p style={{ color: "#94a3b8", fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>
          Get high-conviction flow alerts sent directly to your Telegram. The scanner runs automatically every 5 minutes during market hours via Vercel Cron.
        </p>
        <div style={{ marginBottom: 20 }}>
          <h4 style={{ color: "#e2e8f0", fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Setup Steps:</h4>
          <div style={{ color: "#94a3b8", fontSize: 13, lineHeight: 2 }}>
            1. Message <span style={{ color: "#06b6d4", fontFamily: "'JetBrains Mono', monospace" }}>@BotFather</span> on Telegram, send <span style={{ color: "#06b6d4", fontFamily: "'JetBrains Mono', monospace" }}>/newbot</span><br />
            2. Copy the bot token → add as <span style={{ color: "#06b6d4", fontFamily: "'JetBrains Mono', monospace" }}>TELEGRAM_BOT_TOKEN</span> in Vercel<br />
            3. Start a chat with your bot → send <span style={{ color: "#06b6d4", fontFamily: "'JetBrains Mono', monospace" }}>/start</span><br />
            4. Visit <span style={{ color: "#06b6d4", fontFamily: "'JetBrains Mono', monospace" }}>api.telegram.org/bot{"<TOKEN>"}/getUpdates</span> to find your chat_id<br />
            5. Add <span style={{ color: "#06b6d4", fontFamily: "'JetBrains Mono', monospace" }}>TELEGRAM_CHAT_ID</span> in Vercel env vars
          </div>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={testAlert} disabled={loading} style={{ background: "#06b6d4", color: "#0f172a", border: "none", borderRadius: 6, padding: "10px 20px", fontSize: 13, fontWeight: 600, cursor: loading ? "wait" : "pointer", opacity: loading ? 0.6 : 1 }}>
            {loading ? "Sending..." : "🧪 Send Test Alert"}
          </button>
          <button onClick={scanNow} disabled={loading} style={{ background: "rgba(255,255,255,0.06)", color: "#e2e8f0", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 6, padding: "10px 20px", fontSize: 13, fontWeight: 600, cursor: loading ? "wait" : "pointer", opacity: loading ? 0.6 : 1 }}>
            {loading ? "Scanning..." : "⊕ Scan & Alert Now"}
          </button>
        </div>
        {status && <div style={{ marginTop: 16, padding: 12, borderRadius: 6, background: status.startsWith("✅") ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)", border: `1px solid ${status.startsWith("✅") ? "rgba(16,185,129,0.2)" : "rgba(239,68,68,0.2)"}`, fontSize: 13, color: status.startsWith("✅") ? "#10b981" : "#ef4444" }}>{status}</div>}
      </div>
    </div>
  );
}

const TABS = [
  { id: "flow", label: "⊕ Flow" },
  { id: "darkpool", label: "◈ Dark Pool" },
  { id: "volArb", label: "◇ Vol Arb" },
  { id: "account", label: "⊞ Account" },
  { id: "kelly", label: "△ Kelly Lab" },
  { id: "chain", label: "≡ Chain" },
  { id: "alerts", label: "📱 Alerts" },
];

export default function OptionsEdgeScanner() {
  const [tab, setTab] = useState("flow");

  return (
    <div style={{ minHeight: "100vh" }}>
      <div style={{ padding: "20px 24px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 20, fontWeight: 700, letterSpacing: "-0.02em", fontFamily: "'JetBrains Mono', monospace" }}>
              <span style={{ color: "#06b6d4" }}>◆</span> OPTIONS EDGE SCANNER
            </h1>
            <p style={{ margin: "4px 0 0", color: "#475569", fontSize: 11 }}>Flow · Dark Pool · Vol Arb · Account · Kelly · Chain · Telegram Alerts</p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <Badge color="cyan">LIVE</Badge>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#10b981", boxShadow: "0 0 8px rgba(16,185,129,0.5)", animation: "pulse 2s ease-in-out infinite" }} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 0, overflowX: "auto" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{ padding: "10px 18px", fontSize: 12, fontWeight: 600, cursor: "pointer", background: "transparent", border: "none", borderBottom: tab === t.id ? "2px solid #06b6d4" : "2px solid transparent", color: tab === t.id ? "#06b6d4" : "#64748b", letterSpacing: "0.03em", whiteSpace: "nowrap", transition: "all 0.2s" }}>
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding: 24 }}>
        {tab === "flow" && <FlowTab />}
        {tab === "darkpool" && <DarkPoolTab />}
        {tab === "volArb" && <VolArbTab />}
        {tab === "account" && <AccountTab />}
        {tab === "kelly" && <KellyTab />}
        {tab === "chain" && <ChainTab />}
        {tab === "alerts" && <AlertsTab />}
      </div>
      <div style={{ padding: "16px 24px", borderTop: "1px solid rgba(255,255,255,0.06)", display: "flex", justifyContent: "space-between", color: "#334155", fontSize: 10 }}>
        <span>Options Edge Scanner v1.0 · Not financial advice · Read-only</span>
        <span>Tastytrade + Unusual Whales + Telegram</span>
      </div>
    </div>
  );
}
