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
  openingLabel?: string | null;
}

interface ExperimentRow extends Omit<Row, "grade"> {
  grade: "A" | "B" | "test";
  experimentLabel: string | null;
  probeNote: string | null;
  expiryType?: "0DTE" | "1DTE" | "weekly" | null;
  entryWindow?: string | null;
  levelLinedUp?: boolean | null;
  spyDay?: "up" | "down" | "flat" | null;
  noContract?: boolean;
  pnl60?: number | null;
  pnlFlat?: number | null;
}

interface PaperBucket {
  key: string;
  label: string;
  trades: number;
  open: number;
  noContract: number;
  closed60: number;
  wins60: number;
  losses60: number;
  winRate60: number | null;
  totalPnl60: number;
  closedFlat: number;
  winsFlat: number;
  lossesFlat: number;
  winRateFlat: number | null;
  totalPnlFlat: number;
}

interface JgBucket {
  key: string;
  label: string;
  trades: number;
  open: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnl: number;
  pnlWithoutTop3: number | null;
  maxDrawdownDollars: number;
  maxDrawdownVsAccount: number;
}

interface JgRow {
  id: string;
  ticker: string;
  root: string;
  putCall: "call" | "put";
  strike: number;
  expiration: string;
  contracts: number;
  overBudget: boolean;
  status: "open" | "closed";
  exitReason: "stop" | "flat" | null;
  pnlDollars: number | null;
}

interface JgSection {
  label: string;
  note: string;
  trustNote: string;
  tooFew: boolean;
  budgetDollars: number;
  accountDollars: number;
  buckets: JgBucket[];
  rows: JgRow[];
}

interface Experiment {
  label: string;
  note: string;
  trustNote: string;
  resolved: number;
  open: number;
  tooFew: boolean;
  wins: number;
  losses: number;
  flats: number;
  winRate: number | null;
  averageWin: number | null;
  averageLoss: number | null;
  totalPnl: number;
  rows: ExperimentRow[];
  byExpiry?: PaperBucket[];
  byLevel?: PaperBucket[];
}

interface Freshness {
  lastScan: string;
  lastShadow: string;
}

interface CandleCoverage {
  candlesLastRun: string | null;
  candleAlertsCovered: number;
  candleErrors: number;
  note: string;
}

interface Scorecard {
  stored: boolean;
  freshness?: Freshness;
  candles?: CandleCoverage | null;
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
  experimental?: Experiment;
  experimentalShort?: Experiment;
  experimentalEarnings?: Experiment;
  vwapPuts?: Experiment;
  timeStop60?: Experiment;
  jgVwap?: JgSection | null;
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
            {page.freshness && (
              <p style={{ margin: "0 0 12px", color: "#cbd5e1", fontSize: 14, lineHeight: 1.45 }}>
                {page.freshness.lastScan}
                <span style={{ color: "#64748b" }}> · </span>
                {page.freshness.lastShadow}
              </p>
            )}
            <Note color="#94a3b8">{page.estimateNote}</Note>
            {page.candles?.note && <Note color="#94a3b8">{page.candles.note}</Note>}
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

