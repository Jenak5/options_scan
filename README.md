# Options Edge Scanner

Read-only scan-and-alert tool for a small personal options account ($3,000, max loss $450 per trade). It reads flow, quotes, positions, and balances, and it can send a Telegram message.

**This app never places orders.** There is no order or transaction write endpoint. Schwab is used for Market Data Production only. The Tastytrade OAuth application must use a read-only scope.

## What it shows

| Tab | Source | What it does |
|-----|--------|--------------|
| Flow | Unusual Whales | Live options flow |
| Dark Pool | Unusual Whales | Dark pool prints |
| Vol Arb | Tastytrade | IV versus realized volatility |
| Account | Tastytrade | Positions, P&L, balances, buying power (read-only) |
| Gate | Schwab | Live chain check. Overall PASS only if every rule passes. |
| Kelly Lab | Local | Retired sizing illustration. Not the account model. |
| Chain | Tastytrade | Option chain quotes |
| Research | Grok (xAI) | Chat grounded in the scanner's current data |
| Alerts | Telegram | Test a Telegram alert; scheduled scans run from cron |

## Schedule

Vercel cron calls `GET /api/cron` every 15 minutes from **13:30 through 21:00 UTC**, Monday–Friday. That span covers the US cash session in both Central Daylight Time and Central Standard Time.

The handler then checks **America/Chicago** and exits immediately outside **8:30–15:00 Central**, weekdays. A run can pass `?manual=true` to skip that hours check. That flag is not a secret. The request still needs the bearer token.

Vercel sends `Authorization: Bearer <CRON_SECRET>`. The route accepts that header only. It does not accept `?secret=` or `x-cron-secret`, because secrets in URLs end up in logs.

## Sign-in

`/login` checks `APP_PASSWORD` and sets an **httpOnly, Secure, SameSite=Strict** cookie signed with `SESSION_SECRET`. The cookie lasts 7 days.

Middleware requires that cookie, or `Authorization: Bearer <CRON_SECRET>`, on every page and `/api` route except:

- `/login` and `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/cron` (bearer check inside the route)
- `GET /api/schwab/callback` (OAuth `state` cookie only — see Schwab below)

`/api/tastytrade` and `/api/alerts` check again in the route: app session or bearer. `/api/alerts` POST only forwards text to Telegram. It does not talk to the broker.

If `APP_PASSWORD`, `SESSION_SECRET`, or `CRON_SECRET` is missing, the check that depends on it fails closed.

Keep Vercel SSO on until you have signed in through `/login` and confirmed sign-in works.

## Environment variables

Set every secret in Vercel as a **Sensitive** variable. Do not leave them readable in the dashboard, and do not commit real values.

| Variable | Sensitive | Purpose |
|----------|-----------|---------|
| `CRON_SECRET` | Yes | Bearer token Vercel cron sends |
| `APP_PASSWORD` | Yes | Password for `/login` |
| `SESSION_SECRET` | Yes | Signs the session cookie |
| `TASTYTRADE_CLIENT_SECRET` | Yes | OAuth client secret |
| `TASTYTRADE_REFRESH_TOKEN` | Yes | OAuth refresh token |
| `TASTYTRADE_ACCOUNT_NUMBER` | Yes | Account to read |
| `TASTYTRADE_ENV` | No | `production` for the live account. `sandbox` is the cert API. |
| `UNUSUAL_WHALES_API_TOKEN` | Yes | Unusual Whales API token |
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Chat that receives alerts |
| `XAI_API_KEY` | Yes | Grok API key for screening and research |
| `SCHWAB_CLIENT_ID` | Yes | Schwab Market Data app key |
| `SCHWAB_CLIENT_SECRET` | Yes | Schwab Market Data app secret |
| `SCHWAB_REDIRECT_URI` | Yes | Must match the callback URL registered on the Schwab app |
| `KV_REST_API_URL` | Yes | Vercel KV / Upstash REST URL for Schwab tokens. Optional locally. |
| `KV_REST_API_TOKEN` | Yes | Vercel KV / Upstash REST token. Optional locally. |
| `UPSTASH_REDIS_REST_URL` | Yes | Alternate token-store URL if Vercel KV vars are not set |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Alternate token-store token if Vercel KV vars are not set |
| `ALERT_MIN_PREMIUM` | No | Alert filter |
| `ALERT_SWEEPS_ONLY` | No | Alert filter |
| `ALERT_OTM_ONLY` | No | Alert filter |
| `NEXT_PUBLIC_DEFAULT_WATCHLIST` | No | Browser-visible default tickers |

