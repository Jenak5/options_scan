"use client";

import { useEffect, useState } from "react";

interface MuteView {
  muted: boolean;
  forced: boolean;
  storeUnreadable: boolean;
  mutedToday: number;
}

/**
 * One line on the alert pages. Other Telegram alerts stay off until this is turned off.
 */
export function TelegramMuteLine() {
  const [view, setView] = useState<MuteView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancel = false;
    fetch("/api/telegram/mute")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: MuteView | null) => {
        if (!cancel && json && typeof json.muted === "boolean") setView(json);
      })
      .catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, []);

  if (!view) return null;

  const sentence = view.muted
    ? `Only AVWAP alerts are on Telegram; ${view.mutedToday} muted alert${view.mutedToday === 1 ? "" : "s"} today`
    : "All Telegram alerts are on";
  const extra = view.forced
    ? " TELEGRAM_MUTE_OTHER=0 is forcing every alert on."
    : view.storeUnreadable
      ? " The saved setting could not be read, so other alerts stay off."
      : "";

  const toggle = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/telegram/mute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ muted: !view.muted }),
      });
      const json = await res.json();
      if (res.ok && typeof json.muted === "boolean") setView(json);
    } catch {
      // The line stays as it was. The next load tries again.
    } finally {
      setBusy(false);
    }
  };

  return (
    <p style={{ margin: "0 0 14px", color: "#94a3b8", fontSize: 15, lineHeight: 1.45 }}>
      <span style={{ fontWeight: 700, color: "#e2e8f0" }}>Telegram alerts. </span>
      {sentence}.{extra}{" "}
      <button
        type="button"
        onClick={toggle}
        disabled={busy || view.forced}
        style={{
          marginLeft: 8,
          background: "transparent",
          color: "#67e8f9",
          border: "1px solid rgba(103,232,249,0.4)",
          borderRadius: 6,
          padding: "2px 8px",
          cursor: busy || view.forced ? "default" : "pointer",
          fontSize: 13,
        }}
      >
        {view.muted ? "Turn other alerts on" : "Mute other alerts"}
      </button>
    </p>
  );
}
