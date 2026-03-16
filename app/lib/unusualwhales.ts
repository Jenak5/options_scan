const UW_BASE = "https://api.unusualwhales.com/api";

function getHeaders() {
  return {
    Authorization: `Bearer ${process.env.UNUSUAL_WHALES_API_TOKEN}`,
    Accept: "application/json",
  };
}

async function uwFetch(path: string, params?: Record<string, string>) {
  const url = new URL(`${UW_BASE}${path}`);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const res = await fetch(url.toString(), { headers: getHeaders() });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Unusual Whales API error (${res.status}): ${err}`);
  }
  return res.json();
}

export interface FlowAlertParams {
  ticker_symbol?: string;
  min_premium?: string;
  is_sweep?: string;
  is_otm?: string;
  size_greater_oi?: string;
  limit?: string;
  side?: string;
}

export async function getFlowAlerts(params?: FlowAlertParams) {
  const data = await uwFetch("/option-trades/flow-alerts", params as Record<string, string>);
  return data.data || [];
}

export async function getDarkPoolRecent(ticker?: string) {
  if (ticker) {
    const data = await uwFetch(`/darkpool/${ticker}`);
    return data.data || [];
  }
  const data = await uwFetch("/darkpool/recent");
  return data.data || [];
}

export async function getDarkPoolTicker(ticker: string) {
  const data = await uwFetch(`/darkpool/${ticker}`);
  return data.data || [];
}

export async function getMarketTide(interval5m?: boolean) {
  const data = await uwFetch("/market/tide", interval5m ? { interval_5m: "true" } : {});
  return data.data || {};
}

export async function getStockInfo(ticker: string) {
  const data = await uwFetch(`/stock/${ticker}/info`);
  return data.data || {};
}

export async function getStockVolatility(ticker: string) {
  const data = await uwFetch(`/stock/${ticker}/volatility`);
  return data.data || {};
}

export async function getGammaExposure(ticker: string) {
  const data = await uwFetch(`/stock/${ticker}/greek-exposure`);
  return data.data || {};
}
