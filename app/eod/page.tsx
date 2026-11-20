"use client";

import { useEffect, useState } from "react";
import { PageLinks } from "@/app/components/PageLinks";
import { EodRowNote } from "@/app/eod/EodRowNote";
import {
  eodOverallRows,
  eodRatioSeries,
  formatEodCount,
  formatEodPercent,
  formatEodRatio,
  formatTopStrikes,
  type EodChartPoint,
  type EodFlowRow,
  type EodLean,
  type EodUnderlying,
} from "@/app/lib/eodFlow";
import {
  formatGex,
  formatGexCoverage,
  formatGexPrice,
  gexChartSeries,
  type GexChartPoint,
  type GexRow,
  type GexUnderlying,
} from "@/app/lib/gex";

interface EodPage {
  stored: boolean;
  rows: EodFlowRow[];
  gex?: GexRow[];
  pending: { date: string; underlying: EodUnderlying } | null;
  error?: string;
}

type SeriesKey = "overall" | "spy" | "qqq" | "ndx" | "vix";

const SERIES: { key: SeriesKey; label: string; color: string; main?: boolean }[] = [
  { key: "overall", label: "Overall", color: "#e7dcc8", main: true },
  { key: "spy", label: "SPY", color: "#9caf88" },
  { key: "qqq", label: "QQQ", color: "#c4898a" },
  { key: "ndx", label: "NDX", color: "#8d99a6" },
  { key: "vix", label: "VIX", color: "#aeb6bf" },
];