            {page.experimental && (
              <ExperimentPanel
                section={page.experimental}
                empty="No test shadows yet. A contract already in a scanned chain, with 43 to 60 days to expiry, is recorded here when the other rules would have made it an A or a B."
                fallbackLabel="Test: 43-60 DTE"
              />
            )}
            {page.experimentalShort && (
              <ExperimentPanel
                section={page.experimentalShort}
                empty="No test shadows yet. A contract already in a scanned chain, with 1 to 13 days to expiry, is recorded here when the other rules would have made it an A or a B. 0 DTE is not included."
                fallbackLabel="Test: 1-13 DTE"
              />
            )}
            {page.experimentalEarnings && (
              <ExperimentPanel
                section={page.experimentalEarnings}
                empty="No rows yet. A saved A or B is tracked here when earnings are 1 to 14 calendar days ahead and still inside the hold, before the last week. A contract the earnings downgrade kept out of A and B can be tracked here on paper. Nothing in this group is a new alert."
                fallbackLabel="Earnings in window"
              />
            )}
            {page.vwapPuts && (
              <ExperimentPanel
                section={page.vwapPuts}
                empty="No paper puts yet. A name is recorded here after 15 completed minutes close below session VWAP and the next minute trades up to VWAP and closes back below it."
                fallbackLabel="Paper - backtested VWAP put rule"
              />
            )}
            {page.timeStop60 && (
              <ExperimentPanel
                section={page.timeStop60}
                empty="No 60-minute shadows yet. Each saved A or B gets one row here. The A and B result above stays on its own exits."
                fallbackLabel="Test: 60-minute time stop"
              />
            )}
            {page.jgVwap ? <JgVwapPanel section={page.jgVwap} /> : (
              <Note color="#fbbf24">JG-VWAP paper test could not be read. The totals above are unchanged.</Note>
            )}

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginTop: 22 }}>
              <h2 style={{ ...heading, margin: 0 }}>Recent alerts</h2>
              <a href="/api/scorecard?format=csv" style={{ color: "#06b6d4", fontWeight: 700, fontSize: 15 }}>Download CSV</a>
            </div>
            <div style={{ overflowX: "auto", marginTop: 10 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead>
                  <tr>
                    {["Ticker", "Right", "Grade", "Opening", "Status", "Exit", "Price", "P/L", "P/L %", "Days", "Counted"].map((label) => (
                      <th key={label} style={thStyle}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.length === 0 && (
                    <tr>
                      <td colSpan={11} style={{ ...tdStyle, color: "#94a3b8" }}>No shadow alerts yet. An A or a B is saved when the Flow page loads and when the scheduled scan runs.</td>
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
                        <td style={tdStyle}>{row.openingLabel ?? "Not recorded"}</td>
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

function ExperimentPanel({ section, empty, fallbackLabel }: { section: Experiment; empty: string; fallbackLabel: string }) {
  const paper = section.byExpiry != null;
  return (
    <section style={{ ...cardStyle, borderColor: "rgba(251,191,36,0.45)", marginTop: 18 }}>
      <h2 style={{ ...heading, color: "#fbbf24" }}>{section.label}</h2>
      <Note color="#fbbf24">{section.note}</Note>
      <Note color={section.tooFew ? "#fbbf24" : "#94a3b8"}>{section.trustNote}</Note>
      <Stats
        closed={section.resolved}
        open={section.open}
        winRate={section.winRate}
        averageWin={section.averageWin}
        averageLoss={section.averageLoss}
        totalPnl={section.totalPnl}
        wins={section.wins}
        losses={section.losses}
        flats={section.flats}
      />
      {paper && section.byExpiry && (
        <>
          <h3 style={{ ...heading, margin: "14px 0 8px" }}>By expiry</h3>
          <PaperBuckets buckets={section.byExpiry} />
        </>
      )}
      {paper && section.byLevel && (
        <>
          <h3 style={{ ...heading, margin: "14px 0 8px" }}>By level</h3>
          <PaperBuckets buckets={section.byLevel} />
        </>
      )}
      {section.rows.length === 0 && (
        <p style={{ color: "#94a3b8", fontSize: 15, margin: "10px 0 0" }}>{empty}</p>
      )}
      {section.rows.length > 0 && paper && (
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                {["Ticker", "Expiry", "Window", "Level", "SPY day", "60-min P/L", "Flat P/L"].map((label) => (
                  <th key={label} style={thStyle}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.id}>
                  <td style={tdStyle}>
                    {row.ticker}
                    <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2 }}>
                      {row.noContract ? "No contract" : `${row.strike} put`}
                    </div>
                  </td>
                  <td style={tdStyle}>{expiryLabel(row.expiryType)}</td>
                  <td style={tdStyle}>{row.entryWindow ?? "n/a"}</td>
                  <td style={tdStyle}>{row.levelLinedUp ? "Yes" : "No"}</td>
                  <td style={tdStyle}>{spyDayLabel(row.spyDay)}</td>
                  <td style={{ ...tdStyle, color: pnlColor(row.noContract ? null : row.pnl60 ?? null) }}>
                    {row.noContract || row.pnl60 == null ? "n/a" : signed(row.pnl60)}
                  </td>
                  <td style={{ ...tdStyle, color: pnlColor(row.noContract ? null : row.pnlFlat ?? null) }}>
                    {row.noContract ? "No contract" : row.pnlFlat == null ? "n/a" : signed(row.pnlFlat)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {section.rows.length > 0 && !paper && (
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                {["Ticker", "Right", "Status", "Exit", "P/L"].map((label) => (
                  <th key={label} style={thStyle}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => {
                const pnl = row.status === "closed" ? row.pnlDollars : row.unrealizedPnl;
                return (
                  <tr key={row.id}>
                    <td style={tdStyle}>
                      {row.ticker}
                      <div style={{ color: "#fbbf24", fontSize: 12, marginTop: 2 }}>{row.experimentLabel ?? fallbackLabel}</div>
                      {row.probeNote && <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2 }}>{row.probeNote}</div>}
                    </td>
                    <td style={tdStyle}>{row.putCall === "put" ? "Put" : "Call"}</td>
                    <td style={tdStyle}>{row.status === "open" ? "Open" : "Closed"}</td>
                    <td style={tdStyle}>{row.exitLabel || "n/a"}</td>
                    <td style={{ ...tdStyle, color: pnlColor(pnl) }}>{pnl == null ? "n/a" : signed(pnl)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function JgVwapPanel({ section }: { section: JgSection }) {
  const account = section.accountDollars.toLocaleString("en-US");
  return (
    <section style={{ ...cardStyle, borderColor: "rgba(251,191,36,0.35)" }}>
      <h2 style={heading}>{section.label}</h2>
      <Note color="#94a3b8">{section.note}</Note>
      <Note color={section.tooFew ? "#fbbf24" : "#94a3b8"}>{section.trustNote}</Note>
      <div style={{ display: "grid", gap: 10 }}>
        {section.buckets.map((bucket) => (
          <section key={bucket.key} style={{ ...cardStyle, marginBottom: 0 }}>
            <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{bucket.label}</h3>
            <Stat label="Trades" value={String(bucket.trades)} />
            <Stat label="Open" value={String(bucket.open)} />
            <Stat label="Win %" value={bucket.winRate == null ? "n/a" : percent(bucket.winRate)} />
            <Stat label="P/L" value={bucket.trades === 0 ? "n/a" : signed(bucket.pnl)} />
            <Stat label="P/L without top 3" value={bucket.pnlWithoutTop3 == null ? "n/a" : signed(bucket.pnlWithoutTop3)} />
            <Stat
              label={`Max drawdown vs $${account}`}
              value={`${signed(bucket.maxDrawdownDollars).replace("+", "")} (${percent(bucket.maxDrawdownVsAccount)})`}
            />
          </section>
        ))}
      </div>
      {section.rows.length > 0 && (
        <div style={{ overflowX: "auto", marginTop: 10 }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr>
                {["Ticker", "Right", "Contracts", "Status", "Exit", "P/L", "Flag"].map((label) => (
                  <th key={label} style={thStyle}>{label}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {section.rows.map((row) => (
                <tr key={row.id}>
                  <td style={tdStyle}>
                    {row.ticker}
                    <div style={{ color: "#94a3b8", fontSize: 12, marginTop: 2 }}>
                      ${row.strike} · {row.expiration}{row.root !== row.ticker ? ` · ${row.root}` : ""}
                    </div>
                  </td>
                  <td style={tdStyle}>{row.putCall === "put" ? "Put" : "Call"}</td>
                  <td style={tdStyle}>{row.contracts}</td>
                  <td style={tdStyle}>{row.status === "open" ? "Open" : "Closed"}</td>
                  <td style={tdStyle}>{row.exitReason === "stop" ? "Implied-move stop" : row.exitReason === "flat" ? "Flat by the time exit" : "Open"}</td>
                  <td style={{ ...tdStyle, color: pnlColor(row.pnlDollars) }}>{row.pnlDollars == null ? "n/a" : signed(row.pnlDollars)}</td>
                  <td style={{ ...tdStyle, color: row.overBudget ? "#fbbf24" : "#94a3b8" }}>{row.overBudget ? "Over budget" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function PaperBuckets({ buckets }: { buckets: PaperBucket[] }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {buckets.map((bucket) => (
        <section key={bucket.key} style={{ ...cardStyle, marginBottom: 0 }}>
          <h3 style={{ margin: "0 0 4px", fontSize: 16 }}>{bucket.label}</h3>
          <Stat label="Trades" value={String(bucket.trades)} />
          <Stat label="Open" value={String(bucket.open)} />
          <Stat label="No contract" value={String(bucket.noContract)} />
          <Stat label="60-min closed" value={String(bucket.closed60)} />
          <Stat label="60-min win rate" value={bucket.winRate60 == null ? "n/a" : percent(bucket.winRate60)} />
          <Stat label="60-min P/L" value={bucket.closed60 === 0 ? "n/a" : signed(bucket.totalPnl60)} />
          <Stat label="Flat closed" value={String(bucket.closedFlat)} />
          <Stat label="Flat win rate" value={bucket.winRateFlat == null ? "n/a" : percent(bucket.winRateFlat)} />
          <Stat label="Flat P/L" value={bucket.closedFlat === 0 ? "n/a" : signed(bucket.totalPnlFlat)} />
        </section>
      ))}
    </div>
  );
}

function expiryLabel(value: ExperimentRow["expiryType"]): string {
  if (value === "0DTE") return "0DTE";
  if (value === "1DTE") return "1DTE";
  if (value === "weekly") return "Weekly 7d+";
  return "n/a";
}

function spyDayLabel(value: ExperimentRow["spyDay"]): string {
  if (value === "up") return "Up";
  if (value === "down") return "Down";
  if (value === "flat") return "Flat";
  return "After close";
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
