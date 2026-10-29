"use client";

import { useEffect, useMemo, useState } from "react";
import { PageLinks } from "@/app/components/PageLinks";
import { formatFlowPremium } from "@/app/lib/alertConfig";
import {
  sortUnusualFlags,
  type UnusualFlag,
  type UnusualHorizon,
  type UnusualSortKey,
} from "@/app/lib/unusualFlow";

interface Payload {
  note: string;
  tradingDay: string;
  flags: UnusualFlag[];
  health: {
    flagsToday: number;
    bullishToday: number;
    bearishToday: number;
    awaitingOutcome: number;
  };
}

const COLUMNS: { key: UnusualSortKey | "contract" | "volume" | "oi" | "askPremium" | "bidShare" | "side" | "underlying" | "d1u" | "d1o" | "d3u" | "d3o" | "d5u" | "d5o"; label: string; sort?: UnusualSortKey }[] = [
  { key: "time", label: "Time", sort: "time" },
  { key: "symbol", label: "Symbol", sort: "symbol" },
  { key: "contract", label: "Contract" },
  { key: "volume", label: "Volume" },
  { key: "oi", label: "OI" },
  { key: "volOi", label: "Vol/OI", sort: "volOi" },
  { key: "premium", label: "Premium", sort: "premium" },
  { key: "askPremium", label: "Ask premium" },
  { key: "askShare", label: "At ask", sort: "askShare" },
  { key: "bidShare", label: "At bid" },
  { key: "side", label: "Side" },
  { key: "dte", label: "DTE", sort: "dte" },
  { key: "otm", label: "% OTM", sort: "otm" },
  { key: "sweep", label: "Sweep", sort: "sweep" },
  { key: "underlying", label: "Underlying" },
  { key: "d1u", label: "1d und" },
  { key: "d1o", label: "1d opt" },
  { key: "d3u", label: "3d und" },
  { key: "d3o", label: "3d opt" },
  { key: "d5u", label: "5d und" },
  { key: "d5o", label: "5d opt" },
];