export default function EodFlowPage() {
  const [page, setPage] = useState<EodPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<Record<SeriesKey, boolean>>({
    overall: true,
    spy: false,
    qqq: false,
    ndx: false,
    vix: false,
  });
  const [filter, setFilter] = useState<"all" | EodUnderlying>("all");

  useEffect(() => {
    fetch("/api/eod-flow")
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "EOD flow failed");
        setPage(json as EodPage);
      })
      .catch((err) => setError(err instanceof Error ? err.message : "EOD flow failed"));
  }, []);

  const rows = page?.rows ?? [];
  const overall = eodOverallRows(rows);
  const detail = filter === "all" ? rows : rows.filter((row) => row.underlying === filter);

  return (
    <main style={{ minHeight: "100vh", background: "#0b0f1a", color: "#e2e8f0", fontFamily: "system-ui, -apple-system, sans-serif" }}>
      <div style={{ borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "16px 16px 14px" }}>
        <h1 style={{ margin: 0, fontSize: 22, fontFamily: "monospace" }}>
          <span style={{ color: "#06b6d4" }}>▣</span> EOD Flow
        </h1>
        <p style={{ margin: "6px 0 0", color: "#94a3b8", fontSize: 15, lineHeight: 1.45, maxWidth: 760 }}>
          Daily SPY, QQQ, NDX, and VIX option volume after the close. NDX includes NDX and NDXP.
          VIX includes VIX and VIXW. Expirations are 0 to 45 days out. Equity put/call is puts divided by calls.
          Open interest is the prior close. A blank or n/a was not in the feed.
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

        <GammaLevels rows={page?.gex ?? []} />

        <h2 style={{ margin: "18px 0 8px", fontSize: 16 }}>Overall</h2>
        <p style={{ margin: "0 0 10px", color: "#94a3b8", fontSize: 14, lineHeight: 1.45, maxWidth: 760 }}>
          Equity put/call adds SPY, QQQ, and NDX. It stays blank until all three have a row, and until each row has a number for that field.
          VIX call/put is calls divided by puts. VIX calls are the hedge, so a higher number is more call buying.
          The triangle compares today with the average of earlier days that have this equity ratio, up to 20 of them, and only after 5 exist.
          Down means today is more than 5% above that average. Up means more than 5% below. Inside 5%, there is no marker.
        </p>
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Equity P/C vol</th>
                <th>P/C 0–7</th>
                <th>P/C 8–45</th>
                <th>Equity P/C OI</th>
                <th>VIX call/put vol</th>
                <th>Lean</th>
                <th>Vol coverage</th>
                <th>OI coverage</th>
              </tr>
            </thead>
            <tbody>
              {overall.length === 0 && (
                <tr>
                  <td colSpan={9} style={{ color: "#94a3b8" }}>No end-of-day rows yet.</td>
                </tr>
              )}
              {overall.map((row) => (
                <tr key={row.date}>
                  <td>{row.date}</td>
                  <td>{formatEodRatio(row.equityPutCallVolume)}</td>
                  <td>{formatEodRatio(row.equityPutCallVolume0to7)}</td>
                  <td>{formatEodRatio(row.equityPutCallVolume8to45)}</td>
                  <td>{formatEodRatio(row.equityPutCallOi)}</td>
                  <td>{formatEodRatio(row.vixCallPutVolume)}</td>
                  <td><LeanMark lean={row.lean} /></td>
                  <td>{formatEodPercent(row.volumeCoverage)}</td>
                  <td>{formatEodPercent(row.oiCoverage)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <RatioChart rows={rows} shown={shown} onToggle={(key) => setShown((current) => ({ ...current, [key]: !current[key] }))} />

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 22 }}>
          <h2 style={{ margin: 0, fontSize: 16 }}>By underlying</h2>
          <select aria-label="Filter underlyings" value={filter} onChange={(event) => setFilter(event.target.value as "all" | EodUnderlying)}>
            <option value="all">All</option>
            <option value="SPY">SPY</option>
            <option value="QQQ">QQQ</option>
            <option value="NDX">NDX</option>
            <option value="VIX">VIX</option>
          </select>
        </div>
        <div style={{ overflowX: "auto", marginTop: 10 }}>
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
              {detail.length === 0 && (
                <tr>
                  <td colSpan={17} style={{ color: "#94a3b8" }}>No end-of-day rows yet.</td>
                </tr>
              )}
              {detail.map((row) => (
                <tr key={`${row.date}:${row.underlying}`}>
                  <td>{row.date}</td>
                  <td>
                    {row.underlying}
                    <EodRowNote note={row.note} />
                  </td>
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

function LeanMark({ lean }: { lean: EodLean | null }) {
  if (lean === "down") {
    return <span aria-label="More puts than the recent average" title="More puts than the recent average" style={{ color: "#c4898a" }}>▼</span>;
  }
  if (lean === "up") {
    return <span aria-label="Fewer puts than the recent average" title="Fewer puts than the recent average" style={{ color: "#9caf88" }}>▲</span>;
  }
  return null;
}

function RatioChart({
  rows,
  shown,
  onToggle,
}: {
  rows: EodFlowRow[];
  shown: Record<SeriesKey, boolean>;
  onToggle: (key: SeriesKey) => void;
}) {
  const series = eodRatioSeries(rows);
  const active = SERIES.filter((item) => shown[item.key]);
  const values: number[] = [];
  for (let i = 0; i < series.length; i++) {
    for (let j = 0; j < active.length; j++) {
      const value = series[i][active[j].key];
      if (value != null) values.push(value);
    }
  }
  return (
    <section style={{ marginTop: 18 }}>
      <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Put/call volume ratio</h2>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
        {SERIES.map((item) => (
          <button
            key={item.key}
            type="button"
            aria-pressed={shown[item.key]}
            onClick={() => onToggle(item.key)}
            style={{
              color: item.color,
              background: shown[item.key] ? "rgba(255,255,255,0.06)" : "transparent",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              padding: "6px 10px",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {shown[item.key] ? "●" : "○"} {item.label}
          </button>
        ))}
      </div>
      {values.length === 0 ? (
        <p style={{ color: "#94a3b8", margin: 0 }}>n/a</p>
      ) : (
        <ChartSvg series={series} active={active} values={values} />
      )}
    </section>
  );
}

function ChartSvg({
  series,
  active,
  values,
}: {
  series: EodChartPoint[];
  active: typeof SERIES;
  values: number[];
}) {
  const width = 720;
  const height = 220;
  const pad = 36;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max === min ? 1 : max - min;
  const x = (index: number) => pad + (series.length === 1 ? (width - pad * 2) / 2 : (index * (width - pad * 2)) / (series.length - 1));
  const y = (value: number) => pad + (1 - (value - min) / span) * (height - pad * 2);
  const labelAt = series.length <= 6 ? series.map((_, index) => index) : [0, Math.floor((series.length - 1) / 2), series.length - 1];

  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Daily put/call volume ratio" style={{ width: "100%", maxWidth: 720, height: "auto", background: "rgba(255,255,255,0.02)", borderRadius: 8 }}>
      <line x1={pad} y1={pad} x2={pad} y2={height - pad} stroke="rgba(255,255,255,0.12)" />
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="rgba(255,255,255,0.12)" />
      <text x={4} y={pad + 4} fill="#64748b" fontSize="11">{formatEodRatio(max)}</text>
      <text x={4} y={height - pad} fill="#64748b" fontSize="11">{formatEodRatio(min)}</text>
      {active.map((item) => linePaths(series, item.key, x, y).map((points) => (
        <polyline key={`${item.key}-${points}`} fill="none" stroke={item.color} strokeWidth={item.main ? 2.5 : 1.5} points={points} />
      )))}
      {active.map((item) => series.map((point, index) => {
        const value = point[item.key];
        if (value == null) return null;
        return <circle key={`${item.key}-${point.date}`} cx={x(index)} cy={y(value)} r={item.main ? 3.5 : 2.5} fill={item.color} />;
      }))}
      {shownOverall(active) && series.map((point, index) => {
        if (point.overall == null || point.lean == null) return null;
        return <polygon key={`lean-${point.date}`} points={triangle(x(index), y(point.overall), point.lean)} fill={point.lean === "down" ? "#c4898a" : "#9caf88"} />;
      })}
      {labelAt.map((index) => (
        <text key={series[index].date} x={x(index)} y={height - 8} fill="#64748b" fontSize="11" textAnchor="middle">{series[index].date.slice(5)}</text>
      ))}
    </svg>
  );
}

function shownOverall(active: typeof SERIES): boolean {
  return active.some((item) => item.key === "overall");
}

function linePaths(
  series: EodChartPoint[],
  key: SeriesKey,
  x: (index: number) => number,
  y: (value: number) => number,
): string[] {
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
}

function triangle(cx: number, cy: number, lean: EodLean): string {
  const w = 5;
  const h = 7;
  if (lean === "up") return `${cx},${cy - h - 6} ${cx - w},${cy - 4} ${cx + w},${cy - 4}`;
  return `${cx},${cy + h + 6} ${cx - w},${cy + 4} ${cx + w},${cy + 4}`;
}

const GEX_SERIES = [
  { key: "spot" as const, label: "Spot", color: "#8d99a6" },
  { key: "flip" as const, label: "Flip", color: "#e7dcc8" },
  { key: "callWall1" as const, label: "Call wall 1", color: "#9caf88" },
  { key: "putWall1" as const, label: "Put wall 1", color: "#c4898a" },
];

function GammaLevels({ rows }: { rows: GexRow[] }) {
  const ordered = rows.slice().sort((a, b) => b.date.localeCompare(a.date) || a.underlying.localeCompare(b.underlying));
  return (
    <section>
      <h2 style={{ margin: "0 0 8px", fontSize: 16 }}>Gamma levels</h2>
      <p style={{ margin: "0 0 10px", color: "#94a3b8", fontSize: 14, lineHeight: 1.45, maxWidth: 760 }}>
        QQQ and SPY gamma from the morning chain, expirations 0 to 45 days, strikes within 12% of spot.
        Calls add and puts subtract. Open interest is the prior close. A blank or n/a was not in the feed.
      </p>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Underlying</th>
              <th>Spot</th>
              <th>Flip</th>
              <th>Flip fut</th>
              <th>Call 1</th>
              <th>Call 2</th>
              <th>Call 3</th>
              <th>Call fut</th>
              <th>Put 1</th>
              <th>Put 2</th>
              <th>Put 3</th>
              <th>Put fut</th>
              <th>Total GEX</th>
              <th>Near expiry</th>
              <th>Near flip</th>
              <th>Near flip fut</th>
              <th>Coverage</th>
            </tr>
          </thead>
          <tbody>
            {ordered.length === 0 && (
              <tr>
                <td colSpan={18} style={{ color: "#94a3b8" }}>No gamma rows yet.</td>
              </tr>
            )}
            {ordered.map((row) => (
              <tr key={`${row.date}:${row.underlying}`}>
                <td>{row.date}</td>
                <td>{row.underlying}</td>
                <td>{formatGexPrice(row.spot)}</td>
                <td>{formatGexPrice(row.flip)}</td>
                <td>{formatGexPrice(row.flipFutures)}</td>
                <td>{formatGexPrice(row.callWall1)}</td>
                <td>{formatGexPrice(row.callWall2)}</td>
                <td>{formatGexPrice(row.callWall3)}</td>
                <td>{[row.callWall1Futures, row.callWall2Futures, row.callWall3Futures].map(formatGexPrice).join(", ")}</td>
                <td>{formatGexPrice(row.putWall1)}</td>
                <td>{formatGexPrice(row.putWall2)}</td>
                <td>{formatGexPrice(row.putWall3)}</td>
                <td>{[row.putWall1Futures, row.putWall2Futures, row.putWall3Futures].map(formatGexPrice).join(", ")}</td>
                <td>{formatGex(row.totalGex)}</td>
                <td>{row.nearExpiry ?? "n/a"}</td>
                <td>{formatGexPrice(row.nearFlip)}</td>
                <td>{formatGexPrice(row.nearFlipFutures)}</td>
                <td>{formatGexCoverage(row.gammaCoverage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <GammaChart rows={ordered} underlying="QQQ" />
      <GammaChart rows={ordered} underlying="SPY" />
    </section>
  );
}

function GammaChart({ rows, underlying }: { rows: GexRow[]; underlying: GexUnderlying }) {
  const series = gexChartSeries(rows, underlying);
  const values: number[] = [];
  for (let i = 0; i < series.length; i++) {
    for (let j = 0; j < GEX_SERIES.length; j++) {
      const value = series[i][GEX_SERIES[j].key];
      if (value != null) values.push(value);
    }
  }
  return (
    <div style={{ marginTop: 16 }}>
      <h3 style={{ margin: "0 0 8px", fontSize: 14, color: "#cbd5e1" }}>{underlying}</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, color: "#94a3b8", fontSize: 13, marginBottom: 8 }}>
        {GEX_SERIES.map((item) => (
          <span key={item.key}><span style={{ color: item.color }}>●</span> {item.label}</span>
        ))}
      </div>
      {values.length === 0 ? <p style={{ color: "#94a3b8", margin: 0 }}>n/a</p> : <GammaSvg series={series} values={values} />}
    </div>
  );
}

function GammaSvg({ series, values }: { series: GexChartPoint[]; values: number[] }) {
  const width = 720;
  const height = 220;
  const pad = 36;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max === min ? 1 : max - min;
  const x = (index: number) => pad + (series.length === 1 ? (width - pad * 2) / 2 : (index * (width - pad * 2)) / (series.length - 1));
  const y = (value: number) => pad + (1 - (value - min) / span) * (height - pad * 2);
  const labelAt = series.length <= 8 ? series.map((_, index) => index) : [0, Math.floor((series.length - 1) / 2), series.length - 1];
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Spot, flip, and first walls" style={{ width: "100%", maxWidth: 720, height: "auto", background: "rgba(255,255,255,0.02)", borderRadius: 8 }}>
      <line x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} stroke="rgba(255,255,255,0.12)" />
      {GEX_SERIES.map((item) => {
        const paths: string[] = [];
        let current: string[] = [];
        for (let i = 0; i < series.length; i++) {
          const value = series[i][item.key];
          if (value == null) {
            if (current.length > 1) paths.push(current.join(" "));
            current = [];
            continue;
          }
          current.push(`${x(i)},${y(value)}`);
        }
        if (current.length > 1) paths.push(current.join(" "));
        return paths.map((points) => <polyline key={`${item.key}-${points}`} fill="none" stroke={item.color} strokeWidth="2" points={points} />);
      })}
      {GEX_SERIES.map((item) => series.map((point, index) => {
        const value = point[item.key];
        if (value == null) return null;
        return <circle key={`${item.key}-${point.date}`} cx={x(index)} cy={y(value)} r="3" fill={item.color} />;
      }))}
      {labelAt.map((index) => (
        <text key={series[index].date} x={x(index)} y={height - 8} fill="#64748b" fontSize="11" textAnchor="middle">{series[index].date.slice(5)}</text>
      ))}
    </svg>
  );
}
