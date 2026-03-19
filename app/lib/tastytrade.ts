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

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "User-Agent": "OptionsEdgeScanner/1.0",
};

export async function authenticate(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry - 60000) {
    return accessToken;
  }
  const clientSecret = process.env.TASTYTRADE_CLIENT_SECRET;
  const refreshToken = process.env.TASTYTRADE_REFRESH_TOKEN;
  if (!clientSecret || !refreshToken) {
    throw new Error(
      "Missing TASTYTRADE_CLIENT_SECRET or TASTYTRADE_REFRESH_TOKEN. " +
      "Go to developer.tastytrade.com → OAuth Applications → Manage to get these."
    );
  }
  const res = await fetch(`${getBaseUrl()}/oauth/token`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify({
      grant_type: "refresh_token",
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Tastytrade OAuth failed (${res.status}): ${err}`);
  }
  const data = await res.json();
  accessToken =
    data.data?.["access-token"] ||
    data.access_token ||
    data.data?.["session-token"];
  tokenExpiry = Date.now() + 14 * 60 * 1000;
  if (!accessToken) {
    throw new Error(`Tastytrade OAuth: no token in response: ${JSON.stringify(data)}`);
  }
  return accessToken;
}

async function ttFetch(path: string) {
  const token = await authenticate();
  const res = await fetch(`${getBaseUrl()}${path}`, {
    headers: { ...HEADERS, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    if (res.status === 401) {
      // Force re-auth once on 401
      accessToken = null;
      tokenExpiry = 0;
      const retryToken = await authenticate();
      const retry = await fetch(`${getBaseUrl()}${path}`, {
        headers: { ...HEADERS, Authorization: `Bearer ${retryToken}` },
      });
      if (!retry.ok) {
        const err = await retry.text();
        throw new Error(`Tastytrade API error (${retry.status}): ${err}`);
      }
      return retry.json();
    }
    const err = await res.text();
    throw new Error(`Tastytrade API error (${res.status}): ${err}`);
  }
  return res.json();
}

// ─── Account ───────────────────────────────────────────────────────────────

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

// ─── Market Metrics (Vol Arb) ──────────────────────────────────────────────

export async function getMarketMetrics(symbols: string[]) {
  const query = symbols.join(",");
  const data = await ttFetch(`/market-metrics?symbols=${encodeURIComponent(query)}`);
  return data.data?.items || [];
}

/**
 * Returns market metrics for a single symbol as a flat object.
 * Used by the Vol Arb tab via action=volatility.
 */
export async function getVolatilityMetrics(symbol: string) {
  const items = await getMarketMetrics([symbol]);
  // items is an array — find the matching symbol or return the first item
  const item = items.find((i: any) => i.symbol === symbol) ?? items[0] ?? {};
  return item;
}

// ─── Option Chain ──────────────────────────────────────────────────────────

/**
 * Returns the list of available expirations for a symbol.
 * Used by Chain tab to populate the expiration dropdown.
 */
export async function getExpirations(symbol: string) {
  const data = await ttFetch(`/option-chains/${encodeURIComponent(symbol)}/nested`);
  const expirations: any[] = data.data?.items?.[0]?.expirations ?? [];
  // Return a flat list of expiration objects with just the date
  return expirations.map((ex: any) => ({
    "expiration-date": ex["expiration-date"] ?? ex.expiration_date ?? "",
    "expiration-type": ex["expiration-type"] ?? "",
    "days-to-expiration": ex["days-to-expiration"] ?? 0,
  }));
}

/**
 * Returns strikes for a specific symbol + expiration date.
 * Each strike has call and put legs with greeks and bid/ask.
 * Used by Chain tab after user selects an expiration.
 */
export async function getOptionChain(symbol: string, expiration?: string) {
  const data = await ttFetch(`/option-chains/${encodeURIComponent(symbol)}/nested`);
  const expirations: any[] = data.data?.items?.[0]?.expirations ?? [];

  if (!expiration) {
    // No expiration specified — return first expiration's strikes
    return expirations[0]?.strikes ?? [];
  }

  // Find the matching expiration
  const match = expirations.find(
    (ex: any) =>
      (ex["expiration-date"] ?? ex.expiration_date ?? "") === expiration
  );

  return match?.strikes ?? [];
}
