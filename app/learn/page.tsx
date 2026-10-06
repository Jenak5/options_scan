"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PageLinks } from "@/app/components/PageLinks";

interface Bucket {
  key: string;
  label: string;
  count: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  totalPnl: number;
  averagePnl: number | null;
  tooFew: boolean;
}

interface Factor {
  id: string;
  label: string;
  cuts: string;
  included: number;
  excludedUnknown: number;
  buckets: Bucket[];
  winRateGap: number | null;
  tooFew: boolean;
  rank: number;
}

interface Trade {
  id: string;
  source: "shadow" | "paper" | "test";
  ticker: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  gradeLabel: string;
  exitReason: string;
  exitDetail: string;
  pnlDollars: number;
  pnlFraction: number | null;
  result: "win" | "loss" | "flat";
  maxFavorablePct: number | null;
  maxAdversePct: number | null;
  marksSeen: number;
  markNote: string;
  features: {
    flowPremium: number | null;
    volOiRatio: number | null;
    volumeJump: number | null;
    flowSignalCount: number | null;
    spreadFraction: number | null;
    iv: number | null;
    dte: number | null;
    earnings: string;
    side: string | null;
    capturedAtAlert: boolean;
  };
}

interface Freshness {
  lastScan: string;
  lastShadow: string;
}

interface Page {
  stored: boolean;
  freshness?: Freshness;
  estimateNote: string;
  resolved: number;
  testResolved: number;
  testOpen: number;
  tooFew: boolean;
  summary: string[];
  suggestions: string[];
  suggestionNote: string;
  checksNote: string;
  whatIf: {
    note: string;
    pathNote: string;
    included: number;
    skipped: number;
    scenarios: Array<{
      id: string;
      label: string;
      resolved: number;
      unresolved: number;
      wins: number;
      losses: number;
      flats: number;
      winRate: number | null;
      averageWin: number | null;
      averageLoss: number | null;
      totalPnl: number;
      tooFew: boolean;
    }>;
  };
  factors: Factor[];
  unavailable: Array<{ id: string; label: string; excludedUnknown: number }>;
  trades: Trade[];
}

