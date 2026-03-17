const BASE_URLS = {
  sandbox: "https://api.cert.tastyworks.com",
  production: "https://api.tastyworks.com",
} as const;

let accessToken: string | null = null;
let tokenExpiry: number = 0;

function getBaseUrl(): string {
  const env = process.env.TASTYTRADE_ENV || "sandbox";
  return BASE_URLS[env as keyof typeof BASE_URLS] || BASE_URLS.sandbox;
}

const HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "OptionsEdgeScanner/1.0",
};

export async function authenticate(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry) return accessToken;

  const res = await fetch(`${getBaseUrl()}/oauth/token`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_secret: process.env.TASTYTRADE_CLIENT_SECRET,
      refresh_token: process.env.TASTYTRADE_REFRESH_TOKEN,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tastytrade OAuth failed (${res.status}): ${err}`);
  }

  const data = await res.json();
  accessToken = data.data?.["access-token"] || data.access_token || data.data?.["session-token"];
  tokenExpiry = Date.now() + 23 * 60 * 60 * 1000;
  return accessToken!;
}

async function ttFetch(path: string) {
  const token = await authenticate();
  const res = await fetch(`${getBaseUrl()}${path}`, {
    headers: {
      ...HEADERS,
      Authorization: `Bearer ${token}`,
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tastytrade API error (${res.status}): ${err}`);
  }
  return res.json();
}

export async function getPositions(accountNumber?: string) {
  const acct = accountNumber || process.env.TASTYTRADE_ACCOUNT_NUMBER;
  const data = await ttFetch(`/accounts/${acct}/positions`);
  return data.data?.items || [];
}

export async function getBalances(accountNumber?: string) {
  const acct = accountNumber || process.env.TASTYTRADE_ACCOUNT_NUMBER;
  const data = await ttFetch(`/accounts/${acct}/balances`);
  return data.data || {};
}

export async function getOptionChain(symbol: string) {
  const data = await ttFetch(`/option-chains/${encodeURIComponent(symbol)}/nested`);
  return data.data || {};
}

export async function getMarketMetrics(symbols: string[]) {
  const query = symbols.join(",");
  const data = await ttFetch(`/market-metrics?symbols=${encodeURIComponent(query)}`);
  return data.data?.items || [];
}

export async function getLiveOrders(accountNumber?: string) {
  const acct = accountNumber || process.env.TASTYTRADE_ACCOUNT_NUMBER;
  const data = await ttFetch(`/accounts/${acct}/orders/live`);
  return data.data?.items || [];
}

export async function getNetLiqHistory(accountNumber?: string, timeBack?: string) {
  const acct = accountNumber || process.env.TASTYTRADE_ACCOUNT_NUMBER;
  const data = await ttFetch(`/accounts/${acct}/net-liq/history?time-back=${timeBack || "1m"}`);
  return data.data?.items || [];
}
