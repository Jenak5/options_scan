# Options Edge Scanner

Read-only scan-and-alert tool for a small personal options account ($5,000, max loss $875 per trade). It reads flow, quotes, positions, and balances, and it can send a Telegram message.

**This app never places orders.** There is no order or transaction write endpoint. Schwab is used for Market Data Production only. The Tastytrade OAuth application must use a read-only scope.

## What it shows

| Tab | Source | What it does |
|-----|--------|--------------|
| Flow | Schwab | Estimated flow from volume and open interest. Not sweeps. |
| Vol Arb | Schwab | ATM implied vol versus 20-day realized vol, plus term structure and skew |
| Account | Tastytrade | Positions, P&L, balances, buying power (read-only) |
| Gate | Schwab | Live chain check. Overall PASS only if every rule passes. |
| Kelly Lab | Local | Retired sizing illustration. Not the account model. |
| Research | Grok (xAI) | Chat grounded in the scanner's current data |
| Alerts | Telegram | Test a Telegram alert; scheduled scans run from cron |
| Alert Report | Saved alerts | Checklist grade at send time, then midpoint checks |

## Schedule

Vercel cron calls `GET /api/cron` every 15 minutes from **13:30 through 21:00 UTC**, Monday–Friday. That span covers the US cash session in both Central Daylight Time and Central Standard Time.

The handler then checks **America/Chicago** and exits immediately outside **8:30–15:00 Central**, weekdays, except for a short close check. A run can pass `?manual=true` to skip that hours check. That flag is not a secret. The request still needs the bearer token.

From **15:00 through 15:20 Central** the same route only re-quotes alerts already sent that day. It does not send new Telegram alerts in that window. That quote is the same-day close. 15-minute and 1-hour checks run on the regular in-session crons.

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
| `TELEGRAM_BOT_TOKEN` | Yes | Bot token from @BotFather |
| `TELEGRAM_CHAT_ID` | Yes | Chat that receives alerts |
| `XAI_API_KEY` | Yes | Grok API key for screening and research |
| `SCHWAB_CLIENT_ID` | Yes | Schwab Market Data app key |
| `SCHWAB_CLIENT_SECRET` | Yes | Schwab Market Data app secret |
| `SCHWAB_REDIRECT_URI` | Yes | Must match the callback URL registered on the Schwab app |
| `KV_REST_API_URL` | Yes | Vercel KV REST URL. Used when both KV variables are set. |
| `KV_REST_API_TOKEN` | Yes | Vercel KV REST token. Used when both KV variables are set. |
| `UPSTASH_REDIS_REST_URL` | Yes | Upstash Redis REST URL. Used when the KV pair is not complete and both Upstash variables are set. |
| `UPSTASH_REDIS_REST_TOKEN` | Yes | Upstash Redis REST token. Used when the KV pair is not complete and both Upstash variables are set. |
| `BLOB_READ_WRITE_TOKEN` | Yes | Private Vercel Blob token. Used when neither Redis pair is complete. |
| `ALERT_MIN_PREMIUM` | No | Minimum estimated flow premium (volume × mid × 100) before a contract is considered for a Telegram alert. Default $50,000, the B floor. An A still needs $100,000 at grade time. |
| `ALERT_OTM_ONLY` | No | When `true`, alerts also require the contract to be out of the money |
| `ALERT_MAX_PER_DAY` | No | Max Telegram alerts per Chicago trading day. Default 5. Only 1–50 is accepted. |
| `FLOW_WATCHLIST` | No | Comma-separated tickers for the flow scan and cron. Optional. |
| `NEXT_PUBLIC_DEFAULT_WATCHLIST` | No | Browser-visible default tickers |
| `ACCOUNT_SIZE_DOLLARS` | No | Account size used for the weekly drawdown flag (25% of this). Default 5000. Empty, zero, or invalid keeps 5000. Not a secret. |
| `MAX_LOSS_DOLLARS` | No | Loss cap and grade cost ceiling for one contract. Default 875 (17.5% of the $5,000 account). The Gate, alerts, Grade my trade, and the paper trade log all read this. Empty or invalid keeps 875. |

