import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { flowChainRequest } from "@/app/lib/flow";
import { computeKeyLevels } from "@/app/lib/levels";
import { ttOptionChain, ttPriceHistory, ttQuoteEntries } from "@/app/lib/tastytradeMarket";

/**
 * Live parity: Tastytrade parsed output vs the Schwab-backed production flow
 * scan captured seconds earlier. Skipped unless PARITY_DIR points at captures
 * (flow_<TICKER>.json from GET /api/flow?ticker=...). Never runs in CI.
 */
const dir = process.env.PARITY_DIR ?? "";
const tickers = (process.env.PARITY_TICKERS ?? "SPY,QQQ,AAPL").split(",");

type Row = Record<string, any>;

function rel(a: number, b: number): number {
  return Math.abs(a - b) / Math.max(Math.abs(b), 1e-9);
}

describe.skipIf(!dir)("Tastytrade vs Schwab live parity", () => {
  it("matches contracts, underlying, and key levels", async () => {
    const report: Record<string, unknown> = {};
    for (const ticker of tickers) {
      const file = `${dir}/flow_${ticker}.json`;
      if (!existsSync(file)) continue;
      const schwabRows: Row[] = JSON.parse(readFileSync(file, "utf8")).data ?? [];
      const now = Date.now();
      const chain = await ttOptionChain(flowChainRequest(ticker, new Date(now)));
      const daily = await ttPriceHistory({ symbol: ticker, periodType: "month", period: 1, frequencyType: "daily", frequency: 1 });
      const intraday = await ttPriceHistory({
        symbol: ticker, periodType: "day", period: 1, frequencyType: "minute", frequency: 5,
        needExtendedHoursData: true, startDate: now - 4 * 864e5, endDate: now,
      });
      const levels = computeKeyLevels({ spot: chain.underlyingPrice, daily, intraday, now: new Date(now), contracts: chain.contracts });
      // Production caches the Schwab chain for about a minute, so allow for the move in the underlying since then.
      const drift = Math.abs((chain.underlyingPrice ?? 0) - (schwabRows[0]?.underlyingPrice ?? chain.underlyingPrice ?? 0));
      const ttByKey = new Map(chain.contracts.map((c) => [`${c.expiration}|${c.strike}|${c.putCall}`, c]));
      const cmp: Row[] = [];
      let missing = 0;
      for (const s of schwabRows) {
        const t = ttByKey.get(`${s.expiration}|${s.strike}|${s.putCall}`);
        if (!t) { missing++; continue; }
        const sMid = (s.bid + s.ask) / 2;
        const tMid = (t.bid + t.ask) / 2;
        cmp.push({
          key: s.id,
          mid: [sMid, tMid],
          midOk: Math.abs(sMid - tMid) <= Math.max(0.05, 0.03 * sMid) + 1.5 * Math.abs(s.delta ?? 0.5) * drift,
          oiOk: s.openInterest === t.openInterest,
          volOk: rel(t.volume, Math.max(s.volume, 1)) <= 0.05 || Math.abs(t.volume - s.volume) <= 25,
          deltaOk: s.delta == null || t.delta == null || Math.abs(s.delta - t.delta) <= (s.dte <= 1 ? 0.08 : 0.05),
          ivOk: s.iv == null || t.iv == null || Math.abs(s.iv - t.iv) <= 0.03,
          vol: [s.volume, t.volume], oi: [s.openInterest, t.openInterest], delta: [s.delta, t.delta], iv: [s.iv, t.iv],
        });
      }
      const sl = schwabRows[0]?.levels ?? {};
      const count = (k: string) => cmp.filter((r) => r[k]).length;
      report[ticker] = {
        schwabRows: schwabRows.length, matched: cmp.length, missingInTastytrade: missing, ttContracts: chain.contracts.length,
        midOk: count("midOk"), oiOk: count("oiOk"), volOk: count("volOk"), deltaOk: count("deltaOk"), ivOk: count("ivOk"),
        underlying: [schwabRows[0]?.underlyingPrice, chain.underlyingPrice], drift,
        vwap: [sl.vwap, levels.vwap], sma20: [sl.sma20, levels.sma20], priorClose: [sl.priorClose, levels.priorClose],
        support: [sl.support, levels.support], resistance: [sl.resistance, levels.resistance],
        callWall: [sl.callWall, levels.callWall], putWall: [sl.putWall, levels.putWall],
        mismatches: cmp.filter((r) => !(r.midOk && r.oiOk && r.volOk && r.deltaOk && r.ivOk)).slice(0, 6),
      };
      writeFileSync(`${dir}/parity-report.json`, JSON.stringify(report, null, 1));
      if (schwabRows.length > 0) {
        expect(missing / schwabRows.length).toBeLessThanOrEqual(0.1);
        expect(rel(chain.underlyingPrice as number, schwabRows[0].underlyingPrice)).toBeLessThan(0.002);
        expect(count("oiOk")).toBe(cmp.length);
        expect(count("midOk") / cmp.length).toBeGreaterThanOrEqual(0.9);
        if (sl.priorClose != null) expect(rel(levels.priorClose as number, sl.priorClose)).toBeLessThan(0.001);
        if (sl.sma20 != null) expect(rel(levels.sma20 as number, sl.sma20)).toBeLessThan(0.002);
        if (sl.vwap != null) expect(rel(levels.vwap as number, sl.vwap)).toBeLessThan(0.002);
      }
    }
    const q = schwabSymbolsFrom(dir, tickers).slice(0, 20);
    const quotes = await ttQuoteEntries(q);
    report.quotes = { asked: q.length, got: quotes.entries.length, problem: quotes.problem };
    expect(quotes.entries.length).toBe(q.length);
    writeFileSync(`${dir}/parity-report.json`, JSON.stringify(report, null, 1));
  }, 240_000);
});

function schwabSymbolsFrom(d: string, list: string[]): string[] {
  const out: string[] = [];
  for (const ticker of list) {
    const file = `${d}/flow_${ticker}.json`;
    if (!existsSync(file)) continue;
    for (const r of JSON.parse(readFileSync(file, "utf8")).data ?? []) {
      const [y, m, day] = String(r.expiration).split("-");
      const strike = String(Math.round(r.strike * 1000)).padStart(8, "0");
      out.push(`${ticker.padEnd(6, " ")}${y.slice(2)}${m}${day}${r.putCall === "call" ? "C" : "P"}${strike}`);
    }
  }
  return out;
}