export default function UnusualPage() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preset, setPreset] = useState<"bullish" | "bearish">("bullish");
  const [sortKey, setSortKey] = useState<UnusualSortKey>("premium");
  const [direction, setDirection] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/unusual")
      .then(async (response) => {
        if (!response.ok) throw new Error("The unusual-flow list could not be loaded.");
        return response.json() as Promise<Payload>;
      })
      .then((body) => {
        if (!cancelled) setPayload(body);
      })
      .catch(() => {
        if (!cancelled) setError("The unusual-flow list could not be loaded.");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => {
    const flags = (payload?.flags ?? []).filter((flag) => flag.preset === preset);
    return sortUnusualFlags(flags, sortKey, direction);
  }, [payload, preset, sortKey, direction]);

  function onSort(key: UnusualSortKey) {
    if (sortKey === key) {
      setDirection(direction === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(key);
    setDirection(key === "symbol" ? "asc" : "desc");
  }

  return (
    <main style={{ minHeight: "100vh", background: "#0b0f19", color: "#e2e8f0", padding: "24px 20px 48px" }}>
      <div style={{ maxWidth: 1280, margin: "0 auto" }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: "-0.02em" }}>Unusual flow</h1>
        <p style={{ color: "#94a3b8", marginTop: 8, maxWidth: 820, lineHeight: 1.5 }}>{payload?.note ?? "Loading the stored flags."}</p>
        <PageLinks current="unusual" />
        <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
          <Tab label="Unusually Bullish" active={preset === "bullish"} onClick={() => setPreset("bullish")} />
          <Tab label="Unusually Bearish" active={preset === "bearish"} onClick={() => setPreset("bearish")} />
        </div>
        {payload && (
          <p style={{ color: "#64748b", marginTop: 12, fontSize: 14 }}>
            Today {payload.health.flagsToday} ({payload.health.bullishToday} bullish, {payload.health.bearishToday} bearish). {payload.health.awaitingOutcome} still waiting on a 1, 3, or 5 day mark.
          </p>
        )}
        {error && <p style={{ color: "#f87171", marginTop: 16 }}>{error}</p>}
        {!error && !payload && <p style={{ color: "#64748b", marginTop: 16 }}>Loading.</p>}
        {payload && rows.length === 0 && <p style={{ color: "#94a3b8", marginTop: 16 }}>No {preset === "bullish" ? "bullish" : "bearish"} flags stored yet.</p>}
        {rows.length > 0 && (
          <div style={{ overflowX: "auto", marginTop: 16, border: "1px solid rgba(255,255,255,0.08)", borderRadius: 10 }}>
            <table>
              <thead>
                <tr>
                  {COLUMNS.map((column) => (
                    <th key={column.key}>
                      {column.sort ? (
                        <button type="button" onClick={() => onSort(column.sort as UnusualSortKey)} style={headerButton}>
                          {column.label}{sortKey === column.sort ? (direction === "asc" ? " ↑" : " ↓") : ""}
                        </button>
                      ) : column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((flag) => (
                  <tr key={flag.id}>
                    <td style={cell}>{stamp(flag.flaggedAt)}</td>
                    <td style={cell}>{flag.symbol}</td>
                    <td style={cell}>{contractLabel(flag)}</td>
                    <td style={cell}>{flag.metrics.volume.toLocaleString("en-US")}</td>
                    <td style={cell}>{flag.metrics.openInterest.toLocaleString("en-US")}</td>
                    <td style={cell}>{ratio(flag.metrics.volOiRatio)}</td>
                    <td style={cell}>{formatFlowPremium(flag.metrics.premium)}</td>
                    <td style={cell} title={flag.metrics.sideNote}>{formatFlowPremium(flag.metrics.askSidePremium)}</td>
                    <td style={cell} title={flag.metrics.sideNote}>{percent(flag.metrics.askShare)}</td>
                    <td style={cell} title={flag.metrics.sideNote}>{percent(flag.metrics.bidShare)}</td>
                    <td style={cell}>{sideLabel(flag.metrics.sideSource)}</td>
                    <td style={cell}>{flag.metrics.dte ?? "—"}</td>
                    <td style={cell}>{percent(flag.metrics.otmFraction)}</td>
                    <td style={cell} title={flag.metrics.sweepNote}>{flag.metrics.sweepLike ? "Burst" : "—"}</td>
                    <td style={cell}>{money(flag.underlyingPrice)}</td>
                    <td style={cell}>{change(flag.outcomes.d1, "underlying")}</td>
                    <td style={cell}>{change(flag.outcomes.d1, "option")}</td>
                    <td style={cell}>{change(flag.outcomes.d3, "underlying")}</td>
                    <td style={cell}>{change(flag.outcomes.d3, "option")}</td>
                    <td style={cell}>{change(flag.outcomes.d5, "underlying")}</td>
                    <td style={cell}>{change(flag.outcomes.d5, "option")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function Tab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick} style={{
      minHeight: 44,
      padding: "0 16px",
      borderRadius: 8,
      border: active ? "1px solid #06b6d4" : "1px solid rgba(255,255,255,0.12)",
      background: active ? "rgba(6,182,212,0.15)" : "transparent",
      color: active ? "#67e8f9" : "#94a3b8",
      fontWeight: 700,
      cursor: "pointer",
    }}>{label}</button>
  );
}

function contractLabel(flag: UnusualFlag): string {
  const right = flag.putCall === "call" ? "call" : "put";
  return `${flag.strike} ${right} ${flag.expiration}`;
}

function stamp(at: number): string {
  return new Date(at).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function ratio(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${value.toFixed(2)}x`;
}

function percent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function money(value: number): string {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function sideLabel(source: UnusualFlag["metrics"]["sideSource"]): string {
  if (source === "trade") return "Tape";
  if (source === "mixed") return "Mixed";
  return "Estimate";
}

function change(horizon: UnusualHorizon | null, kind: "underlying" | "option"): string {
  if (!horizon) return "—";
  const value = kind === "underlying" ? horizon.underlyingChange : horizon.optionChange;
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

const headerButton = {
  background: "transparent",
  border: "none",
  color: "#64748b",
  font: "inherit",
  fontWeight: 600,
  letterSpacing: "0.05em",
  textTransform: "uppercase" as const,
  cursor: "pointer",
  padding: 0,
};

const cell = { padding: "8px 10px", borderBottom: "1px solid rgba(255,255,255,0.06)", whiteSpace: "nowrap" as const, fontSize: 14 };
