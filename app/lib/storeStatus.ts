/**
 * Plain-language status for the alert book. No tokens and no blob paths.
 */

export interface AlertBookNotice {
  /** Set when the last alert-book read or save failed. */
  problem: "read" | "write" | null;
  /** True when the book was read and it has no records. */
  empty: boolean;
  /** True when Telegram accepted an alert and the book did not keep it. */
  alertsSentUnsaved: boolean;
  failedAt: number | null;
  status: number | null;
  message: string | null;
}

export function alertBookNoticeSentence(notice: AlertBookNotice): string | null {
  const lines: string[] = [];
  if (notice.problem) {
    const verb = notice.problem === "read" ? "read" : "save";
    const when = notice.failedAt == null ? "" : ` at ${chicagoStamp(notice.failedAt)} Chicago`;
    const detail = notice.message ? `: ${notice.message}` : "";
    const http = notice.status == null ? "" : ` (HTTP ${notice.status})`;
    lines.push(`Alert book ${verb} failed${when}${detail}${http}`);
  }
  if (notice.empty && notice.alertsSentUnsaved) {
    lines.push("Telegram alerts were sent, but the alert book is empty.");
  }
  return lines.length > 0 ? lines.join(" ") : null;
}

function chicagoStamp(at: number): string {
  return new Date(at).toLocaleString("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
