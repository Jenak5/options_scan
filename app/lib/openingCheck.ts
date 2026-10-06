import type { AlertBook, StoredAlert } from "@/app/lib/alertBook";
import { flowContractKey } from "@/app/lib/flow";
import { chicagoDate, nextChicagoTradingDay } from "@/app/lib/marketHours";
import {
  classifyOpening,
  openingLabel,
  type OpeningCheck,
  type OpeningStatus,
} from "@/app/lib/quoteSide";
import type { ShadowListItem, ShadowScorecard } from "@/app/lib/shadow";

/**
 * Next-day open interest, using a chain this scan already fetched.
 * No extra Schwab request. A later day is not used, because that open interest
 * includes volume from sessions after the alert.
 */

export interface ChainInterest {
  /** Flow-row ids whose chain sent a finite open interest. */
  openInterest: Record<string, number>;
  /** Tickers whose chain came back on this scan. */
  tickers: string[];
}

export function emptyChainInterest(): ChainInterest {
  return { openInterest: {}, tickers: [] };
}

export function chainInterestFromContracts(
  passes: readonly {
    ticker: string;
    contracts: readonly { expiration: string; strike: number; putCall: string; openInterest: number }[];
  }[],
): ChainInterest {
  const openInterest: Record<string, number> = {};
  const tickers: string[] = [];
  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i];
    const ticker = pass.ticker.trim().toUpperCase();
    if (!ticker) continue;
    tickers.push(ticker);
    for (let j = 0; j < pass.contracts.length; j++) {
      const contract = pass.contracts[j];
      const oi = contract.openInterest;
      if (typeof oi !== "number" || !Number.isFinite(oi) || oi < 0 || oi > 1_000_000_000) continue;
      openInterest[`${ticker}|${flowContractKey(contract)}`] = oi;
    }
  }
  return { openInterest, tickers };
}

export function applyOpeningChecks(
  book: AlertBook,
  interest: ChainInterest,
  now: Date,
): { book: AlertBook; updated: number } {
  const today = chicagoDate(now);
  if (!today) return { book, updated: 0 };
  const seen = new Set(interest.tickers);
  let updated = 0;
  const records = book.records.map((alert) => {
    const next = nextCheck(alert, interest, seen, today);
    if (!next) return alert;
    updated += 1;
    return next;
  });
  if (updated === 0) return { book, updated: 0 };
  return { book: { ...book, records }, updated };
}

export function openingLabelsById(alerts: readonly StoredAlert[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i];
    if (!alert.openingCheck) continue;
    labels.set(alert.id, openingLabel(alert.openingCheck.status));
  }
  return labels;
}

export function withOpeningLabels<T extends ShadowScorecard>(page: T, alerts: readonly StoredAlert[]): T {
  const labels = openingLabelsById(alerts);
  const stamp = (row: ShadowListItem): ShadowListItem => ({
    ...row,
    openingLabel: labels.get(row.id) ?? null,
  });
  return {
    ...page,
    rows: page.rows.map(stamp),
    experimental: {
      ...page.experimental,
      rows: page.experimental.rows.map(stamp),
    },
  };
}

function nextCheck(
  alert: StoredAlert,
  interest: ChainInterest,
  seen: ReadonlySet<string>,
  today: string,
): StoredAlert | null {
  const current = alert.openingCheck;
  if (!current || current.status !== "pending") return null;
  const due = nextChicagoTradingDay(alert.tradingDay);
  if (!due || today < due) return null;
  if (today > due) {
    return finish(alert, {
      status: "missing",
      priorOpenInterest: current.priorOpenInterest,
      volume: current.volume,
      nextOpenInterest: null,
      checkedOn: today,
    });
  }
  if (!seen.has(alert.ticker)) return null;
  const nextOi = interest.openInterest[alert.contractKey];
  if (typeof nextOi !== "number") {
    return finish(alert, {
      status: "missing",
      priorOpenInterest: current.priorOpenInterest,
      volume: current.volume,
      nextOpenInterest: null,
      checkedOn: today,
    });
  }
  const read = classifyOpening({
    priorOpenInterest: current.priorOpenInterest,
    volume: current.volume,
    nextOpenInterest: nextOi,
  });
  if (read == null) return null;
  return finish(alert, {
    status: read,
    priorOpenInterest: current.priorOpenInterest,
    volume: current.volume,
    nextOpenInterest: nextOi,
    checkedOn: today,
  });
}

function finish(alert: StoredAlert, check: OpeningCheck): StoredAlert {
  const features = alert.features
    ? { ...alert.features, openingCheck: check.status as OpeningStatus }
    : alert.features;
  return { ...alert, openingCheck: check, features };
}
