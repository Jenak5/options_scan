"use client";

import { useEffect, useState } from "react";
import { SCHWAB_STORAGE_UNCONFIGURED_MESSAGE, type SchwabStoreKind } from "@/app/lib/schwabStorage";

interface SchwabStatus {
  configured: boolean;
  storage: SchwabStoreKind;
  storageWarning: string | null;
  connected: boolean;
  accessExpired: boolean;
  refreshExpired: boolean;
  refreshDaysLeft: number | null;
  warnRefreshSoon: boolean;
  message: string;
}

type NoticeKind = "success" | "error" | null;

const FAILURES: Record<string, string> = {
  state: "Schwab connect stopped because the security check did not match. You are back on the dashboard. Use Reconnect Schwab if you want to try again.",
  denied: "Schwab did not grant access. Nothing was connected. You are back on the dashboard. Use Reconnect Schwab if you want to try again.",
  exchange: "Schwab connect could not be completed. Nothing was connected. You are back on the dashboard. Use Reconnect Schwab if you want to try again.",
  storage: SCHWAB_STORAGE_UNCONFIGURED_MESSAGE,
};

export function SchwabBanner() {
  const [status, setStatus] = useState<SchwabStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeKind, setNoticeKind] = useState<NoticeKind>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const schwab = params.get("schwab");
    if (schwab === "connected") {
      setNotice("Schwab connected");
      setNoticeKind("success");
    } else if (schwab === "error") {
      const reason = params.get("reason") ?? "";
      setNotice(FAILURES[reason] ?? "Schwab connect did not finish. You are back on the dashboard. Use Reconnect Schwab if you want to try again.");
      setNoticeKind("error");
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

  const storageWarning = status?.storageWarning ?? (status?.storage === "unconfigured" ? SCHWAB_STORAGE_UNCONFIGURED_MESSAGE : null);
  const showStorage = Boolean(storageWarning) && storageWarning !== notice;
  const warn = Boolean(status?.warnRefreshSoon || status?.refreshExpired || noticeKind === "error" || storageWarning);
  const success = noticeKind === "success" && !warn;

  const border = success
    ? "rgba(16,185,129,0.45)"
    : warn
      ? "rgba(245,158,11,0.45)"
      : "rgba(255,255,255,0.08)";
  const background = success
    ? "rgba(16,185,129,0.1)"
    : warn
      ? "rgba(245,158,11,0.1)"
      : "rgba(255,255,255,0.03)";
  const color = success ? "#6ee7b7" : warn ? "#fbbf24" : "#94a3b8";

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
        {notice && (
          <div role={noticeKind === "error" ? "alert" : "status"} style={{ color: success ? "#6ee7b7" : "#e2e8f0", marginBottom: 4, fontWeight: 700 }}>
            {notice}
          </div>
        )}
        {showStorage && (
          <div role="alert" style={{ color: "#fbbf24", marginBottom: 4, fontWeight: 700 }}>{storageWarning}</div>
        )}
        {loadError && "Schwab status is unavailable."}
        {!loadError && status?.message && status.message !== notice && status.message !== storageWarning && status.message}
        {!loadError && !status && "Checking Schwab…"}
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