Tastytrade auth is the **OAuth refresh-token grant only**. Do not set a tastytrade username or password. Username/password session login was removed by tastytrade on 2026-02-11.

`TASTYTRADE_ENV` should be `production` for this account, and the OAuth scope must be **read-only**.

Generate the three app secrets locally, for example with `openssl rand -base64 32`, and paste them only into Vercel's Sensitive variable form. Trigger a cron run without putting the secret in the URL:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" "https://<your-deployment>/api/cron"
```

## Account size

The account is **$5,000**. The most one trade can lose is **$875**, which is 17.5% of that account. Both numbers live in `app/lib/risk.ts`. Set `ACCOUNT_SIZE_DOLLARS` to change the account size and `MAX_LOSS_DOLLARS` to change the cap. An empty or invalid value keeps 5000 and 875. The weekly drawdown flag is 25% of the account (**$1,250** at the default). The Gate, the checklist, the alerts, Grade my trade, and the paper trade log all use the cap.

The old Kelly Lab assumed a **55%** win rate. That model is retired. The Kelly tab is only an illustration, and it is not used to size a trade. The account size shown there is the same $5,000.

## Schwab market data

Schwab is the real-time quote source for the Gate. The developer app should have the **Market Data Production** product only. This repo does not call the trader API, and it does not place orders, even if a trading product were turned on later.

Three variables, all **Sensitive** in Vercel:

- `SCHWAB_CLIENT_ID` — the app key
- `SCHWAB_CLIENT_SECRET` — the app secret
- `SCHWAB_REDIRECT_URI` — the callback, for example `https://<your-domain>/api/schwab/callback`

Set the same callback URL on the Schwab developer app. A mismatch is the usual reason connect fails.

OAuth is the authorization-code flow. The access token lasts about **30 minutes** and is refreshed on the server. The refresh token lasts **7 days**, so she re-authorizes in the browser about once a week. The dashboard banner has **Reconnect Schwab**. When fewer than **2 days** are left, the banner warns and Telegram gets a note (same sender as the other alerts). A failed refresh sends a Telegram note too. Neither message contains a token.

The same banner sits on every signed-in page. It says so when Schwab is disconnected, when the refresh token is near expiry (with a countdown), or when no successful scan has been recorded for more than 30 minutes during Chicago market hours. Outside those hours a quiet market is not treated as a failed scan. A skipped cron run writes a warning to the log and sends the same Telegram channel used for A/B alerts, at most once every 30 minutes. The last successful scan and the last run outcome are stored with the other app records. Tastytrade is checked on that same cron run (one login attempt, not a Schwab request). An HTTP 400 means the refresh token was rejected. Positions and balances stay blank until that token is replaced. Schwab quotes are separate.

Sign in to the scanner first, then use Reconnect Schwab. `/api/schwab/connect` stores a signed OAuth `state` in a short-lived **httpOnly, Secure, SameSite=Lax** cookie (`oes_schwab_oauth_state`, 10 minutes, HMAC-signed with `SESSION_SECRET`). Schwab sends the browser to `/api/schwab/callback`. That request must include both the app session and a `state` query value that matches the signed cookie. The code is exchanged on the server. Tokens are not put in the redirect, the page, or the status JSON.

Success redirects to the dashboard (`/?schwab=connected`) and the banner says **Schwab connected**. A failed check, a denied approval, or a token exchange error redirects to the dashboard with a readable error. The app does not send her back to Schwab on its own.

If the session cookie is missing on the callback, she goes to `/login?next=/api/schwab/callback?...` and returns there after sign-in. The state cookie is left in place so the check can still pass.

### Where the tokens live

Set **one** of these pairs. Names are exact:

