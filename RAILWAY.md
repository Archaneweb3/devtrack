# Menjalankan bot 24/7 di Railway

Bot (`bot.js`) butuh proses yang hidup terus. Vercel tidak bisa (serverless), tapi **Railway** bisa. Ini gratis sampai kuota bulanan tertentu, cukup untuk 1 bot.

## Langkah deploy

1. Buka **railway.app** → login dengan GitHub.
2. **New Project → Deploy from GitHub repo** → pilih repo `devtrack`.
3. Railway otomatis baca `railway.json` dan menjalankan `node bot.js`. Biarkan build selesai.
4. Buka tab **Variables**, tambahkan environment variables berikut:

### Wajib
| Variable | Contoh | Keterangan |
|---|---|---|
| `BOT_WATCHLIST` | `wallet1,wallet2` | Daftar wallet dev, dipisah koma. (Atau JSON: `[{"wallet":"...","label":"ANSEM"}]`) |
| `BOT_MODE` | `simulation` | `simulation` (aman, tanpa uang) atau `live` |

### Untuk alert Telegram
| Variable | Keterangan |
|---|---|
| `TG_TOKEN` | Bot token dari @BotFather |
| `TG_CHAT` | Chat ID dari @userinfobot |

### Parameter beli/jual (opsional, ada default)
| Variable | Default | Keterangan |
|---|---|---|
| `BOT_BUY_SOL` | `0.05` | SOL per beli |
| `BOT_SLIPPAGE` | `15` | Slippage % |
| `BOT_PRIORITY_FEE` | `0.001` | Priority fee SOL |
| `BOT_MAX_BUYS_PER_DAY` | `1` | Maks beli per dev/hari |
| `BOT_TAKE_PROFIT` | `[{"mult":2,"pct":50}]` | JSON aturan take-profit |
| `BOT_STOP_LOSS` | `{"mult":0,"pct":0}` | JSON stop-loss (0 = mati) |

### Untuk mode LIVE (beli sungguhan)
| Variable | Keterangan |
|---|---|
| `PRIVATE_KEY` | Private key base58 wallet **burner** (bukan wallet utama!) |
| `HELIUS_KEY` | Helius API key (gratis) untuk pengiriman transaksi andal |

5. Setelah variables tersimpan, Railway otomatis redeploy. Buka tab **Deploy Logs** — harusnya muncul:
   ```
   devtrack bot start. Watchlist: N dev. Sumber config: env.
   Tersambung ke stream pump.fun. Mode: SIMULATION | pantau N dev ...
   ```
6. Bot sekarang jalan 24/7. Alert masuk Telegram walau komputermu mati.

## Cek status

Railway memberi URL publik (tab Settings → Networking → Generate Domain). Buka URL itu → muncul status JSON:
```json
{ "status": "running", "mode": "simulation", "watching": 2, "wsConnected": true, "lastEventAgoSec": 1 }
```

## Mengubah watchlist

Edit variable `BOT_WATCHLIST` di Railway → simpan → bot otomatis redeploy. (Watchlist di website Vercel terpisah — itu localStorage browser; Railway pakai env var.)

## Catatan mode LIVE

- Mulai `simulation` dulu beberapa hari. Baru ganti `BOT_MODE=live` + isi `PRIVATE_KEY` setelah yakin.
- `PRIVATE_KEY` di Railway env var terenkripsi & tidak masuk kode/GitHub, tapi tetap: **pakai wallet burner berisi dana kecil.**
- Railway free tier punya batas jam-eksekusi bulanan; pantau agar tidak habis di tengah bulan.
