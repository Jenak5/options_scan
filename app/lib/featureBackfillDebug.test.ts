import { describe, expect, it } from "vitest";
import { makeStepper, runFeatureBackfill, type BackfillStep } from "@/app/lib/featureBackfillStore";

describe("feature backfill time cap", () => {
  it("logs each step with its duration", async () => {
    const trace: BackfillStep[] = [];
    const lines: string[] = [];
    const step = makeStepper(trace, Date.now() + 5000, (line) => lines.push(line));
    expect(await step("read alert book", async () => 7)).toBe(7);
    expect(trace).toEqual([{ step: "read alert book", ms: expect.any(Number), ok: true }]);
    expect(lines.join("\n")).toMatch(/read alert book start/);
    expect(lines.join("\n")).toMatch(/read alert book done in \d+ ms/);
  });

  it("stops a step that never settles once the cap is reached", async () => {
    const trace: BackfillStep[] = [];
    const step = makeStepper(trace, Date.now() + 50, () => {});
    const started = Date.now();
    await expect(step("dxlink candles", () => new Promise<never>(() => {}))).rejects.toThrow(/Stopped at dxlink candles/);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(trace[0]).toMatchObject({ step: "dxlink candles", ok: false });
    await expect(step("earnings", async () => 1)).rejects.toThrow(/Stopped at earnings/);
    expect(trace[1]).toMatchObject({ step: "earnings", ok: false, note: "not started: time cap reached" });
  });

  it("returns JSON with partial progress instead of hanging", async () => {
    const result = await runFeatureBackfill({ apply: false, now: new Date(), capMs: 0 });
    expect(result.partial).toBe(true);
    expect(result.stoppedAt).toBe("read alert book");
    expect(result.saved).toBe(false);
    expect(result.trace[0]).toMatchObject({ step: "read alert book", ok: false });
  });
});
