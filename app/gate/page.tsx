"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { SchwabBanner } from "@/app/components/SchwabBanner";
import type { OptionContract } from "@/app/lib/contract";
import type { GateCheck } from "@/app/lib/gate";
import { formatLevelsSummary } from "@/app/lib/levels";
import { defaultProfitRule, defaultTimeStop, type ExitPlan } from "@/app/lib/exits";
import type { AlertVerdict } from "@/app/lib/verdict";
import {
  ACCOUNT_SIZE_DOLLARS,
  MAX_BID_ASK_SPREAD_OF_MID,
  MAX_LOSS_DOLLARS,
  MIN_CONTRACT_VOLUME,
  MIN_OPEN_INTEREST,
} from "@/app/lib/risk";

interface GateResponse {
  overall: "PASS" | "NO";
  checks: GateCheck[];
  singleContractExceedsCap: boolean;
  suggestion: string | null;
  maxLoss: number | null;
  contract: OptionContract | null;
  verdict?: AlertVerdict | null;
  dailyStop?: boolean;
  weeklyNote?: string | null;
  exits?: ExitPlan | null;
  exitDefaults?: string;
  error?: string;
  reconnect?: string;
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

export default function GatePage() {
  const [ticker, setTicker] = useState("SPY");
  const [expiration, setExpiration] = useState("");
  const [strike, setStrike] = useState("");
  const [putCall, setPutCall] = useState<"call" | "put">("call");
  const [contracts, setContracts] = useState("1");
  const [plannedEntry, setPlannedEntry] = useState("");
  const [debitSpreadWidth, setDebitSpreadWidth] = useState("");
  const [underlyingStop, setUnderlyingStop] = useState("");
  const [timeStop, setTimeStop] = useState(defaultTimeStop);
  const [profitRule, setProfitRule] = useState(defaultProfitRule);
  const [statusNote, setStatusNote] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reconnect, setReconnect] = useState<string | null>(null);
  const [result, setResult] = useState<GateResponse | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const nextTicker = params.get("ticker");
    if (nextTicker && /^[A-Za-z][A-Za-z0-9.\-]{0,9}$/.test(nextTicker)) setTicker(nextTicker.toUpperCase());
    const nextExpiration = params.get("expiration");
    if (nextExpiration && /^\d{4}-\d{2}-\d{2}$/.test(nextExpiration)) setExpiration(nextExpiration);
    const nextStrike = params.get("strike");
    if (nextStrike && Number.isFinite(Number(nextStrike)) && Number(nextStrike) > 0) setStrike(nextStrike);
    const nextRight = params.get("putCall");
    if (nextRight === "put" || nextRight === "call") setPutCall(nextRight);
    const nextEntry = params.get("plannedEntry");
    if (nextEntry && Number.isFinite(Number(nextEntry)) && Number(nextEntry) > 0) setPlannedEntry(nextEntry);
  }, []);

  useEffect(() => {
    fetch("/api/trades")
      .then((res) => res.json())
      .then((json) => {
        const bits: string[] = [];
        if (json.stop?.dailyStop) bits.push(`Daily stop is on. ${json.stop.consecutiveLosses} closed losses in a row today.`);
        if (typeof json.weeklyNote === "string" && json.weeklyNote) bits.push(json.weeklyNote);
        setStatusNote(bits.length > 0 ? bits.join(" ") : null);
      })
      .catch(() => setStatusNote(null));
  }, [result]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setReconnect(null);
    setResult(null);
    try {
      const res = await fetch("/api/gate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          expiration,
          strike: numberOrBlank(strike),
          putCall,
          contracts: numberOrBlank(contracts),
          plannedEntry: numberOrBlank(plannedEntry),
          debitSpreadWidth: debitSpreadWidth.trim() === "" ? null : numberOrBlank(debitSpreadWidth),
          underlyingStop,
          timeStop,
          profitRule,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setReconnect(typeof json.reconnect === "string" ? json.reconnect : null);
        throw new Error(typeof json.error === "string" ? json.error : "Gate request failed");
      }
      setResult(json as GateResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gate request failed");
    } finally {
      setPending(false);
    }
  }

  const spreadPct = Math.round(MAX_BID_ASK_SPREAD_OF_MID * 100);

  return (
    <main style={{ minHeight: "100vh", background: "#0b0f1a", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <style dangerouslySetInnerHTML={{ __html: `
        .gate-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 20px; }
        .gate-check { display: grid; grid-template-columns: 88px 160px 1fr; gap: 10px; align-items: baseline; }
        @media (max-width: 640px) {
          .gate-form { grid-template-columns: 1fr; }
          .gate-check { grid-template-columns: 72px 1fr; }
        }
      ` }} />
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "16px 24px", display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 20, fontFamily: "monospace" }}>
            <span style={{ color: "#06b6d4" }}>▣</span> Trade gate
          </h1>
          <p style={{ margin: "4px 0 0", color: "#64748b", fontSize: 14 }}>
            ${ACCOUNT_SIZE_DOLLARS.toLocaleString()} account · max loss ${MAX_LOSS_DOLLARS} · read-only Schwab quotes
          </p>
        </div>
        <a href="/" style={{ color: "#06b6d4", fontSize: 14, alignSelf: "center" }}>Back to scanner</a>
      </div>

      <div style={{ padding: 24, maxWidth: 760 }}>
        <SchwabBanner />

        {statusNote && (
          <div style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.28)", borderRadius: 8, padding: "10px 14px", marginBottom: 12, color: "#fbbf24", fontSize: 14 }}>
            {statusNote}
          </div>
        )}

        <p style={{ color: "#94a3b8", fontSize: 14, lineHeight: 1.5, marginTop: 0 }}>
          Open interest at least {MIN_OPEN_INTEREST}, volume at least {MIN_CONTRACT_VOLUME} today,
          bid-ask spread at most {spreadPct}% of mid, and max loss at most ${MAX_LOSS_DOLLARS}.
          A long option uses contracts × ask × 100. A debit spread uses contracts × strike width × 100,
          which is the most that spread can be worth. Any failed check is an overall NO.
          Two losing closes in a row, from the trade log, stop the day. There is no weekly loss limit.
        </p>

        <form onSubmit={onSubmit} className="gate-form">
          <Field label="Ticker">
            <input value={ticker} onChange={(e) => setTicker(e.target.value)} style={INPUT} />
          </Field>
          <Field label="Expiration">
            <input type="date" value={expiration} onChange={(e) => setExpiration(e.target.value)} style={{ ...INPUT, colorScheme: "dark" }} />
          </Field>
          <Field label="Strike">
            <input value={strike} onChange={(e) => setStrike(e.target.value)} inputMode="decimal" style={INPUT} />
          </Field>
          <Field label="Call or put">
            <select value={putCall} onChange={(e) => setPutCall(e.target.value === "put" ? "put" : "call")} style={INPUT}>
              <option value="call">Call</option>
              <option value="put">Put</option>
            </select>
          </Field>
          <Field label="Contracts">
            <input value={contracts} onChange={(e) => setContracts(e.target.value)} inputMode="numeric" style={INPUT} />
          </Field>
          <Field label="Planned entry">
            <input value={plannedEntry} onChange={(e) => setPlannedEntry(e.target.value)} inputMode="decimal" style={INPUT} />
          </Field>
          <Field label="Debit spread width (points, optional)">
            <input value={debitSpreadWidth} onChange={(e) => setDebitSpreadWidth(e.target.value)} inputMode="decimal" placeholder="Blank for a single option" style={INPUT} />
          </Field>
          <Field label="Underlying stop" wide>
            <input value={underlyingStop} onChange={(e) => setUnderlyingStop(e.target.value)} placeholder="Exit if the underlying trades through…" style={INPUT} />
          </Field>
          <Field label="Time stop" wide>
            <input value={timeStop} onChange={(e) => setTimeStop(e.target.value)} placeholder="Out by…" style={INPUT} />
          </Field>
          <Field label="Profit-taking rule" wide>
            <input value={profitRule} onChange={(e) => setProfitRule(e.target.value)} placeholder="Take it off when…" style={INPUT} />
          </Field>
          <div style={{ gridColumn: "1 / -1" }}>
            <button type="submit" disabled={pending} style={{
              background: "rgba(6,182,212,0.15)",
              color: "#06b6d4",
              border: "1px solid rgba(6,182,212,0.35)",
              borderRadius: 6,
              padding: "10px 16px",
              fontSize: 15,
              fontWeight: 700,
              cursor: pending ? "wait" : "pointer",
              opacity: pending ? 0.6 : 1,
            }}>
              {pending ? "Checking the chain…" : "Run gate"}
            </button>
          </div>
        </form>

        {error && (
          <div style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "12px 14px", marginBottom: 16, color: "#fca5a5" }}>
            {error}
            {reconnect && (
              <div style={{ marginTop: 8 }}>
                <a href={reconnect} style={{ color: "#06b6d4" }}>Reconnect Schwab</a>
              </div>
            )}
          </div>
        )}

        {result && (
          <section>
            {result.verdict && (
              <div style={{
                background: "rgba(6,182,212,0.06)",
                border: "1px solid rgba(6,182,212,0.25)",
                borderRadius: 8,
                padding: "12px 14px",
                marginBottom: 14,
              }}>
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 6 }}>
                  <span style={{ fontFamily: "monospace", fontWeight: 800, fontSize: 22, color: "#e2e8f0" }}>
                    {result.verdict.grade} · {result.verdict.verdictLabel}
                  </span>
                </div>
                <div style={{ color: "#a5f3fc", fontSize: 13, marginBottom: 8 }}>{result.verdict.note}</div>
                <ul style={{ margin: 0, paddingLeft: 18, color: "#cbd5e1", fontSize: 14, lineHeight: 1.45 }}>
                  {result.verdict.reasons.map((reason) => <li key={reason}>{reason}</li>)}
                </ul>
                {result.verdict.levels && (
                  <div style={{ color: "#e2e8f0", fontSize: 14, marginTop: 8 }}>{formatLevelsSummary(result.verdict.levels)}</div>
                )}
                {result.verdict.levelsNote && (
                  <div style={{ color: "#94a3b8", fontSize: 13, marginTop: 8 }}>{result.verdict.levelsNote}</div>
                )}
                {result.verdict.eventLine && (
                  <div style={{ color: "#fbbf24", fontSize: 13, marginTop: 8 }}>{result.verdict.eventLine}</div>
                )}
              </div>
            )}
            {result.exits && (
              <div style={{ color: "#94a3b8", fontSize: 13, marginBottom: 14, lineHeight: 1.45 }}>
                {result.exits.lines.map((line) => <div key={line}>{line}</div>)}
                <div style={{ color: "#64748b", marginTop: 4 }}>{result.exits.note}</div>
              </div>
            )}
            <div style={{
              fontSize: 28,
              fontWeight: 800,
              fontFamily: "monospace",
              color: result.overall === "PASS" ? "#10b981" : "#ef4444",
              marginBottom: 8,
            }}>
              {result.overall}
            </div>
            {result.maxLoss != null && (
              <div style={{ color: "#94a3b8", fontSize: 14, marginBottom: 8 }}>
                Position max loss ${result.maxLoss.toFixed(2)} · cap ${MAX_LOSS_DOLLARS.toFixed(2)}
              </div>
            )}
            {result.suggestion && (
              <div style={{ background: "rgba(245,158,11,0.1)", border: "1px solid rgba(245,158,11,0.35)", color: "#fbbf24", borderRadius: 8, padding: "10px 12px", marginBottom: 12, fontSize: 14 }}>
                {result.suggestion}
              </div>
            )}
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {result.checks.map((check) => (
                <li key={check.id} className="gate-check" style={{
                  background: "rgba(255,255,255,0.03)",
                  border: "1px solid rgba(255,255,255,0.06)",
                  borderRadius: 8,
                  padding: "10px 12px",
                }}>
                  <span style={{ fontFamily: "monospace", fontWeight: 800, color: check.status === "PASS" ? "#10b981" : "#ef4444" }}>
                    {check.status}
                  </span>
                  <span style={{ fontWeight: 700 }}>{check.label}</span>
                  <span style={{ color: "#94a3b8", fontSize: 14 }}>{check.detail}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  );
}

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6, gridColumn: wide ? "1 / -1" : undefined }}>
      <span style={{ fontSize: 12, color: "#64748b", fontWeight: 700, letterSpacing: "0.04em" }}>{label}</span>
      {children}
    </label>
  );
}

function numberOrBlank(value: string): number | "" {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : "";
}
