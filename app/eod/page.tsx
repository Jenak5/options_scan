"use client";

import { useEffect, useState } from "react";
import { PageLinks } from "@/app/components/PageLinks";
import {
  eodRatioSeries,
  formatEodCount,
  formatEodPercent,
  formatEodRatio,
  formatTopStrikes,
  type EodFlowRow,
  type EodUnderlying,
} from "@/app/lib/eodFlow";

interface EodPage {
  stored: boolean;
  rows: EodFlowRow[];
  pending: { date: string; underlying: EodUnderlying } | null;
  error?: string;
}

export default function EodFlowPage() {
  const [page, setPage] = useState<EodPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/eod-flow")
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "EOD flow failed");
        setPage(json as EodPage);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "EOD flow failed"));
  }, []);

  return (
    <main style={{ minHeight: "100vh", background: "#0b0f1a", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "16px 16px 14px" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontFamily: "monospace" }}>
          <span style={{ color: "#06b6d4" }}>▣</span> EOD Flow
        </h1>
        <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 15, lineHeight: 1.45, maxWidth: 760 }}>
          Daily QQQ and NDX option volume after the close. NDX includes the NDX and NDXP roots.
          Expirations are 0 to 45 days out. Put/call is puts divided by calls. Open interest is the prior close.
          A blank or n/a was not in the feed.
        </p>
        <PageLinks current="eod" />
      </div>
      <div style={{ padding: "16px 16px 40px" }}>
        {error && <p style={{ color: "#fca5a5" }}>{error}</p>}
        {page && !page.stored && (
          <p style={{ color: "#fbbf24", marginBottom: 12 }}>
            The private store is not configured, so there is no end-of-day history yet. It uses the same store as the trade log.
          </p>
        )}
        {page?.pending && (
          <p style={{ color: "#94a3b8", marginBottom: 12 }}>
            {page.pending.underlying} for {page.pending.date} is still being collected.
          </p>
        )}
        <RatioChart rows={page?.rows ?? []} />
        <div style={{ overflowX: "auto", marginTop: 18 }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Underlying</th>
                <th>Put vol</th>
                <th>Call vol</th>
                <th>P/C vol</th>
                <th>Put OI</th>
                <th>Call OI</th>
                <th>P/C OI</th>
                <th>Put 0–7</th>
                <th>Call 0–7</th>
                <th>Put 8–45</th>
                <th>Call 8–45</th>
                <th>Top strikes</th>
                <th>Friday</th>
                <th>Session</th>
                <th>Vol coverage</th>
                <th>OI coverage</th>
              </tr>
            </thead>
            <tbody>
              {(page?.rows ?? []).length === 0 && (
                <tr>
                  <td colSpan={17} style={{ color: "#94a3b8" }}>No end-of-day rows yet.</td>
                </tr>
              )}
              {(page?.rows ?? []).map((row) => (
                <tr key={`${row.date}:${row.underlying}`}>
                  <td>{row.date}</td>
                  <td>{row.underlying}</td>
                  <td>{formatEodCount(row.putVolume)}</td>
                  <td>{formatEodCount(row.callVolume)}</td>
                  <td>{formatEodRatio(row.putCallVolumeRatio)}</td>
                  <td>{formatEodCount(row.putOpenInterest)}</td>
                  <td>{formatEodCount(row.callOpenInterest)}</td>
                  <td>{formatEodRatio(row.putCallOiRatio)}</td>
                  <td>{formatEodCount(row.putVolume0to7)}</td>
                  <td>{formatEodCount(row.callVolume0to7)}</td>
                  <td>{formatEodCount(row.putVolume8to45)}</td>
                  <td>{formatEodCount(row.callVolume8to45)}</td>
                  <td>{formatTopStrikes(row.topStrikes)}</td>
                  <td>{row.friday ? "yes" : ""}</td>
                  <td>{row.earlyClose ? "early close" : ""}</td>
                  <td>{formatEodPercent(row.volumeCoverage)}</td>
                  <td>{formatEodPercent(row.oiCoverage)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

function RatioChart({ rows }: { rows: EodFlowRow[] }) {
  const series = eodRatioSeries(rows);
  const values: number[] = [];
  for (let i = 0; i < series.length; i++) {
    if (series[i].qqq != null) values.push(series[i].qqq as number);
    if (series[i].ndx != null) values.push(series[i].ndx as number);
  }
  if (values.length === 0) {
    return (
      <section>
        <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Put/call volume ratio</h2>
        <p style={{ color: "#94a3b8", margin: 0 }}>n/a</p>
      </section>
    );
  }
  const width = 720;
  const height = 220;
  const pad = 36;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max === min ? 1 : max - min;
  const x = (index: number) => pad + (series.length === 1 ? (width - pad * 2) / 2 : (index * (width - pad * 2)) / (series.length - 1));
  const y = (value: number) => pad + (1 - (value - min) / span) * (height - pad * 2);
  const dots = (key: "qqq" | "ndx", color: string) => series.map((point, index) => {
    const value = point[key];
    if (value == null) return null;
    return <circle key={`${key}-${point.date}`} cx={x(index)} cy={y(value)} r={3.5} fill={color} />;
  });
  const lines = (key: "qqq" | "ndx") => {
    const paths: string[] = [];
    let current: string[] = [];
    for (let i = 0; i < series.length; i++) {
      const value = series[i][key];
      if (value == null) {
        if (current.length > 1) paths.push(current.join(" "));
        current = [];
        continue;
      }
      current.push(`${x(i)},${y(value)}`);
    }
    if (current.length > 1) paths.push(current.join(" "));
    return paths;
  };
  const labelAt = series.length <= 6 ? series.map((_, index) => index) : [0, Math.floor((series.length - 1) / 2), series.length - 1];

  return (
    <section>
      <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Put/call volume ratio</h2>
      <div style={{ display: "flex", gap: 16, color: "#94a3b8", fontSize: 13, marginBottom: 8 }}>
        <span><span style={{ color: "#06b6d4" }}>●</span> QQQ</span>
        <span><span style={{ color: "#f59e0b" }}>●</span> NDX</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily put/call volume ratio for QQQ and NDX" style={{ width: "100%", maxWidth: 720, height: "auto", background: "rgba(255,255,255,0.02)", borderRadius: 8 }}>
        <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="rgba(255,255,255,0.12)" />
        <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="rgba(255,255,255,0.12)" />
        <text x={4} y={pad + 4} fill="#64748b" fontSize="11">{formatEodRatio(max)}</text>
        <text x={4} y={height - pad} fill="#64748b" fontSize="11">{formatEodRatio(min)}</text>
        {lines("qqq").map((points) => <polyline key={points} fill="none" stroke="#06b6d4" strokeWidth="2" points={points} />)}
        {lines("ndx").map((points) => <polyline key={points} fill="none" stroke="#f59e0b" strokeWidth="2" points={points} />)}
        {dots("qqq", "#06b6d4")}
        {dots("ndx", "#f59e0b")}
        {labelAt.map((index) => (
          <text key={series[index].date} x={x(index)} y={height - 8} fill="#64748b" fontSize="11" textAnchor="middle">{series[index].date.slice(5)}</text>
        ))}
      </svg>
    </section>
  );
}
