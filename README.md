# devtrack — Solana Memecoin Dev Wallet Tracker

Find and monitor **promising memecoin developer wallets** on Solana: track record, graduate winrate, on-chain fund-flow tracing, and Telegram signals. Uses free APIs (pump.fun, Dexscreener, public RPC; optionally Helius).

## How to run

**Local:** double-click `RUN.bat`, or run `npm start`, then open http://localhost:3456

**Vercel:** import this repo at [vercel.com/new](https://vercel.com/new) — zero config (static `public/` + serverless `api/`), deploys instantly.

Watchlist & settings (Telegram token, Helius key) are stored in **browser localStorage** — no database, no credentials on the server.

## Features

### 1. Scan Promising Devs
- Fetches the latest tokens (or top market cap) from pump.fun.
- Traces the **creator** wallet of each token, then pulls the full history of every token that wallet has created.
- Assigns a **score of 0–100** and a grade A–D, sorted best first.

### 2. Check Wallet
Paste any dev wallet address to see its full track record.

### 3. Watchlist
Save interesting devs (stored in browser localStorage). Devs who launched a new token in the last 24 hours are flagged with a "NEW LAUNCH" badge. While the tab is open, the site monitors **in real time via WebSocket** (~1–3 second delay) and sends a Telegram alert + browser notification whenever a watchlist dev launches. For full reliability (the tab won't get suspended) & auto-buy, run `bot.js`.

### 4. On-chain trace (detect devs switching wallets)
On a dev profile, the **"Run trace"** button walks the transaction history via public Solana RPC:
- **Who funded them** — the earliest incoming SOL transfers (funding wallet).
- **Where funds went** — aggregation of the largest outgoing SOL transfers.
- Every related wallet is **automatically checked for whether it's also a token creator** on pump.fun (launch count, graduates, ATH) — if a dev moved wallets, the trail shows up here.
- Click any address to open its profile and continue tracing hop by hop.

### 5. Market data (Dexscreener)
The token table on a dev profile is enriched with liquidity, 24-hour volume, and price change.

### 6. Full 24-hour scan
The **"All graduates 24h"** mode scans EVERY token that graduated in the last 24 hours (automatic paging, typically 400–600 tokens / 300+ devs). Serial devs with high winrate won't slip past the scan window. The analysis takes a few minutes due to free-API rate limits.

### 7. Telegram Signals
Configure it in the **Settings** tab (bot token from @BotFather + chat ID). Two types of signals, with distinct formats:
- **Watchlist signal (automatic)** — the browser checks every watchlist dev every 3 minutes **while the page is open**; as soon as there's a new launch, a message is sent with the token name, **copy-ready CA**, the dev's track record, and pump.fun/dexscreener links.
- **Scan signal (manual)** — after a scan finishes, the "Send Telegram signal" button sends up to the top 10 devs that pass the filter, along with score, winrate, and ATH.

## How the score is calculated

| Component | Weight |
|---|---|
| Graduation rate to DEX (Raydium/PumpSwap) | max 40 |
| Highest ATH market cap ever reached | max 30 |
| Experience (launch count, up to 5 counted) | max 10 |
| Recent activity (last launch) | max 10 |
| Consistency (percent of tokens that got traction > $30k) | max 10 |
| 🚩 Serial launcher (≥8 tokens, <5% graduate) | −25 |
| 🚩 Spam launch (>20 tokens) | −10 |

Grade: **A** ≥70 · **B** ≥50 · **C** ≥30 · **D** <30

### 8. Cross-launchpad (Meteora etc.)
- **Without a key (free):** paste a non-pump.fun CA → the app detects the mint on-chain and finds its **deployer wallet** via RPC (the mint's first transaction), then opens its profile (trace still works; its pump.fun history will be empty if they aren't actually a pump.fun dev). Tokens with very long histories need Helius.
- **With a Helius API key (sign up free at dashboard.helius.dev, enter it in Settings):** RPC switches to Helius (faster, deeper tracing), any CA can be traced no matter how active, and the dev profile gains a **"Scan cross-launchpad deploys"** button — it scans the wallet's last 500 transactions to find every token they've ever deployed (pump.fun, Meteora DBC, other launchpads), complete with FDV/liquidity/volume and a count of how many are still alive.

### 9. Auto-buy bot (local only)
The local bot (`bot.js`) listens for pump.fun launches **in real time** via the PumpPortal WebSocket (~1–3 second delay) and acts when the creator is on the watchlist.
- Set it up in the **Auto-buy** tab on the local website → "Save & sync to bot" (writes `bot-config.json`) → run `node bot.js`.
- **Simulation mode** (default): logs + sends Telegram signals, no money. **Live mode**: buys via the PumpPortal Trade API (`node bot.js`, requires `npm install @solana/web3.js bs58`).
- A dedicated burner wallet for the bot; the private key lives only in the local `bot-config.json` (gitignored), never reaching the server/Vercel.
- Safeguards: fixed buy amount, slippage/priority fee, max buys per dev per day.
- **Entry mcap logging:** each signal records the market cap at detection (SOL + USD) to the log & `bot-signals.csv` — open it in Excel to see the average entry mcap per dev from real data.

## Important notes

- Data only covers tokens created through **pump.fun** (the majority of Solana memecoins). A dev may use many wallets — a high score is not a guarantee of safety.
- Free APIs have rate limits; the server already caps at 3 parallel requests. If a large scan feels slow, that's normal.
- **This is a research tool, not financial advice.** Memecoins are extremely risky.