export default function LearnPage() {
  const [page, setPage] = useState<Page | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/learn")
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Learning mode failed");
        setPage(json as Page);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Learning mode failed"));
  }, []);

  const empty = page != null && page.resolved === 0 && page.testResolved === 0;

  return (
    <main style={{ minHeight: "100vh", background: "#0b0f1a", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "16px 16px 14px" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontFamily: "monospace" }}>
          <span style={{ color: "#06b6d4" }}>▣</span> Learning mode
        </h1>
        <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 15, lineHeight: 1.45 }}>
          Which stored factors show up more often on winners than on losers. Read-only. Nothing here places an order or changes a rule.
        </p>
        <PageLinks current="learn" />
      </div>

      <div style={{ padding: "16px 16px 48px", maxWidth: 880, margin: "0 auto" }}>
        {error && <Note color="#fca5a5">{error}</Note>}
        {page && !page.stored && (
          <Note color="#fbbf24">The private store is not configured, so there is nothing to learn from yet. It uses the same store as the alert book.</Note>
        )}
        {page && (
          <>
            {page.freshness && (
              <p style={{ margin: "0 0 12px", color: "#cbd5e1", fontSize: 14, lineHeight: 1.45 }}>
                {page.freshness.lastScan}
                <span style={{ color: "#64748b" }}> · </span>
                {page.freshness.lastShadow}
              </p>
            )}
            <Note color="#94a3b8">{page.estimateNote}</Note>
            {page.tooFew && page.resolved > 0 && (
              <Note color="#fbbf24">Fewer than 30 resolved results is too few to trust.</Note>
            )}

            <section style={cardStyle}>
              <h2 style={heading}>What the data says so far</h2>
              {page.summary.map((line) => <p key={line} style={prose}>{line}</p>)}
              {empty && (
                <p style={prose}>
                  An A or a B becomes a shadow after it is saved. A paper trade counts once it is closed. The 43–60 day test is separate and is not an A or a B.
                </p>
              )}
            </section>

            {page.whatIf && (
              <section style={cardStyle}>
                <h2 style={heading}>Exit what-ifs</h2>
                <Note color="#94a3b8">{page.whatIf.note}</Note>
                <p style={prose}>{page.whatIf.pathNote}</p>
                <p style={prose}>
                  {page.whatIf.included} shadow{page.whatIf.included === 1 ? "" : "s"} with a stored quote path.
                  {page.whatIf.skipped > 0 ? ` ${page.whatIf.skipped} left out because the path was not stored.` : ""}
                  {" "}A row under 30 resolved results is too few to trust. The live exit rules are unchanged.
                </p>
                {page.whatIf.scenarios.map((row) => (
                  <div key={row.id} style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid rgba(255,255,255,0.06)" }}>
                    <p style={{ ...prose, fontWeight: 700 }}>{row.label}</p>
                    <p style={prose}>
                      {row.resolved} resolved ({row.wins} wins, {row.losses} losses{row.flats ? `, ${row.flats} flat` : ""}).
                      {row.unresolved > 0 ? ` ${row.unresolved} still open under this rule, so they are not in the totals.` : ""}
                      {" "}Win rate {row.winRate == null ? "n/a" : rate(row.winRate)}.
                      {" "}Total P/L {signed(row.totalPnl)}.
                      {row.tooFew ? " Too few to trust." : ""}
                    </p>
                  </div>
                ))}
              </section>
            )}

            <section style={{ ...cardStyle, borderColor: "rgba(251,191,36,0.35)" }}>
              <h2 style={{ ...heading, color: "#fbbf24" }}>Rules to consider</h2>
              <Note color="#fbbf24">{page.suggestionNote}</Note>
              {page.suggestions.map((line) => <p key={line} style={prose}>{line}</p>)}
            </section>

            <h2 style={{ ...heading, margin: "18px 0 8px" }}>Factors, widest gap first</h2>
            {page.factors.length === 0 && (
              <p style={prose}>No factor has a resolved result yet. Buckets appear after a shadow or a paper trade closes.</p>
            )}
            {page.factors.map((factor) => (
              <section key={factor.id} style={cardStyle}>
                <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>
                  {factor.rank}. {factor.label}
                </h3>
                <p style={{ ...prose, color: "#94a3b8" }}>{factor.cuts}</p>
                <p style={prose}>
                  {factor.included} included.
                  {factor.excludedUnknown > 0 ? ` ${factor.excludedUnknown} left out because the field is unknown.` : ""}
                  {factor.winRateGap == null ? " Not enough buckets to compare." : ` Win-rate gap ${(factor.winRateGap * 100).toFixed(1)} percentage points.`}
                  {factor.tooFew ? " Too few to trust." : ""}
                </p>
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                    <thead>
                      <tr>
                        {["Bucket", "Count", "Win rate", "Avg win", "Avg loss", "Total P/L", "Avg P/L", "Sample"].map((label) => (
                          <th key={label} style={thStyle}>{label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {factor.buckets.map((bucket) => (
                        <tr key={bucket.key}>
                          <td style={tdStyle}>{bucket.label}</td>
                          <td style={tdStyle}>{bucket.count} ({bucket.wins}-{bucket.losses}{bucket.flats ? `-${bucket.flats}` : ""})</td>
                          <td style={tdStyle}>{bucket.winRate == null ? "n/a" : rate(bucket.winRate)}</td>
                          <td style={tdStyle}>{bucket.averageWin == null ? "n/a" : signed(bucket.averageWin)}</td>
                          <td style={tdStyle}>{bucket.averageLoss == null ? "n/a" : signed(-bucket.averageLoss)}</td>
                          <td style={{ ...tdStyle, color: pnlColor(bucket.totalPnl) }}>{signed(bucket.totalPnl)}</td>
                          <td style={tdStyle}>{bucket.averagePnl == null ? "n/a" : signed(bucket.averagePnl)}</td>
                          <td style={{ ...tdStyle, color: bucket.tooFew ? "#fbbf24" : "#94a3b8" }}>{bucket.tooFew ? "Too few to trust" : "30 or more"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}

            {page.unavailable.length > 0 && (
              <section style={cardStyle}>
                <h2 style={heading}>Not ranked</h2>
                <p style={prose}>{page.checksNote}</p>
                <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
                  {page.unavailable.map((item) => (
                    <li key={item.id} style={prose}>
                      {item.label}: {item.excludedUnknown} unknown, so this factor is left out.
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginTop: 8 }}>
              <h2 style={{ ...heading, margin: 0 }}>Why it ended</h2>
              <a href="/api/learn?format=csv" style={{ color: "#06b6d4", fontWeight: 700, fontSize: 15 }}>Download feature CSV</a>
            </div>
            <p style={prose}>Open a row to see the exit and the best and worst stored marks. A losing alert is the same list.</p>
            {page.trades.length === 0 && <p style={prose}>No closed results yet.</p>}
            {page.trades.map((trade) => (
              <details key={trade.id} style={{ ...cardStyle, padding: "10px 14px" }}>
                <summary style={{ cursor: "pointer", fontSize: 15 }}>
                  <span style={{ color: pnlColor(trade.pnlDollars), fontWeight: 700 }}>{signed(trade.pnlDollars)}</span>
                  {" "}{trade.ticker} {trade.putCall === "put" ? "put" : "call"} {trade.strike} · {trade.gradeLabel} · {sourceLabel(trade.source)}
                </summary>
                <div style={{ marginTop: 8 }}>
                  <p style={prose}>{trade.exitDetail}</p>
                  <p style={prose}>{trade.markNote}</p>
                  <p style={prose}>
                    Best mark {trade.maxFavorablePct == null ? "unknown" : percent(trade.maxFavorablePct)}.
                    {" "}Worst mark {trade.maxAdversePct == null ? "unknown" : percent(trade.maxAdversePct)}.
                    {trade.pnlFraction == null ? "" : ` Exit ${percent(trade.pnlFraction)}.`}
                  </p>
                  <p style={{ ...prose, color: "#94a3b8" }}>
                    Flow premium {moneyOrUnknown(trade.features.flowPremium)}.
                    {" "}Vol/OI {trade.features.volOiRatio == null ? "unknown" : `${trade.features.volOiRatio.toFixed(2)}×`}.
                    {" "}Signals {trade.features.flowSignalCount == null ? "unknown" : String(trade.features.flowSignalCount)}.
                    {" "}Spread {trade.features.spreadFraction == null ? "unknown" : rate(trade.features.spreadFraction)}.
                    {" "}IV {trade.features.iv == null ? "unknown" : rate(trade.features.iv <= 3 ? trade.features.iv : trade.features.iv / 100)}.
                    {" "}DTE {trade.features.dte == null ? "unknown" : String(trade.features.dte)}.
                    {" "}Earnings {trade.features.earnings}.
                    {" "}{trade.features.capturedAtAlert ? "Saved at alert time." : "Recovered from stored fields. Missing inputs stay unknown."}
                  </p>
                </div>
              </details>
            ))}
          </>
        )}
      </div>
    </main>
  );
}

function sourceLabel(source: Trade["source"]): string {
  if (source === "paper") return "Paper trade";
  if (source === "test") return "Test: 43-60 DTE";
  return "Shadow alert";
}

function Note({ children, color }: { children: ReactNode; color: string }) {
  return <p style={{ margin: "0 0 12px", color, fontSize: 15, lineHeight: 1.45 }}>{children}</p>;
}

function moneyOrUnknown(value: number | null): string {
  if (value == null) return "unknown";
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

function signed(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

function rate(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function percent(fraction: number): string {
  const sign = fraction > 0 ? "+" : "";
  return `${sign}${(fraction * 100).toFixed(1)}%`;
}

function pnlColor(value: number | null): string {
  if (value == null || Math.abs(value) < 0.005) return "#e2e8f0";
  return value > 0 ? "#10b981" : "#fca5a5";
}

const heading: React.CSSProperties = { margin: "0 0 8px", fontSize: 16, color: "#cbd5e1" };
const prose: React.CSSProperties = { margin: "0 0 8px", fontSize: 15, lineHeight: 1.45 };
const cardStyle: React.CSSProperties = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: 12,
  padding: "14px 16px",
  marginBottom: 12,
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  color: "#64748b",
  fontSize: 12,
  fontWeight: 700,
  padding: "8px 8px 8px 0",
  borderBottom: "1px solid rgba(255,255,255,0.08)",
  whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  padding: "8px 8px 8px 0",
  borderBottom: "1px solid rgba(255,255,255,0.05)",
  verticalAlign: "top",
  lineHeight: 1.35,
};