| Store | Environment variables |
|-------|------------------------|
| Vercel KV | `KV_REST_API_URL` and `KV_REST_API_TOKEN` |
| Upstash Redis | `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` |
| Vercel Blob | `BLOB_READ_WRITE_TOKEN` |

A complete KV pair wins. Otherwise a complete Upstash pair. Otherwise `BLOB_READ_WRITE_TOKEN`. The value written there is encrypted with a key derived from `SESSION_SECRET`. Blob is a private store. The encrypted envelope lives at a fixed pathname, `schwab/tokens.json`. Reads bypass the CDN cache, because a refresh token rotates and a stale copy must not be written back over a newer one.

If none of those are set **in production** (including on Vercel), the app does **not** fall back to process memory. Memory does not survive across serverless instances, so a connection saved that way looks lost on the next request. The dashboard banner says storage is not configured and names `KV_REST_API_URL`, `KV_REST_API_TOKEN`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, and `BLOB_READ_WRITE_TOKEN`. Connect and the callback refuse to save a token until one store is set.

Process memory is only for local development, when `NODE_ENV` is not `production` and `VERCEL` is not `1`. A restart drops that token.

Status (`GET /api/schwab/status`, session required) reports connected, expired, and days left on the refresh token. It does not return the tokens.

Volume snapshots for the flow scanner use the same store, on a separate key. Redis uses `oes:flow:snapshots`. Blob uses the private pathname `schwab/flow-snapshots.json`. That file is small JSON of prior contract volume. It is not a token and it is not encrypted. The token envelope at `schwab/tokens.json` is unchanged.

Sent alerts use that same store again. Redis key `oes:alert:records`. Blob pathname `schwab/alert-book.json`, private. The file holds the checklist grade, the quote at send time, and later midpoint checks. It is not a token and it is not encrypted. No new environment variable. If none of the stores are set in production, alerts can still be sent, and the report stays empty.

The trade log uses that store too. Redis key `oes:trade:log`. Blob pathname `schwab/trade-log.json`, private. A paper trade copies an A or B alert: ticker, call or put, strike, expiration, grade, flow premium, the ask as the entry, one contract unless she changes it, the time, and the alert id. A hand-typed row is still allowed. It is not a token, it is not a broker fill, and nothing new has to be set.

## Estimated flow

`GET /api/flow` (session required) scores option contracts from the Schwab chains endpoint. It does not call Unusual Whales, and it does not place orders.

The label on the Flow tab is: estimated flow from Schwab volume/open interest, not true sweeps. Side is estimated by comparing the last price to the bid and ask. There is no sweep flag and no dark-pool tab.

Each contract gets:

- volume / open interest
- volume minus open interest
- flow premium, which is volume × midpoint × 100 (an estimate, not an exchange-reported sweep)
- distance out of the money, and days to expiration
- spread quality
- volume change since the previous same-day scan

The default watchlist keeps the original 15 names (SPY, QQQ, IWM, AAPL, NVDA, TSLA, AMD, AMZN, MSFT, META, GOOGL, PLTR, SOFI, NFLX, COIN) and adds liquid banks (JPM, BAC, GS, WFC, C, MS), aerospace and industrials (BA, LMT, CAT, GE), oil and energy (XOM, CVX, OXY, XLE), and other liquid names (XLF, GLD, TLT, SMH, DIS, UBER, MU, AVGO, CRM, V, WMT, COST, HOOD, MSTR). That is 43 names. `FLOW_MAX_WATCHLIST` is 48. Set `FLOW_WATCHLIST` to replace the built-in list. It does not add to it. If that variable is set on Vercel, the new default is not used until the variable is cleared. A ticker typed into the filter scans that symbol only: one chain, two price-history reads, and one earnings lookup.

