"use client";

import { useEffect, useState } from "react";
import { SCHWAB_STORAGE_UNCONFIGURED_MESSAGE, type SchwabStoreKind } from "@/app/lib/schwabStorage";

interface ConnectionNotice {
  severity: "down" | "warn" | "ok";
  lines: string[];
}

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
  notice?: ConnectionNotice;
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
  const [hidden, setHidden] = useState(true);
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
        if (res.status === 401) {
          if (!cancelled) setHidden(true);
          return;
        }
        if (!res.ok) throw new Error("status");
        const json = await res.json();
        if (!cancelled) {
          setStatus(json as SchwabStatus);
          setHidden(false);
        }
      } catch {
        if (!cancelled) {
          setLoadError(true);
          setHidden(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (hidden) return null;

  const storageWarning = status?.storageWarning ?? (status?.storage === "unconfigured" ? SCHWAB_STORAGE_UNCONFIGURED_MESSAGE : null);
  const showStorage = Boolean(storageWarning) && storageWarning !== notice;
  const severity = status?.notice?.severity ?? "ok";
  const lines = status?.notice?.lines ?? [];
  const urgent = severity === "down" || severity === "warn" || noticeKind === "error" || Boolean(storageWarning);
  const success = noticeKind === "success" && !urgent;

  const border = success
    ? "rgba(16,185,129,0.45)"
    : severity === "down" || noticeKind === "error"
      ? "rgba(239,68,68,0.55)"
      : urgent
        ? "rgba(245,158,11,0.55)"
        : "rgba(255,255,255,0.08)";
  const background = success
    ? "rgba(16,185,129,0.1)"
    : severity === "down" || noticeKind === "error"
      ? "rgba(239,68,68,0.12)"
      : urgent
        ? "rgba(245,158,11,0.12)"
        : "rgba(255,255,255,0.03)";
  const color = success ? "#6ee7b7" : urgent ? "#fde68a" : "#94a3b8";

  return (
    <div style={{ padding: "12px 24px 0" }}>
      <div
        role={urgent ? "alert" : "status"}
        style={{
          background,
          border: `1px solid ${border}`,
          borderRadius: 8,
          padding: "10px 14px",
          display: "flex",
          gap: 12,
          alignItems: "center",
          justifyContent: "space-between",
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 14, color, lineHeight: 1.45 }}>
          {notice && (
            <div style={{ color: success ? "#6ee7b7" : "#fecaca", marginBottom: 4, fontWeight: 700 }}>
              {notice}
            </div>
          )}
          {showStorage && (
            <div style={{ color: "#fbbf24", marginBottom: 4, fontWeight: 700 }}>{storageWarning}</div>
          )}
          {lines.map((line) => (
            <div key={line} style={{ marginTop: 4, fontWeight: 700, color: severity === "down" ? "#fecaca" : "#fde68a" }}>
              {line}
            </div>
          ))}
          {loadError && "Schwab status is unavailable."}
          {!loadError && status?.message && status.message !== notice && status.message !== storageWarning && !lines.includes(status.message) && status.message}
          {!loadError && !status && "Checking Schwab…"}
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
    </div>
  );
}