Tastytrade auth is the **OAuth refresh-token grant only**. Do not set a tastytrade username or password. Username/password session login was removed by tastytrade on 2026-02-11.

`TASTYTRADE_ENV` should be `production` for this account, and the OAuth scope must be **read-only**.

Generate the three app secrets locally, for example with `openssl rand -base64 32`, and paste them only into Vercel's Sensitive variable form. Trigger a cron run without putting the secret in the URL:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://<your-deployment>/api/cron"
```

## Account size

The account is **$3,000**. The most one trade can lose is **$450** (15%). Those numbers live in `app/lib/risk.ts` and the Gate uses them.

The old Kelly Lab assumed a **$5,000** account and a **55%** win rate. That model is retired. The Kelly tab is only an illustration, and it is not used to size a trade.

## Schwab market data

Schwab is the real-time quote source for the Gate. The developer app should have the **Market Data Production** product only. This repo does not call the trader API, and it does not place orders, even if a trading product were turned on later.

Three variables, all **Sensitive** in Vercel:

- `SCHWAB_CLIENT_ID` — the app key
- `SCHWAB_CLIENT_SECRET` — the app secret
- `SCHWAB_REDIRECT_URI` — the callback, for example `https://<your-domain>/api/schwab/callback`

Set the same callback URL on the Schwab developer app. A mismatch is the usual reason connect fails.

OAuth is the authorization-code flow. The access token lasts about **30 minutes** and is refreshed on the server. The refresh token lasts **7 days**, so she re-authorizes in the browser about once a week. The dashboard banner has **Reconnect Schwab**. When fewer than **2 days** are left, the banner warns and Telegram gets a note (same sender as the other alerts). A failed refresh sends a Telegram note too. Neither message contains a token.

Sign in to the scanner first, then use Reconnect Schwab. Schwab sends the browser to `/api/schwab/callback`. The session cookie is `SameSite=Strict`, so it is not included on that cross-site redirect. The callback is allowed through middleware and is checked with a short-lived `SameSite=Lax` state cookie instead. The code is exchanged on the server. Tokens are not put in the redirect, the page, or the status JSON.

### Where the tokens live

| Store | When |
|-------|------|
| Vercel KV | `KV_REST_API_URL` and `KV_REST_API_TOKEN` are set |
| Upstash Redis | `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are set, and the KV pair is not |
| Process memory | Neither pair is set |

KV and Upstash are the right store on Vercel. The value written there is encrypted with a key derived from `SESSION_SECRET`. Process memory is the local fallback: a restart or a cold start drops the token, and she has to reconnect. Do not expect the memory fallback to survive in production.

Status (`GET /api/schwab/status`, session required) reports connected, expired, and days left on the refresh token. It does not return the tokens.

## Trade gate

`/gate` asks for the ticker, expiration, strike, call or put, contracts, and planned entry. It also asks for an underlying stop, a time stop, a profit-taking rule, and how many losses in a row she has today.

`POST /api/gate` (session required) reads the live Schwab chain and runs the checks in `app/lib/gate.ts`:

- Open interest at the strike is at least 500
- Volume today is at least 100 contracts
- Bid-ask spread is at most 5% of the midpoint
- Max loss is at most $450. A long option is `contracts × ask × 100`. A debit spread is `contracts × strike width × 100` (the most that spread can be worth). Leave the width blank for a single option.
- If one contract at the ask is already over $450, the result says so and suggests a debit spread
- The three exit rules have to be filled in
- Two losses in a row is a NO for the day. The trade log is not stored yet; type the count.

Each check is PASS or FAIL. Any FAIL makes the overall result **NO**. Quotes Schwab marks as delayed are a FAIL, because this account needs real-time data.

The checks are pure functions. `npm test` runs them against fixture chains and does not call Schwab.

## Telegram setup

1. Message @BotFather → `/newbot` → copy the token.
2. Start a chat with the bot and send `/start`.
3. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` once and copy `chat_id`. That URL contains the bot token, so do not share it or commit it.
4. Store `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` as Sensitive variables.
5. After you are signed in, use **Send test Telegram alert** on the Alerts tab.

## Deploy notes

Do not deploy from this branch until the owner checklist on the pull request is done. Production deploys stay on `main`.

## Security

- The app never places orders and never submits broker transactions.
- API keys stay on the server.
- The cron secret is not accepted from a URL.
- Do not commit `.env.local`.

## Disclaimer

Educational and research use only. Not financial advice. Options involve a significant risk of loss.
