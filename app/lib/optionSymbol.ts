/**
 * Schwab option symbols are the OCC form: a 6-character root, YYMMDD,
 * C or P, and the strike in thousandths as 8 digits.
 * "NVDA  261106P00235000" is the NVDA 6 Nov 2026 235 put.
 */

const ROOT = /^[A-Z][A-Z0-9]{0,5}$/;

export function schwabOptionSymbol(input: {
  ticker: string;
  expiration: string;
  strike: number;
  putCall: "call" | "put";
}): string | null {
  const root = input.ticker.trim().toUpperCase().replace(/\./g, "");
  if (!ROOT.test(root)) return null;
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(input.expiration);
  if (!date) return null;
  const month = Number(date[2]);
  const day = Number(date[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (!Number.isFinite(input.strike) || !(input.strike > 0) || input.strike > 99_999.999) return null;
  const scaled = Math.round(input.strike * 1000);
  if (scaled <= 0 || scaled > 99_999_999) return null;
  if (Math.abs(scaled - input.strike * 1000) > 0.01) return null;
  const side = input.putCall === "call" ? "C" : input.putCall === "put" ? "P" : null;
  if (!side) return null;
  return `${root.padEnd(6, " ")}${date[1].slice(2)}${date[2]}${date[3]}${side}${String(scaled).padStart(8, "0")}`;
}

/** Compare a requested symbol with the key Schwab sends back. Spacing is not significant. */
export function normalizeOptionSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/\s+/g, "");
}
