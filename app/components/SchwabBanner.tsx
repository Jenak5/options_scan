"use client";

import { useEffect, useState } from "react";

interface SchwabStatus {
  configured: boolean;
  storage: "kv" | "memory";
  connected: boolean;
  accessExpired: boolean;
  refreshExpired: boolean;
  refreshDaysLeft: number | null;
  warnRefreshSoon: boolean;
  message: string;
}

export function SchwabBanner() {
  const [status, setStatus] = useState<SchwabStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("schwab") === "connected") {
      setNotice("Schwab connected. The tokens stay on the server.");
    } else if (params.get("schwab") === "error") {
      setNotice("Schwab connect did not finish. Use Reconnect Schwab and approve Market Data again.");
    }

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/schwab/status");
        if (!res.ok) throw new Error("status");
        const json = await res.json();
        if (!cancelled) setStatus(json as SchwabStatus);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const warn = Boolean(status?.warnRefreshSoon || status?.refreshExpired);
  const border = warn ? "rgba(245,158,11,0.45)" : "rgba(255,255,255,0.08)";
  const background = warn ? "rgba(245,158,11,0.1)" : "rgba(255,255,255,0.03)";
  const color = warn ? "#fbbf24" : "#94a3b8";

  return (
    <div style={{
      background,
      border: `1px solid ${border}`,
      borderRadius: 8,
      padding: "10px 14px",
      display: "flex",
      gap: 12,
      alignItems: "center",
      justifyContent: "space-between",
      flexWrap: "wrap",
      marginBottom: 16,
    }}>
      <div style={{ fontSize: 14, color, lineHeight: 1.45 }}>
        {notice && <div style={{ color: "#e2e8f0", marginBottom: 4 }}>{notice}</div>}
        {loadError && "Schwab status is unavailable."}
        {!loadError && (status?.message ?? "Checking Schwab…")}
        {status?.warnRefreshSoon && (
          <div style={{ marginTop: 4, fontWeight: 700 }}>
            Refresh token has under 2 days left. Reconnect before the weekly login lapses.
          </div>
        )}
        {status?.connected && status.accessExpired && !status.refreshExpired && (
          <div style={{ marginTop: 4 }}>The access token will refresh on the next quote.</div>
        )}
      </div>
      <a
        href="/api/schwab/connect"
        style={{
          background: "rgba(6,182,212,0.15)",
          color: "#06b6d4",
          border: "1px solid rgba(6,182,212,0.35)",
          borderRadius: 6,
          padding: "8px 14px",
          fontSize: 14,
          fontWeight: 700,
          textDecoration: "none",
          whiteSpace: "nowrap",
        }}
      >
        Reconnect Schwab
      </a>
    </div>
  );
}
