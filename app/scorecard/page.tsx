"use client";

import { useEffect, useState, type ReactNode } from "react";
import { PageLinks } from "@/app/components/PageLinks";

interface Bucket {
  key: string;
  closed: number;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  pnlDollars: number;
}

interface Row {
  id: string;
  ticker: string;
  putCall: "call" | "put";
  grade: "A" | "B";
  strike: number;
  expiration: string;
  status: "open" | "closed";
  exitLabel: string;
  exitPrice: number | null;
  exitQuote: "mid" | "bid" | null;
  exitStale: boolean;
  pnlDollars: number | null;
  pnlFraction: number | null;
  tradingDaysHeld: number | null;
  unrealizedPnl: number | null;
  counted: boolean;
  countNote: string | null;
}

interface Scorecard {
  stored: boolean;
  estimateNote: string;
  sampleNote: string;
  resolved: number;
  open: number;
  excludedPaper: number;
  unpriced: number;
  tooFew: boolean;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  totalPnl: number;
  byGrade: Bucket[];
  byTicker: Bucket[];
  byRight: Bucket[];
  rows: Row[];
}

export default function ScorecardPage() {
  const [page, setPage] = useState<Scorecard | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/scorecard")
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Scorecard failed");
        setPage(json as Scorecard);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "Scorecard failed"));
  }, []);

  return (
    <main style={{ minHeight: "100vh", background: "#0b0f1a", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "16px 16px 14px" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontFamily: "monospace" }}>
          <span style={{ color: "#06b6d4" }}>▣</span> Alert scorecard
        </h1>
        <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 15, lineHeight: 1.45 }}>
          One contract at the alert ask for every A or B, whether or not you paper-trade it. This is separate from the Trade Log. Nothing here places an order.
        </p>
        <PageLinks current="scorecard" />
      </div>

      <div style={{ padding: "16px 16px 40px", maxWidth: 880, margin: "0 auto" }}>
        {error && <Note color="#fca5a5">{error}</Note>}
        {page && !page.stored && (
          <Note color="#fbbf24">The private store is not configured, so shadow alerts cannot be saved. It uses the same store as the alert book.</Note>
        )}
        {page && (
          <>
            <Note color="#94a3b8">{page.estimateNote}</Note>
            <Note color={page.tooFew ? "#fbbf24" : "#94a3b8"}>{page.sampleNote}</Note>
            {page.excludedPaper > 0 && (
              <Note color="#94a3b8">
                {page.excludedPaper} alert{page.excludedPaper === 1 ? " is" : "s are"} already in the Trade Log, so {page.excludedPaper === 1 ? "it is" : "they are"} left out of these totals.
              </Note>
            )}
            {page.unpriced > 0 && (
              <Note color="#94a3b8">
                {page.unpriced} closed with no quote, so {page.unpriced === 1 ? "it is" : "they are"} left out of the win rate.
              </Note>
            )}

            <section style={cardStyle}>
              <h2 style={heading}>Overall</h2>
              <Stats
                closed={page.resolved}
                open={page.open}
                winRate={page.winRate}
                averageWin={page.averageWin}
                averageLoss={page.averageLoss}
                totalPnl={page.totalPnl}
                wins={page.wins}
                losses={page.losses}
                flats={page.flats}
              />
            </section>

            <h2 style={{ ...heading, margin: "18px 0 8px" }}>A and B</h2>
            <div className="grade-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {page.byGrade.map((bucket) => <BucketCard key={bucket.key} bucket={bucket} title={`Grade ${bucket.key}`} />)}
            </div>

            <h2 style={{ ...heading, margin: "18px 0 8px" }}>Call and put</h2>
            <div className="grade-grid" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              {page.byRight.map((bucket) => <BucketCard key={bucket.key} bucket={bucket} title={bucket.key === "put" ? "Put" : "Call"} />)}
            </div>

            <h2 style={{ ...heading, margin: "18px 0 8px" }}>By ticker</h2>
            {page.byTicker.length === 0 && <p style={{ color: "#94a3b8", fontSize: 15 }}>No resolved alerts yet.</p>}
            <div style={{ display: "grid", gap: 10 }}>
              {page.byTicker.map((bucket) => <BucketCard key={bucket.key} bucket={bucket} title={bucket.key} />)}
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginTop: 22 }}>
              <h2 style={{ ...heading, margin: 0 }}>Recent alerts</h2>
              <a href="/api/scorecard?format=csv" style={{ color: "#06b6d4", fontWeight: 700, fontSize: 15 }}>Download CSV</a>
            </div>
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead>
                  <tr>
                    {["Ticker", "Right", "Grade", "Status", "Exit", "Price", "P/L", "P/L %", "Days", "Counted"].map((label) => (
                      <th key={label} style={thStyle}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.length === 0 && (
                    <tr>
                      <td colSpan={10} style={{ ...tdStyle, color: "#94a3b8" }}>No shadow alerts yet. An A or a B saved in the alert book shows up here on the next scan.</td>
                    </tr>
                  )}
                  {page.rows.map((row) => {
                    const pnl = row.status === "closed" ? row.pnlDollars : row.unrealizedPnl;
                    const pct = row.status === "closed" ? row.pnlFraction : null;
                    return (
                      <tr key={row.id}>
                        <td style={tdStyle}>{row.ticker}</td>
                        <td style={tdStyle}>{row.putCall === "put" ? "Put" : "Call"}</td>
                        <td style={tdStyle}>{row.grade}</td>
                        <td style={tdStyle}>{row.status === "open" ? "Open" : "Closed"}</td>
                        <td style={tdStyle}>
                          {row.exitLabel || "n/a"}
                          {row.exitStale ? " Last quote." : ""}
                          {row.exitQuote ? ` ${row.exitQuote === "mid" ? "Mid" : "Bid"}.` : ""}
                        </td>
                        <td style={tdStyle}>{row.exitPrice == null ? "n/a" : money(row.exitPrice)}</td>
                        <td style={{ ...tdStyle, color: pnlColor(pnl) }}>{pnl == null ? "n/a" : `${row.status === "open" ? "open " : ""}${signed(pnl)}`}</td>
                        <td style={{ ...tdStyle, color: pnlColor(pct) }}>{pct == null ? "n/a" : percent(pct)}</td>
                        <td style={tdStyle}>{row.tradingDaysHeld == null ? "n/a" : String(row.tradingDaysHeld)}</td>
                        <td style={tdStyle}>{row.counted ? "Yes" : "No"}{row.countNote ? `. ${row.countNote}` : ""}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <style>{`@media (max-width: 560px) { .grade-grid { grid-template-columns: 1fr !important; } }`}</style>
    </main>
  );
}

function Stats(props: {
  closed: number;
  open: number;
  winRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  totalPnl: number;
  wins: number;
  losses: number;
  flats: number;
}) {
  return (
    <div>
      <Stat label="Resolved" value={String(props.closed)} />
      <Stat label="Open" value={String(props.open)} />
      <Stat label="Wins" value={String(props.wins)} />
      <Stat label="Losses" value={String(props.losses)} />
      <Stat label="Flat" value={String(props.flats)} />
      <Stat label="Win rate" value={props.winRate == null ? "n/a" : percent(props.winRate)} />
      <Stat label="Average win" value={props.averageWin == null ? "n/a" : signed(props.averageWin)} />
      <Stat label="Average loss" value={props.averageLoss == null ? "n/a" : signed(-props.averageLoss)} />
      <Stat label="Total P/L" value={props.closed === 0 ? "n/a" : signed(props.totalPnl)} />
    </div>
  );
}

function BucketCard({ bucket, title }: { bucket: Bucket; title: string }) {
  return (
    <section style={cardStyle}>
      <h3 style={{ margin: "0 0 4px", fontSize: 18 }}>{title}</h3>
      <Stat label="Resolved" value={String(bucket.closed)} />
      <Stat label="Win rate" value={bucket.winRate == null ? "n/a" : percent(bucket.winRate)} />
      <Stat label="Average win" value={bucket.averageWin == null ? "n/a" : signed(bucket.averageWin)} />
      <Stat label="Average loss" value={bucket.averageLoss == null ? "n/a" : signed(-bucket.averageLoss)} />
      <Stat label="Total P/L" value={bucket.closed === 0 ? "n/a" : signed(bucket.pnlDollars)} />
    </section>
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

function Note({ children, color }: { children: ReactNode; color: string }) {
  return (
    <p style={{ margin: "0 0 12px", color, fontSize: 15, lineHeight: 1.45 }}>{children}</p>
  );
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function signed(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

function percent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function pnlColor(value: number | null): string {
  if (value == null || Math.abs(value) < 0.005) return "#e2e8f0";
  return value > 0 ? "#10b981" : "#fca5a5";
}

const heading: React.CSSProperties = { margin: "0 0 8px", fontSize: 16, color: "#cbd5e1" };

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
