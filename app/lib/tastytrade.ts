// Read-only Tastytrade client.
// Authentication is the OAuth refresh-token grant only. Tastytrade removed
// username/password session login on 2026-02-11; this module must not send
// a username, password, or session-token, and it must not place orders.

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

/**
 * One token refresh, for the status banner. The response body is not returned.
 * A 400 here is the refresh token being rejected, which is what showed up on Oct 1.
 */
export async function probeTastytrade(): Promise<{ ok: boolean; status: number | null; message: string }> {
  const clientSecret = process.env.TASTYTRADE_CLIENT_SECRET;
  const refreshToken = process.env.TASTYTRADE_REFRESH_TOKEN;
  if (!clientSecret || !refreshToken) {
    return {
      ok: false,
      status: null,
      message: "Tastytrade is not configured. Positions and balances stay blank until TASTYTRADE_CLIENT_SECRET and TASTYTRADE_REFRESH_TOKEN are set. Schwab quotes are separate.",
    };
  }
  try {
    await authenticate();
    return { ok: true, status: 200, message: "Tastytrade login succeeded." };
  } catch (err) {
    const raw = err instanceof Error ? err.message : "Tastytrade login failed.";
    const match = /failed \((\d+)\)/.exec(raw);
    const status = match ? Number(match[1]) : null;
    if (status === 400) {
      return {
        ok: false,
        status,
        message: "Tastytrade login failed (HTTP 400). The refresh token was rejected, so positions and balances are unavailable until that token is replaced in Vercel. Schwab quotes are separate.",
      };
    }
    if (status != null) {
      return {
        ok: false,
        status,
        message: `Tastytrade login failed (HTTP ${status}). Positions and balances are unavailable. Schwab quotes are separate.`,
      };
    }
    return {
      ok: false,
      status: null,
      message: "Tastytrade login failed. Positions and balances are unavailable. Schwab quotes are separate.",
    };
  }
}

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
    throw new Error(`Tastytrade OAuth failed (${res.status})`);
  }
  const data = await res.json();
  accessToken =
    data.data?.["access-token"] ||
    data["access-token"] ||
    data.access_token ||
    null;
  tokenExpiry = Date.now() + 14 * 60 * 1000;
  if (!accessToken) {
    throw new Error("Tastytrade OAuth: response did not include an access token");
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
 * Returns strikes for a symbol + expiration WITH live bid/ask/greeks.
 * ★ Uses /compact endpoint — /nested only returns OCC symbols, no quotes.
 * Compact response shape: data.data.items[] each with call/put legs containing
 * bid, ask, delta, gamma, theta, vega, implied-volatility.
 */
export async function getOptionChain(symbol: string, expiration?: string) {
  if (!expiration) {
    const exps = await getExpirations(symbol);
    const today = new Date().toISOString().slice(0, 10);
    const first = exps.find((e: any) => (e["expiration-date"] ?? "") > today);
    expiration = first?.["expiration-date"] ?? exps[0]?.["expiration-date"];
    if (!expiration) return [];
  }
  const data = await ttFetch(
    `/option-chains/${encodeURIComponent(symbol)}/compact?expiration-date=${expiration}`
  );
  return data.data?.items ?? [];
}
