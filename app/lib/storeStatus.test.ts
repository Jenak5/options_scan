import { describe, expect, it } from "vitest";
import { alertBookNoticeSentence, type AlertBookNotice } from "@/app/lib/storeStatus";

function notice(over: Partial<AlertBookNotice> = {}): AlertBookNotice {
  return {
    problem: null,
    empty: false,
    alertsSentUnsaved: false,
    failedAt: null,
    status: null,
    message: null,
    ...over,
  };
}

describe("alert book notice", () => {
  it("is quiet when the last save worked", () => {
    expect(alertBookNoticeSentence(notice())).toBeNull();
    expect(alertBookNoticeSentence(notice({ empty: true }))).toBeNull();
  });

  it("names a failed save and an empty book after a sent alert", () => {
    const failed = alertBookNoticeSentence(notice({
      problem: "write",
      failedAt: Date.parse("2026-10-02T17:45:00Z"),
      status: 412,
      message: "Precondition failed: ETag mismatch.",
    }));
    expect(failed).toContain("Alert book save failed");
    expect(failed).toContain("12:45");
    expect(failed).toContain("HTTP 412");
    expect(failed).toContain("ETag mismatch");
    const empty = alertBookNoticeSentence(notice({ empty: true, alertsSentUnsaved: true }));
    expect(empty).toBe("Telegram alerts were sent, but the alert book is empty.");
  });
});
