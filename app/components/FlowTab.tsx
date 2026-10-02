"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { PaperTradeButton } from "@/app/components/PaperTradeButton";
import { formatContractCost, formatFlowPremium } from "@/app/lib/alertConfig";
import { arrangeFlowCards, type FlowSort, type RightFilter, type VerdictFilter } from "@/app/components/flowArrange";
import { defaultTimeStop, planExitsForAsk } from "@/app/lib/exits";
import { FLOW_DISCLAIMER, gateCheckHref, type FlowRow } from "@/app/lib/flow";
import { openInterestPasses, volumePasses } from "@/app/lib/gate";
import { formatLevelDistance, formatPrice } from "@/app/lib/levels";
import { MAX_BID_ASK_SPREAD_OF_MID, MAX_LOSS_DOLLARS } from "@/app/lib/risk";
import type { AlertVerdict } from "@/app/lib/verdict";

interface ScoredFlow extends FlowRow {
  verdict?: AlertVerdict;
  alertId?: string | null;
}

const INPUT: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  color: "#e2e8f0",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 15,
  outline: "none",
  fontFamily: "inherit",
};

export function FlowTab() {
  const [flows, setFlows] = useState<ScoredFlow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [reconnect, setReconnect] = useState("/api/schwab/connect");
  const [disclaimer, setDisclaimer] = useState(FLOW_DISCLAIMER);
  const [verdictNote, setVerdictNote] = useState("");
  const [dailyStop, setDailyStop] = useState(false);
  const [weeklyNote, setWeeklyNote] = useState<string | null>(null);
  const [partial, setPartial] = useState<string[]>([]);
  const [filters, setFilters] = useState({ ticker: "", minPremium: "50000", otmOnly: false, liquidOnly: true });
  const [verdictFilter, setVerdictFilter] = useState<VerdictFilter>("all");
  const [rightFilter, setRightFilter] = useState<RightFilter>("all");
  const [sort, setSort] = useState<FlowSort>("grade");

  const load = useCallback(async (fresh = false) => {
    setLoading(true);
    setError(null);
    setDisconnected(false);
    setPartial([]);
    try {
      const url = new URL("/api/flow", window.location.origin);
      if (filters.ticker) url.searchParams.set("ticker", filters.ticker);
      if (filters.minPremium) url.searchParams.set("minPremium", filters.minPremium);
      if (filters.otmOnly) url.searchParams.set("otmOnly", "true");
      if (!filters.liquidOnly) url.searchParams.set("liquidOnly", "false");
      if (fresh) url.searchParams.set("fresh", "true");
      url.searchParams.set("limit", "80");
      const res = await fetch(url.toString());
      const json = await res.json();
      if (typeof json.disclaimer === "string") setDisclaimer(json.disclaimer);
      setVerdictNote(typeof json.verdictBanner === "string" ? json.verdictBanner : "");
      setDailyStop(json.dailyStop === true);
      setWeeklyNote(typeof json.weeklyNote === "string" && json.weeklyNote ? json.weeklyNote : null);
      if (json.connected === false || res.status === 409 || res.status === 503) {
        setDisconnected(true);
        setReconnect(typeof json.reconnect === "string" ? json.reconnect : "");
        setError(typeof json.error === "string" ? json.error : "Schwab is not connected. Use Reconnect Schwab.");
        setFlows([]);
        return;
      }
      if (!res.ok || json.error) throw new Error(json.error || "Flow scan failed");
      setFlows(Array.isArray(json.data) ? json.data : []);
      const missed = Array.isArray(json.errors)
        ? json.errors.map((item: { ticker?: string }) => item.ticker).filter(Boolean)
        : [];
      setPartial(missed);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Flow scan failed");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { load(false); }, [load]);

  const visible = arrangeFlowCards(flows, { verdict: verdictFilter, right: rightFilter, sort });

  return (
    <div>
      <style>{`
        .flow-cards { display: grid; grid-template-columns: 1fr; gap: 16px; }
        .flow-sections { display: grid; grid-template-columns: 1fr; gap: 10px; }
        .flow-wide { grid-column: 1 / -1; }
        @media (min-width: 720px) {
          .flow-sections { grid-template-columns: 1fr 1fr; }
        }
        @media (min-width: 1100px) {
          .flow-cards { grid-template-columns: 1fr 1fr; }
        }
      `}</style>

      <p style={{ margin: "0 0 14px", color: "#94a3b8", fontSize: 15, lineHeight: 1.5 }}>{disclaimer}</p>
      {verdictNote && (
        <p style={{ margin: "0 0 14px", color: "#cbd5e1", fontSize: 15, lineHeight: 1.5 }}>{verdictNote}</p>
      )}
      {dailyStop && (
        <div style={{ background: "rgba(239,68,68,0.14)", border: "1px solid rgba(239,68,68,0.55)", borderRadius: 10, padding: "14px 16px", marginBottom: 14, color: "#fecaca", fontSize: 16, fontWeight: 700, lineHeight: 1.4 }}>
          STOP for today. Two closed trades lost in a row, so a setup that would have been TAKE shows STOP.
        </div>
      )}
      {weeklyNote && (
        <p style={{ margin: "0 0 14px", color: "#fbbf24", fontSize: 15, lineHeight: 1.45 }}>{weeklyNote}</p>
      )}

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <ControlGroup label="Verdict">
          <Segmented
            value={verdictFilter}
            options={[{ id: "all", label: "All" }, { id: "TAKE", label: "TAKE" }, { id: "WATCH", label: "WATCH" }]}
            onChange={setVerdictFilter}
          />
        </ControlGroup>
        <ControlGroup label="Sort">
          <select value={sort} onChange={(event) => setSort(event.target.value as FlowSort)} style={{ ...INPUT, cursor: "pointer" }} aria-label="Sort contracts">
            <option value="grade">Grade</option>
            <option value="notional">Flow premium</option>
            <option value="volOi">Vol/OI</option>
          </select>
        </ControlGroup>
        <ControlGroup label="Call or put">
          <Segmented
            value={rightFilter}
            options={[{ id: "all", label: "All" }, { id: "call", label: "Calls" }, { id: "put", label: "Puts" }]}
            onChange={setRightFilter}
          />
        </ControlGroup>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <input
          placeholder="Ticker"
          value={filters.ticker}
          aria-label="Ticker"
          onChange={(event) => setFilters({ ...filters, ticker: event.target.value.toUpperCase() })}
          style={{ ...INPUT, width: 120 }}
        />
        <select value={filters.minPremium} onChange={(event) => setFilters({ ...filters, minPremium: event.target.value })} style={{ ...INPUT, cursor: "pointer" }} aria-label="Minimum flow premium">
          <option value="0">Any flow premium</option>
          <option value="10000">$10K+ flow premium</option>
          <option value="50000">$50K+ flow premium</option>
          <option value="100000">$100K+ flow premium</option>
          <option value="500000">$500K+ flow premium</option>
          <option value="1000000">$1M+ flow premium</option>
        </select>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, color: "#94a3b8", cursor: "pointer" }}>
          <input type="checkbox" checked={filters.otmOnly} onChange={(event) => setFilters({ ...filters, otmOnly: event.target.checked })} />
          OTM only
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 15, color: "#94a3b8", cursor: "pointer" }}>
          <input type="checkbox" checked={filters.liquidOnly} onChange={(event) => setFilters({ ...filters, liquidOnly: event.target.checked })} />
          Liquid only
        </label>
        <button type="button" onClick={() => load(true)} style={quietButton}>Refresh</button>
      </div>

      {disconnected && (
        <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.35)", borderRadius: 10, padding: "16px 18px", marginBottom: 12 }}>
          <div style={{ color: "#fbbf24", fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{error}</div>
          {reconnect && <a href={reconnect} style={{ color: "#06b6d4", fontWeight: 700, fontSize: 15 }}>Reconnect Schwab</a>}
        </div>
      )}
      {loading && <Spinner />}
      {!disconnected && error && <ErrorBox message={error} onRetry={() => load(true)} />}
      {!loading && partial.length > 0 && (
        <p style={{ color: "#fbbf24", fontSize: 14, margin: "0 0 12px" }}>Some tickers did not load: {partial.join(", ")}</p>
      )}

      {!loading && !error && !disconnected && visible.length === 0 && (
        <p style={{ color: "#64748b", fontSize: 16, padding: "28px 0" }}>No contracts match these filters.</p>
      )}
      {!loading && !error && !disconnected && visible.length > 0 && (
        <div className="flow-cards">
          {visible.map((row) => <FlowCard key={row.id} row={row} />)}
        </div>
      )}
    </div>
  );
}