The original 15 names, plus any ticker with an open shadow alert or an open paper trade, are scanned on every cron run (every 15 minutes). The 28 added names rotate in two groups of 14, so each added name is scanned every 30 minutes. With nothing extra open, one pass is 29 names: 15 core plus 14 added.

Each scanned name is 1 chain, 2 price-history reads, and up to 2 earnings lookups on a cold start. Earnings lookups are not Schwab calls. A run can also do up to 8 follow-up chain reads, 20 alert checkpoint quotes, 16 shadow quotes, and 9 vol chain reads. That is 82 chain-style reads, under the 100 per minute cap. Real A and B shadows are quoted first. At most 4 of those 16 quotes are the 43–60 day test, and only when slots are left. The test does not add a quote on top of the 16. Price-history reads for key levels are 58, under the 60 per minute cap in the level scan. Vol history is 9 reads on the vol scan's own 60 per minute cap.

The extra facts saved with an alert (trend versus VWAP and the 20-day average, SPY and QQQ direction, minutes since the open, IV versus the prior session, estimated aggressor, repeat flow, and a likely spread or hedge) do not add a Schwab request. The 20-day average uses the daily candles already fetched for levels. SPY and QQQ direction uses those names when they are already in the same scan. Repeat flow and recent IV use the volume snapshot already stored. A paired spread is read from the chain already in hand. Grade my trade asks for calls and puts together on that same chain request. The request caps are unchanged: 100 chain-style reads a minute, 60 price-history reads a minute, and a 300 second route limit.

The planning figure is about 800ms per request, so this pass is about 76 seconds. That is longer than the old 60 second route limit. `maxDuration` on the cron, alerts, and flow routes is 300 seconds. Fluid compute allows 300 seconds on Hobby and defaults to 300 seconds on Pro (Pro can go higher). 300 seconds covers this pass, a slower Schwab response, and one rate-limit wait. Reading all 43 names in one pass would go over the 60 per minute history cap. The planning math is in `plannedCronBudget`.

The Flow tab still asks for 9 names at a time so one browser request can finish. Search is one ticker. If many open names outside the core 15 fill the history budget, the added-name group gets smaller so the run still fits, and the cron log states that slower refresh. The normal book does not need that. Cron stays on the existing every-15-minute schedule, so no extra cron entries were added. Sub-daily cron jobs need a paid Vercel plan. This project already runs every 15 minutes, and the schedule is still 3 entries, under the 100 cron jobs per project allowed on every plan.

Chain requests stay on the chains endpoint, with `range=NTM`, `strikeCount=6`, and a date window of 60 days. The extra days are the same one chain request per ticker, so a 43–60 day contract is in that response for the test shadows. It does not add a Schwab call, and it does not change the 14–42 day rule for an A or a B. Each ticker also gets two price-history reads: about a month of daily candles, and today's 5-minute candles with the extended session. Those history reads are cached per ticker for a few minutes. Schwab has no parameter for "how many expirations," so after the response the scorer keeps up to 24. Dates about 14 to 42 days out are kept ahead of the very short-dated ones, so a 2 to 6 week expiration is not dropped to make room for this week. Up to 4 expirations in the 43–60 day window are kept from that same response even when nearer dates already filled the 24. A date past 60 days is not kept for the test. Chain results are cached for about 60 seconds.

Illiquid contracts are hidden by default: open interest at least 500, volume at least 100, and bid-ask spread at most 5% of the midpoint. A contract whose midpoint is $3 or less also has to have a spread of $0.10 or less. Those are the same bars as the Gate. The Flow tab has a checkbox to show the rest. Each row has **Check in Gate**, which opens `/gate` with the ticker, expiration, strike, call or put, and the midpoint as the planned entry.

If Schwab is not connected, the tab says so and links to Reconnect Schwab.

