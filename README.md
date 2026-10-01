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

`/login` checks `APP_PASSWORD` and sets an **httpOnly, Secure, SameSite=Lax** cookie signed with `SESSION_SECRET`. The cookie lasts 7 days. Lax is required so the cookie is sent when Schwab redirects the browser back to this app. Strict cookies are dropped on that cross-site GET, which used to bounce her to `/login` in a loop.

If a page needs a session and she is signed out, middleware sends her to `/login?next=<path>`. `next` is a same-origin path only (no other host, no protocol-relative URL, no `/login`). After a successful sign-in the browser returns to that path. `/api/schwab/connect` is one of those paths, so Reconnect Schwab resumes instead of dumping her on the dashboard.

Middleware requires that cookie, or `Authorization: Bearer <CRON_SECRET>`, on every page and `/api` route except:

- `/login` and `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/cron` (bearer check inside the route)

`GET /api/schwab/callback` requires the app session. It is not a public route.

`/api/tastytrade` and `/api/alerts` check again in the route: app session or bearer. `/api/alerts` POST only forwards text to Telegram. It does not talk to the broker.

If `APP_PASSWORD`, `SESSION_SECRET`, or `CRON_SECRET` is missing, the check that depends on it fails closed.

Keep Vercel SSO on until you have signed in through `/login` and confirmed sign-in works.

## Environment variables

Set every secret in Vercel as a **Sensitive** variable. Do not leave them readable in the dashboard, and do not commit real values.

| Variable | Sensitive | Purpose |
|----------|-----------|---------|
| `CRON_SECRET` | Yes | Bearer token Vercel cron sends |
| `APP_PASSWORD` | Yes | Password for `/login` |
| `SESSION_SECRET` | Yes | Signs the session cookie and the Schwab OAuth state cookie |
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
| `KV_REST_API_URL` | Yes | Vercel KV REST URL. Required in production unless the Upstash pair below is set. |
| `KV_REST_API_TOKEN` | Yes | Vercel KV REST token. Required in production unless the Upstash pair below is set. |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis REST URL. Used when `KV_REST_API_URL` is not set. |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis REST token. Used when `KV_REST_API_TOKEN` is not set. |
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

Sign in to the scanner first, then use Reconnect Schwab. `/api/schwab/connect` stores a signed OAuth `state` in a short-lived **httpOnly, Secure, SameSite=Lax** cookie (`oes_schwab_oauth_state`, 10 minutes, HMAC-signed with `SESSION_SECRET`). Schwab sends the browser to `/api/schwab/callback`. That request must include both the app session and a `state` query value that matches the signed cookie. The code is exchanged on the server. Tokens are not put in the redirect, the page, or the status JSON.

Success redirects to the dashboard (`/?schwab=connected`) and the banner says **Schwab connected**. A failed check, a denied approval, or a token exchange error redirects to the dashboard with a readable error. The app does not send her back to Schwab on its own.

If the session cookie is missing on the callback, she goes to `/login?next=/api/schwab/callback?...` and returns there after sign-in. The state cookie is left in place so the check can still pass.

### Where the tokens live

Set **one** of these pairs. Names are exact:

| Store | Environment variables |
|-------|------------------------|
| Vercel KV | `KV_REST_API_URL` and `KV_REST_API_TOKEN` |
| Upstash Redis | `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` |

If both pairs are set, `KV_REST_API_URL` and `KV_REST_API_TOKEN` are used. The value written there is encrypted with a key derived from `SESSION_SECRET`.

If neither pair is set **in production** (including on Vercel), the app does **not** fall back to process memory. Memory does not survive across serverless instances, so a connection saved that way looks lost on the next request. The dashboard banner says storage is not configured and names `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `UPSTASH_REDIS_REST_URL`, and `UPSTASH_REDIS_REST_TOKEN`. Connect and the callback refuse to save a token until one pair is set.

Process memory is only for local development, when `NODE_ENV` is not `production` and `VERCEL` is not `1`. A restart drops that token.

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