function FlowCard({ row }: { row: ScoredFlow }) {
  const verdict = row.verdict;
  const name = verdict?.verdict ?? "SKIP";
  const plan = verdict ? planExitsForAsk(row.ask, verdict.maxContracts) : null;
  const reason = verdict?.reasons[0] ?? "No checklist reason on this contract.";
  const isCall = row.putCall === "call";
  return (
    <article style={{
      background: "#111827",
      border: "1px solid rgba(255,255,255,0.08)",
      borderTop: `4px solid ${accent(name)}`,
      borderRadius: 12,
      padding: "18px 18px 14px",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div>
          <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1.1 }}>{row.ticker}</div>
          <div style={{ marginTop: 6, fontSize: 16, color: "#e2e8f0" }}>
            <span style={{ color: isCall ? "#34d399" : "#fca5a5", fontWeight: 700 }}>{isCall ? "CALL" : "PUT"}</span>
            {" "}${row.strike} · {shortDate(row.expiration)}
            {row.dte != null ? <span style={{ color: "#94a3b8" }}> · {row.dte}d</span> : null}
          </div>
          {row.alertId && (
            <div style={{ marginTop: 6, color: "#06b6d4", fontSize: 13, fontWeight: 700 }}>Alerted today</div>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <VerdictBadge name={name} label={verdict?.verdictLabel ?? "—"} />
          <span style={{ fontSize: 28, fontWeight: 700, fontFamily: "monospace", lineHeight: 1 }}>{verdict?.grade ?? "—"}</span>
        </div>
      </div>
      <p style={{ margin: "12px 0 16px", fontSize: 16, lineHeight: 1.45, color: "#e2e8f0" }}>{reason}</p>

      <div className="flow-sections">
        <Box title="Flow">
          <Fact label="Volume" value={count(row.volume)} />
          <Fact label="Open interest" value={count(row.openInterest)} />
          <Fact label="Vol/OI" value={row.volOiRatio == null ? "—" : `${row.volOiRatio.toFixed(2)}×`} />
          <Fact label="Flow premium" value={formatFlowPremium(row.notionalPremium)} />
          <Fact label="Side" value={sideText(row.side)} />
          <Fact label="Prints" value={printText(row)} />
        </Box>
        <Box title="Liquidity">
          <Mark label="Spread" pass={spreadPass(row)} value={row.spreadFraction == null ? "—" : `${(row.spreadFraction * 100).toFixed(1)}%`} />
          <Mark label="Open interest" pass={openInterestPasses(row.openInterest)} value={count(row.openInterest)} />
          <Mark label="Volume" pass={volumePasses(row.volume)} value={count(row.volume)} />
        </Box>
        <Box title="Levels">
          {verdict?.levels ? (
            <>
              <Fact label="Support" value={`${formatPrice(verdict.levels.supportPrice)} · ${formatLevelDistance(verdict.levels.supportDistance)} below`} />
              <div style={{ color: "#94a3b8", fontSize: 13, margin: "-2px 0 6px" }}>{verdict.levels.supportLabel}</div>
              <Fact label="Resistance" value={`${formatPrice(verdict.levels.resistancePrice)} · ${formatLevelDistance(verdict.levels.resistanceDistance)} above`} />
              <div style={{ color: "#94a3b8", fontSize: 13 }}>{verdict.levels.resistanceLabel}</div>
            </>
          ) : (
            <p style={{ margin: 0, color: "#94a3b8", fontSize: 14, lineHeight: 1.4 }}>{verdict?.levelsNote ?? "Support and resistance are not on this contract yet."}</p>
          )}
        </Box>
        <Box title="Events">
          <p style={{ margin: 0, color: "#e2e8f0", fontSize: 14, lineHeight: 1.45 }}>{verdict?.eventLine || "No earnings or macro note on this contract."}</p>
        </Box>
        <div className="flow-wide">
          <Box title="Trade plan">
            <Fact label={`Max under $${MAX_LOSS_DOLLARS}`} value={sizeText(verdict)} />
            <Fact label="Ask" value={price(row.ask)} />
            <Fact label="Cost / contract" value={formatContractCost(row.ask)} />
            <Fact label="Profit target" value={plan ? `${price(plan.profitPrice)} · take ${plan.takeContracts} off` : "—"} />
            <Fact label="Stop" value={plan ? `${price(plan.stopPrice)} · about ${compactDollars(plan.stopDollars)}` : "—"} />
            <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 14, lineHeight: 1.4 }}>{defaultTimeStop()}</p>
          </Box>
        </div>
      </div>

      <details style={{ marginTop: 12 }}>
        <summary style={{ cursor: "pointer", color: "#94a3b8", fontSize: 15, padding: "6px 0" }}>Details</summary>
        <div style={{ padding: "8px 0 4px", color: "#cbd5e1", fontSize: 14, lineHeight: 1.5 }}>
          {verdict && verdict.reasons.length > 1 && (
            <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>
              {verdict.reasons.slice(1).map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
          {verdict?.levelsNote && <p style={{ margin: "0 0 8px" }}>{verdict.levelsNote}</p>}
          <p style={{ margin: "0 0 8px" }}>{row.sideNote}</p>
          <p style={{ margin: "0 0 8px" }}>{row.prints?.summary ?? "No print was detected from Schwab quotes on this contract."}</p>
          <p style={{ margin: "0 0 8px" }}>
            IV {row.iv != null && row.iv > 0 ? `${(row.iv * 100).toFixed(0)}%` : "—"}
            {" · "}Vol jump {row.volumeJump == null ? "—" : signed(row.volumeJump)}
            {" · "}Score {Number.isFinite(row.score) ? Math.round(row.score) : "—"}
            {" · "}Bid {price(row.bid)} · Ask {price(row.ask)}
          </p>
          {plan && plan.lines.map((line) => <p key={line} style={{ margin: "0 0 6px" }}>{line}</p>)}
          {plan && <p style={{ margin: "0 0 8px", color: "#94a3b8" }}>{plan.note}</p>}
          {verdict?.suggestion && <p style={{ margin: "0 0 8px" }}>{verdict.suggestion}</p>}
          <a href={gateCheckHref(row)} style={{ color: "#06b6d4", fontWeight: 700 }}>Check in Gate</a>
        </div>
      </details>
      {(verdict?.grade === "A" || verdict?.grade === "B") && (
        <PaperTradeButton
          alertId={row.alertId ?? undefined}
          flow={{
            ticker: row.ticker,
            putCall: row.putCall,
            strike: row.strike,
            expiration: row.expiration,
            ask: row.ask,
            grade: verdict.grade,
            verdict: verdict.verdict,
            flowPremium: row.notionalPremium,
          }}
        />
      )}
    </article>
  );
}

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: "10px 12px" }}>
      <div style={{ fontSize: 12, letterSpacing: "0.06em", textTransform: "uppercase", color: "#64748b", fontWeight: 700, marginBottom: 8 }}>{title}</div>
      {children}
    </section>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 14, lineHeight: 1.45, marginBottom: 4 }}>
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span style={{ color: "#e2e8f0", textAlign: "right" }}>{value}</span>
    </div>
  );
}