Cron still requires `Authorization: Bearer <CRON_SECRET>` before anything else. It considers contracts that pass those liquidity filters, and only when estimated flow premium is at least `ALERT_MIN_PREMIUM` (default $50,000). `ALERT_OTM_ONLY=true` also requires the contract to be out of the money. A Telegram alert is sent only for a checklist **TAKE** graded **A** or **B**. An A needs at least $100,000 of that flow premium. A B needs at least $50,000. C and D stay on the Flow tab and are not saved in the alert book. At most `ALERT_MAX_PER_DAY` alerts go out on a Chicago trading day (default 5), and an A is sent before a B. The same ticker, call or put, and expiration is not alerted again that day. The Telegram text says the flow is estimated and shows the flow premium plus the ask and the cost of one contract.

## Alert checklist and report

Every Flow row carries a checklist verdict: **TAKE**, **WATCH**, or **SKIP**, a letter grade **A–D**, and two to four plain reasons. Telegram and the Alert Report only receive **A** and **B**. Thresholds that are not already in `app/lib/risk.ts` live in `app/lib/alertConfig.ts`, including the 14 to 42 day window for an A or a B and the daily alert cap.

The checklist uses the Gate for open interest (at least 500), volume today (at least 100), and spread (at most 5% of mid, and $0.10 or less when the midpoint is $3 or under). A failed liquidity check is an automatic **SKIP**, and that letter stays **D**. It is never an A or a B. The ask has to be at least $0.50. One long contract (ask × 100) can cost up to $875 and still be an A or a B. Cheaper than $0.50, or more than $875, stays at C or lower and nothing is sent. $875 is also the loss cap. One contract over $875 names a debit spread in the reason, and it cannot be an A or a B. The scanner grades single long options. A debit spread's max loss is its width, and the Gate compares that width with $875.

Flow premium is estimated as volume × midpoint × 100 from the Schwab chain. It is not an exchange-reported sweep and not a separate field in the volume snapshot. Snapshots store volume (and recent quote points). The premium is computed when the chain is scored, and that same number is what `/api/flow` returns as `notionalPremium`. An A needs at least $100,000 of it. A B needs at least $50,000. Below $50,000 cannot be an A or a B. That A/B dollar split is an assumption. The other A checks still apply: at least 3 of the 4 flow signals, volume at least 2× open interest, and a close strike. Flow strength, days to expiration, and distance from the money decide TAKE versus WATCH. An A or a B also has to be about 2 to 6 weeks out (14 to 42 days). Under 14 days, or past 42 days, the letter stays at C or lower and nothing is sent. The message includes the flow premium, the ask, the cost of one contract, and how many contracts fit under $875 at the ask.

Support and resistance come from that Schwab price history plus high-open-interest strikes on the chain already fetched (a call wall and a put wall). Prior day high, low, and close, the pre-market range, the open, the session high and low so far, an open-range window, a candle VWAP when volume is present, recent swing highs and lows, and nearby round numbers are the other levels. VWAP is the volume-weighted typical price of the candles, not a tick print. The nearest support and resistance, and the distance to each, show on the Flow row, the Gate result, the Telegram alert, and the Alert Report. Those two levels are stored on the alert. No new environment variable.

A call is favored when price is above support with room to the next resistance. A put is the mirror. The grade drops when a call is tight under resistance, a put is tight on support, or the reward to the next level is poor compared with the distance the other way. The letter can be an **A** only when those levels were computed. If price history is unavailable, the grade still stops at **B** and the checklist says so. Round numbers alone do not lift that cap. This is still a rules checklist, not a prediction of profit.

The daily stop reads closed trades in the trade log for the Chicago day. Two losing closes in a row turn a TAKE into **STOP for today** for the rest of that day. A later win does not clear it. There is no weekly loss limit. A week down about 25% of the account ($1,250 at the $5,000 default) is a flag on the log and the Flow tab, and it does not change the checklist.

