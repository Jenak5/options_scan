# ◆ Options Edge Scanner

Real-time options analysis dashboard powered by **Tastytrade** and **Unusual Whales** APIs with **Telegram alerts**.

## Features

| Tab | Source | What It Does |
|-----|--------|--------------|
| ⊕ Flow | Unusual Whales | Live options flow — sweeps, blocks, golden sweeps |
| ◈ Dark Pool | Unusual Whales | Dark pool prints with notional values |
| ◇ Vol Arb | Tastytrade | IV vs Realized Vol mismatch with BUY/SELL signals |
| ⊞ Account | Tastytrade | Live positions, P&L, balances, buying power |
| △ Kelly Lab | Local | Interactive Kelly Criterion calculator + growth curve |
| ≡ Chain | Tastytrade | Full nested option chain for any ticker |
| 📱 Alerts | Telegram | Auto-alerts every 5 min during market hours |

## Deploy to Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import this GitHub repo
3. Add these environment variables in Settings:
```
TASTYTRADE_USERNAME=your_username
TASTYTRADE_PASSWORD=your_password
TASTYTRADE_ACCOUNT_NUMBER=your_account
TASTYTRADE_ENV=sandbox
UNUSUAL_WHALES_API_TOKEN=your_token
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
ALERT_MIN_PREMIUM=100000
```

4. Deploy — done!

## Telegram Setup

1. Message @BotFather on Telegram → send /newbot → copy the token
2. Start a chat with your new bot → send /start
3. Visit https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
4. Find your chat_id in the JSON response
5. Add both to Vercel env vars
6. Hit the "Test Alert" button in the Alerts tab

Auto-scanning runs every 5 minutes during market hours (Mon-Fri 8:30AM-3PM CT).

## Security

- API keys stay server-side (never sent to browser)
- Read-only — does NOT place trades
- Never commit .env.local

## Disclaimer

Educational and research purposes only. Not financial advice. Options involve significant risk of loss.
