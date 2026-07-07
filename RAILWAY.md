# Running the bot 24/7 on Railway

The bot (`bot.js`) needs a process that stays alive continuously. Vercel can't do this (serverless), but **Railway** can. It's free up to a certain monthly quota, enough for 1 bot.

## Deploy steps

1. Open **railway.app** → log in with GitHub.
2. **New Project → Deploy from GitHub repo** → pick the `devtrack` repo.
3. Railway automatically reads `railway.json` and runs `node bot.js`. Let the build finish.
4. Open the **Variables** tab and add the following environment variables:

### Required
| Variable | Example | Description |
|---|---|---|
| `BOT_WATCHLIST` | `wallet1,wallet2` | List of dev wallets, comma-separated. (Or JSON: `[{"wallet":"...","label":"ANSEM"}]`) |
| `BOT_MODE` | `simulation` | `simulation` (safe, no money) or `live` |

### For Telegram alerts
| Variable | Description |
|---|---|
| `TG_TOKEN` | Bot token from @BotFather |
| `TG_CHAT` | Chat ID from @userinfobot |

### Buy/sell parameters (optional, have defaults)
| Variable | Default | Description |
|---|---|---|
| `BOT_BUY_SOL` | `0.05` | SOL per buy |
| `BOT_SLIPPAGE` | `15` | Slippage % |
| `BOT_PRIORITY_FEE` | `0.001` | Priority fee SOL |
| `BOT_MAX_BUYS_PER_DAY` | `1` | Max buys per dev/day |
| `BOT_TAKE_PROFIT` | `[{"mult":2,"pct":50}]` | JSON take-profit rules |
| `BOT_STOP_LOSS` | `{"mult":0,"pct":0}` | JSON stop-loss (0 = off) |

### For LIVE mode (real buys)
| Variable | Description |
|---|---|
| `PRIVATE_KEY` | Base58 private key of a **burner** wallet (not your main wallet!) |
| `HELIUS_KEY` | Helius API key (free) for reliable transaction submission |

5. Once the variables are saved, Railway automatically redeploys. Open the **Deploy Logs** tab — you should see:
   ```
   devtrack bot started. Watchlist: N devs. Config source: env.
   Connected to the pump.fun stream. Mode: SIMULATION | watching N devs ...
   ```
6. The bot now runs 24/7. Alerts land in Telegram even when your computer is off.

## Check status

Railway gives you a public URL (Settings tab → Networking → Generate Domain). Open that URL → a JSON status appears:
```json
{ "status": "running", "mode": "simulation", "watching": 2, "wsConnected": true, "lastEventAgoSec": 1 }
```

## Changing the watchlist

Edit the `BOT_WATCHLIST` variable on Railway → save → the bot redeploys automatically. (The watchlist on the Vercel website is separate — that's browser localStorage; Railway uses env vars.)

## Notes on LIVE mode

- Start with `simulation` for a few days first. Only switch to `BOT_MODE=live` + fill in `PRIVATE_KEY` once you're confident.
- `PRIVATE_KEY` in a Railway env var is encrypted and doesn't go into the code/GitHub, but still: **use a burner wallet holding a small amount of funds.**
- Railway's free tier has a monthly execution-hour limit; monitor it so it doesn't run out mid-month.