New alerts, shadows, and paper trades are stamped with a rules version so Learning mode can compare results before and after a checklist change. Older rows stay "Not stamped". Version 2 adds four quality filters. These are filters to be checked on the scorecard. They are not a claim that the next trade makes money. The first 15 minutes after the Chicago open cannot be an A or a B. A likely spread or hedge (similar size on a neighboring strike or the opposite side, same expiration) cannot be an A. A trade that fights both the ticker's trend and SPY and QQQ cannot be an A. Unknown trend, market, or pairing does not change the grade. Earnings on or before expiration still drop the letter and name IV crush. An unknown earnings date still cannot be an A. A short-dated single with earnings today or tomorrow is still skipped unless it is a defined-risk spread. The $875 cap, premium-only risk, unknown-is-not-a-pass, and the two-loss daily stop are unchanged. Nothing places an order.

After a Telegram send for an A or a B, the cron stores the contract, the quote, the verdict, and the grade. Later runs re-read the Schwab chain and store the **mid** (not the last trade) and the underlying at about 15 minutes, 1 hour, and the close, plus the percent change in the option mid versus the alert mid. A missing quote or an expired contract is marked and skipped. The outcome label is **win** if the mid is up 20% or more at any of those checks, **miss** if the close mid is down 20% or more and nothing earlier won, and **flat** otherwise. Pending and unscored alerts are left out of the hit rate. That label is an estimate. It is not a fill and it is not trade profit or loss. A daily stop that turns a TAKE into STOP for today does not send a new alert.

Alert Report (session required, same as the other tabs) lists recent alerts and summarizes hit rate, average mid move at 1 hour and at the close, and the same numbers by ticker, by Gate liquidity, and by TAKE versus SKIP. The sample is small until many alerts are graded.

## Trade gate

`/gate` asks for the ticker, expiration, strike, call or put, contracts, and planned entry. It also asks for an underlying stop. The time stop and profit rule start from the exit defaults in `TRADE_RULES`, and she can edit the wording. The loss count is no longer typed. It comes from `/trades`.

`POST /api/gate` (session required) reads the live Schwab chain and runs the checks in `app/lib/gate.ts`:

- Open interest at the strike is at least 500
- Volume today is at least 100 contracts
- Bid-ask spread is at most 5% of the midpoint, and $0.10 or less when the midpoint is $3 or under
- Max loss is at most $875. A long option is `contracts × ask × 100`. A debit spread is `contracts × strike width × 100` (the most that spread can be worth). Leave the width blank for a single option.
- If one contract at the ask is already over $875, the result says so and suggests a debit spread
- The underlying stop, time stop, and profit rule have to be filled in. Time and profit start from the exit defaults: take half off at +40% of the debit, stop at -25% of the debit and never more than $875, and get out if the trade is still flat after 3 trading days. Be out before the last week to expiration. A debit spread uses those same percents on the net debit. Change `TRADE_RULES` to tune them. The 3:00pm Chicago checkpoint is only for grading an alert's midpoint, not for this exit.
- Two losing closes in a row, from the trade log, is a NO for the day. It is not a broker fill log.

`/grade` (session required) is Grade my trade. Enter a ticker, expiration, strike, and call or put. A planned entry and a short thesis are optional. `POST /api/grade` reads the live Schwab chain and grades that contract with the same checklist as the alerts (`gradeContract` in `app/lib/verdict.ts`). The page shows A, B, or Fail, one row per check (pass, fail, or unknown), and the quote time. A missing quote, no flow for that strike, a provider error, a closed market, or a stale quote is unknown, never a pass. An unknown on a required check cannot be an A. Save to Trade Log writes an open paper trade through the existing trade log, including the grade, the check rows, the entry, the thesis, and the quote time. One contract over the loss cap is refused, and so is a new paper trade while the daily stop is on.

