"use client";

import { useEffect, useState } from "react";
import { alertBookNoticeSentence, type AlertBookNotice } from "@/app/lib/storeStatus";

/**
 * One line on the Trade Log and Alert Report when the alert book did not save.
 * It loads its own status so the pages only mount it.
 */
export function StoreStatusLine() {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    fetch("/api/store-status")
      .then((res) => (res.ok ? res.json() : null))
      .then((json: AlertBookNotice | null) => {
        if (cancel || !json || typeof json !== "object") return;
        setText(alertBookNoticeSentence(json));
      })
      .catch(() => undefined);
    return () => {
      cancel = true;
    };
  }, []);

  if (!text) return null;
  return (
    <p style={{ margin: "0 0 14px", color: "#fbbf24", fontSize: 15, lineHeight: 1.45 }}>
      {text}
    </p>
  );
}