function Mark({ label, pass, value }: { label: string; pass: boolean | null; value: string }) {
  const mark = pass == null ? "—" : pass ? "Pass" : "Fail";
  const color = pass == null ? "#94a3b8" : pass ? "#34d399" : "#f87171";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 14, lineHeight: 1.45, marginBottom: 4 }}>
      <span style={{ color: "#94a3b8" }}>{label}</span>
      <span style={{ textAlign: "right" }}>
        <span style={{ color: "#e2e8f0" }}>{value}</span>
        {" "}
        <span style={{ color, fontWeight: 700 }}>{mark}</span>
      </span>
    </div>
  );
}

function VerdictBadge({ name, label }: { name: string; label: string }) {
  const tone = name === "TAKE"
    ? { bg: "rgba(16,185,129,0.16)", text: "#34d399", border: "rgba(16,185,129,0.45)" }
    : name === "WATCH"
      ? { bg: "rgba(245,158,11,0.16)", text: "#fbbf24", border: "rgba(245,158,11,0.45)" }
      : name === "STOP"
        ? { bg: "rgba(239,68,68,0.16)", text: "#fca5a5", border: "rgba(239,68,68,0.5)" }
        : { bg: "rgba(100,116,139,0.16)", text: "#cbd5e1", border: "rgba(100,116,139,0.4)" };
  return (
    <span style={{
      background: tone.bg,
      color: tone.text,
      border: `1px solid ${tone.border}`,
      borderRadius: 999,
      padding: "6px 10px",
      fontSize: 13,
      fontWeight: 800,
      letterSpacing: "0.04em",
    }}>{label}</span>
  );
}

function ControlGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 12, color: "#64748b", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase" }}>{label}</span>
      {children}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: { id: T; label: string }[];
  onChange: (next: T) => void;
}) {
  return (
    <div style={{ display: "flex", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, overflow: "hidden" }}>
      {options.map((option) => {
        const on = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            onClick={() => onChange(option.id)}
            style={{
              background: on ? "rgba(255,255,255,0.1)" : "transparent",
              color: on ? "#e2e8f0" : "#94a3b8",
              border: "none",
              padding: "10px 14px",
              fontSize: 15,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >{option.label}</button>
        );
      })}
    </div>
  );
}

function Spinner() {
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: 48 }}>
      <div style={{
        width: 28,
        height: 28,
        border: "3px solid rgba(255,255,255,0.12)",
        borderTopColor: "#e2e8f0",
        borderRadius: "50%",
        animation: "oes-spin 0.75s linear infinite",
      }} />
    </div>
  );
}

function ErrorBox({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 10, padding: "14px 16px", marginBottom: 12 }}>
      <div style={{ color: "#fca5a5", fontSize: 15, marginBottom: 8 }}>{message}</div>
      <button type="button" onClick={onRetry} style={quietButton}>Retry</button>
    </div>
  );
}

const quietButton: React.CSSProperties = {
  background: "rgba(255,255,255,0.06)",
  color: "#e2e8f0",
  border: "1px solid rgba(255,255,255,0.12)",
  borderRadius: 8,
  padding: "10px 14px",
  fontSize: 15,
  cursor: "pointer",
};

