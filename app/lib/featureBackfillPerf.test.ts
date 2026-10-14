import { describe, expect, it } from "vitest";
import type { CandleBar } from "@/app/lib/candleTypes";
import { levelsAt, nyDay, nyMinutes, prepareHistory, spyTrendAt, type UnderlyingHistory } from "@/app/lib/featureBackfill";
import { indexDirection } from "@/app/lib/marketContext";
import { spyTrendsByTime } from "@/app/lib/featureBackfillStore";
import { newYorkDate } from "@/app/lib/flow";

const DAY = 86_400_000;
const START = Date.UTC(2026, 8, 1); // 2026-09-01
const NOW = new Date(Date.UTC(2026, 9, 14, 16, 0));

/** About six weeks of 5-minute bars, 4 AM to 8 PM New York (192 a day), plus 70 daily bars. */
function realisticSpy(): UnderlyingHistory {
  const intraday: CandleBar[] = [];
  const daily: CandleBar[] = [];
  for (let day = START - 70 * DAY; day < NOW.getTime(); day += DAY) {
    const weekday = new Date(day).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    daily.push({ t: day, o: 600, h: 605, l: 595, c: 600 + (day / DAY) % 7, v: 50_000_000 });
    if (day < START) continue;
    const open = day + 8 * 3_600_000; // 4 AM EDT
    for (let i = 0; i < 192; i++) {
      const price = 600 + Math.sin(i / 10) * 3;
      intraday.push({ t: open + i * 300_000, o: price, h: price + 0.2, l: price - 0.2, c: price, v: 10_000 + i });
    }
  }
  return { intraday, daily };
}

function entryTimes(count: number): number[] {
  const out: number[] = [];
  let day = START;
  while (out.length < count) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      for (let k = 0; k < 20 && out.length < count; k++) out.push(day + 14 * 3_600_000 + k * 17 * 60_000);
    }
    day += DAY;
  }
  return out;
}

describe("feature backfill speed", () => {
  it("fills SPY trend for 500 entries on six weeks of 5-minute bars in well under a second or two", async () => {
    const spy = realisticSpy();
    expect(spy.intraday.length).toBeGreaterThan(5000);
    const times = entryTimes(500);
    const started = Date.now();
    const trends = await spyTrendsByTime(spy, times, NOW);
    const ms = Date.now() - started;
    expect(trends.size).toBeGreaterThan(400);
    expect(ms).toBeLessThan(3000);
  });

  it("matches the level math VWAP used for alerts", () => {
    const spy = realisticSpy();
    for (const at of entryTimes(60).filter((_t, i) => i % 7 === 0)) {
      const read = levelsAt(spy, at, null, NOW);
      const fast = spyTrendAt(spy, at, NOW);
      const slow = read.levels?.vwap == null ? "unknown" : indexDirection(read.price, read.levels.vwap);
      expect(fast).toBe(slow);
    }
    expect(prepareHistory(spy, NOW)).toBe(prepareHistory(spy, NOW));
  });

  it("caches the New York date by hour without changing it", () => {
    for (let t = START; t < START + 3 * DAY; t += 7 * 60_000) {
      expect(nyDay(t)).toBe(newYorkDate(new Date(t)));
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(t));
      const h = Number(parts.find((p) => p.type === "hour")?.value);
      const m = Number(parts.find((p) => p.type === "minute")?.value);
      expect(nyMinutes(t)).toBe(h * 60 + m);
    }
  });
});
