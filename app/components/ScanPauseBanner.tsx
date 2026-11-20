"use client";

import { useEffect, useState } from "react";

interface PauseView {
  paused: boolean;
  forced: boolean;
  storeUnreadable: boolean;
}

/** Shown while the 5-minute scan is limited to AVWAP. Old pages keep their stored rows. */
export function ScanPauseBanner() {
  const [view, setView] = useState<PauseView | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancel = false;
    fetch("/api/scan/pause")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: PauseView | null) => {
        if (!cancel && json && typeof json.paused === "boolean") setView(json);
      })
      .catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, []);

  if (!view) return null;

  const toggle = async () => {
    if (!view) return;
    setBusy(true);
    try {
      const res = await fetch("/api/scan/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: !view.paused }),
      });
      const json = await res.json();
      if (res.ok && typeof json.paused === "boolean") setView(json);
    } catch {
      // The banner stays. The next load tries again.
    } finally {
      setBusy(false);
    }
  };

  if (!view.paused) {
    return (
      <p style={{ margin: "0 0 14px", color: "#94a3b8", fontSize: 15, lineHeight: 1.45 }}>
        {view.forced ? "SCAN_PAUSE_NON_AVWAP=0 is forcing the full scan on." : "Full scan is on."}
        {" "}
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
          Pause to AVWAP only
        </button>
      </p>
    );
  }

  return (
    <p role="status" style={{ margin: "0 0 14px", padding: "10px 12px", color: "#fde68a", background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.45)", borderRadius: 8, fontSize: 15, lineHeight: 1.45 }}>
      Scan paused: AVWAP only. Open rows in the other books are left as they were and are not scored.
      {view.storeUnreadable ? " The saved setting could not be read, so the scan stays on AVWAP only." : ""}
      {" "}
      <button
        type="button"
        onClick={toggle}
        disabled={busy || view.forced}
        style={{
          marginLeft: 8,
          background: "transparent",
          color: "#fde68a",
          border: "1px solid rgba(253,230,138,0.5)",
          borderRadius: 6,
          padding: "2px 8px",
          cursor: busy ? "default" : "pointer",
          fontSize: 13,
        }}
      >
        Resume the full scan
      </button>
    </p>
  );
}