`/trades` (session required) is the paper trade log. An A or B Telegram alert includes a Paper trade link that opens this page for that contract. The Flow card and the Alert Report have a Paper trade button that records the same simulated entry. The entry price is the ask (ask × 100 is the cost of one contract). One contract over $875 is refused, and so is a size whose total cost is over $875. Open trades show mark-to-market P/L from the Schwab midpoint when a quote is available. She can close at that midpoint or type an exit. Stats are split by grade A and grade B: win rate, average win, average loss, and total P/L. Two losing closes in a row stop new paper trades for the Chicago day. CSV is `GET /api/trades?format=csv`. Nothing on this page places an order.

`/scorecard` (session required) is the alert scorecard. Every A or B saved in the alert book is tracked as if one contract were bought at the alert ask, whether or not she paper-trades it. Cron marks open shadows with the same chain quote as the trade log (midpoint, or the bid when the midpoint is missing). Up to 16 unique contracts are quoted on a run, oldest mark first, so a long book continues on the next run. A shadow closes with the current exit rules: half off at +40% of the debit (one contract, so that is the whole trade), stop at -25% of the debit with the planned loss capped at $875, out if it is still flat after 3 trading days, and out before the last week to expiration. Those outcomes stay in their own private store record. An alert that is already a paper trade is left out of the scorecard totals so it is not counted twice. The page shows counts, win rate, average win, average loss, and total P/L for A and B, by ticker, and by call and put, plus a short table. Fewer than 30 resolved alerts is called out as too few to trust. The numbers are estimates from quotes, not fills. Open shadows are marked every 15 minutes and the chain is a snapshot, so an exit can show up late. CSV is `GET /api/scorecard?format=csv`. Nothing on this page places an order.

A separate scorecard section, labeled **Test: 43-60 DTE**, records contracts the scan already fetched that would pass the other alert rules except that they expire in 43 to 60 days. Each one is a one-contract shadow at the ask, with the same exits. They are not A or B grades, they are not sent, and they are left out of the A/B totals, the alerts, and the notifications. At most 2 are opened on a run and 4 on a Chicago day, and at most 4 are quoted, using leftover slots inside the existing 16. Fewer than 30 resolved test results is too few to consider widening the 14–42 day window. The 14–42 day rule is unchanged.

`/learn` (session required) is Learning mode. It reads resolved shadows and closed paper trades and breaks them into factors: grade, rules version, flow premium, flow signals, volume versus open interest, days to expiration, moneyness, spread, implied vol, volume jump, distance to the next level, earnings, side of the quote, trend alignment, SPY and QQQ, a likely spread or hedge, flow repeated from the prior session, minutes since the open, IV versus the prior session, call or put, ticker, time of day, and day of week. A paper trade saved from Grade my trade keeps its per-check results, and those checks appear here after the trade is closed. The 43–60 day test is its own days-to-expiration bucket so it can be compared with 14–42. It is left out of the other factors. Each bucket shows count, win rate, average win, average loss, and total P/L. Factors are ranked by how far the win rates sit apart. A bucket or a factor with fewer than 30 resolved results is labeled too few to trust. The short summary is filled in from those counts. It is not a model, and it does not call a pattern proven. Suggestions, when a bucket has at least 5 results and more losses than wins, are suggestions only. They do not change a grade, a threshold, or the $875 cap. A row can be opened to see why it ended (target, stop, time stop, or expiration) and the best and worst stored marks. New alerts save those grading inputs at send time. Older alerts are filled in only from numbers already on the alert. Implied vol, delta, and the same-day volume jump stay unknown when they were not stored, and that factor leaves them out. Exit what-ifs replay the stored 15-minute quote path under other take-profit, stop, time-stop, and trailing-stop rules. They are estimates for comparison. They do not change the live exits. Older shadows that stored only the best and worst price are left out. A what-if with fewer than 30 resolved paths says so. CSV of the per-alert table is `GET /api/learn?format=csv`. With nothing resolved yet, the page says so and does not invent results. Nothing on this page places an order or reads a new chain.

The result also shows the checklist grade for that contract. The Gate's own PASS or NO is unchanged.

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
