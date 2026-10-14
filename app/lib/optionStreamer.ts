/**
 * DXLink option streamer symbols, the form the candle proof subscribed to.
 * ".TLT261113P77.5" is the TLT 13 Nov 2026 77.5 put. The 1-minute candle
 * subscription appends "{=1m}".
 */

const ROOT = /^[A-Z][A-Z0-9]{0,5}$/;

export function tastytradeStreamerSymbol(input: {
  ticker: string;
  expiration: string;
  strike: number;
  putCall: "call" | "put";
}): string | null {
  const root = input.ticker.trim().toUpperCase().replace(/[.\s]/g, "");
  if (!ROOT.test(root)) return null;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.expiration);
  if (!date) return null;
  const month = Number(date[2]);
  const day = Number(date[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const strike = formatStrike(input.strike);
  if (!strike) return null;
  const side = input.putCall === "call" ? "C" : input.putCall === "put" ? "P" : null;
  if (!side) return null;
  return `.${root}${date[1].slice(2)}${date[2]}${date[3]}${side}${strike}`;
}

/** Candle subscription symbol. The streamer symbol is unchanged aside from the suffix. */
export function candleSubscriptionSymbol(streamer: string, period: CandlePeriod = "1m"): string {
  const base = streamerSymbolKey(streamer);
  return `${base}{=${period}}`;
}

/** DXLink candle periods this app requests. Option paths use 1m; the feature backfill uses 5m and 1d on the underlying. */
export type CandlePeriod = "1m" | "5m" | "1d";

/** Drop a "{=1m}" suffix so compact events match the streamer symbol. */
export function streamerSymbolKey(symbol: string): string {
  const text = symbol.trim();
  const brace = text.indexOf("{");
  return brace === -1 ? text : text.slice(0, brace);
}

function formatStrike(strike: number): string | null {
  if (!Number.isFinite(strike) || !(strike > 0) || strike > 99_999.999) return null;
  const scaled = Math.round(strike * 1000);
  if (scaled <= 0 || Math.abs(scaled - strike * 1000) > 0.01) return null;
  return (scaled / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