function accent(name: string): string {
  if (name === "TAKE") return "#10b981";
  if (name === "WATCH") return "#f59e0b";
  if (name === "STOP") return "#ef4444";
  return "#64748b";
}

function spreadPass(row: ScoredFlow): boolean | null {
  if (row.spreadQuality === "unknown" || row.spreadFraction == null) return null;
  return row.spreadFraction <= MAX_BID_ASK_SPREAD_OF_MID;
}

function sizeText(verdict: AlertVerdict | undefined): string {
  if (!verdict || verdict.maxContracts == null) return "—";
  if (verdict.maxContracts < 1) return "None. One contract is over the cap.";
  const word = verdict.maxContracts === 1 ? "contract" : "contracts";
  return `${verdict.maxContracts} ${word}`;
}

function printText(row: ScoredFlow): string {
  const prints = row.prints;
  if (!prints?.summary) return "None detected";
  if (prints.sweepLike) return "Sweep-like, from Schwab quotes";
  if (prints.block) return "Block, from Schwab quotes";
  return "Print, from Schwab quotes";
}

function sideText(side: FlowRow["side"]): string {
  if (side === "estimated at ask") return "At the ask";
  if (side === "estimated at bid") return "At the bid";
  if (side === "estimated mid") return "Between bid and ask";
  return "Unknown";
}

function count(value: number): string {
  return Number.isFinite(value) ? Math.round(value).toLocaleString("en-US") : "—";
}

function price(value: number): string {
  return Number.isFinite(value) && value > 0 ? `$${value.toFixed(2)}` : "—";
}

function compactDollars(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function signed(value: number): string {
  const rounded = Math.round(value);
  return `${rounded > 0 ? "+" : ""}${rounded.toLocaleString("en-US")}`;
}

function shortDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return value;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const month = months[Number(match[2]) - 1] ?? match[2];
  return `${month} ${Number(match[3])}`;
}
