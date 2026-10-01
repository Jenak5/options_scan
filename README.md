# Options Edge Scanner

Read-only scan-and-alert tool for a small personal options account. It reads flow, quotes, positions, and balances, and it can send a Telegram message.

**This app never places orders.** There is no order or transaction write endpoint. The Tastytrade OAuth application must use a read-only scope.

## What it shows

| Tab | Source | What it does |
|-----|--------|--------------|
| Flow | Unusual Whales | Live options flow |
| Dark Pool | Unusual Whales | Dark pool prints |
| Vol Arb | Tastytrade | IV versus realized volatility |
| Account | Tastytrade | Positions, P&L, balances, buying power (read-only) |
| Kelly Lab | Local | Kelly criterion calculator |
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

`/api/tastytrade` and `/api/alerts` check again in the route: app session or bearer. `/api/alerts` POST only forwards text to Telegram. It does not talk to the broker.

If `APP_PASSWORD`, `SESSION_SECRET`, or `CRON_SECRET` is missing, the check that depends on it fails closed.

Keep Vercel SSO on until you have signed in through `/login` and confirmed the gate works.

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
| `ALERT_MIN_PREMIUM` | No | Alert filter |
| `ALERT_SWEEPS_ONLY` | No | Alert filter |
| `ALERT_OTM_ONLY` | No | Alert filter |
| `NEXT_PUBLIC_DEFAULT_WATCHLIST` | No | Browser-visible default tickers |

Tastytrade auth is the **OAuth refresh-token grant only**. Do not set a tastytrade username or password. Username/password session login was removed by tastytrade on 2026-02-11.

`TASTYTRADE_ENV` should be `production` for this account, and the OAuth scope must be **read-only**.

Generate the three app secrets locally, for example with `openssl rand -base64 32`, and paste them only into Vercel's Sensitive variable form.

Trigger a cron run without putting the secret in the URL:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://<your-deployment>/api/cron"
```

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
