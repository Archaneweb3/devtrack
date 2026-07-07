# devtrack — Solana Memecoin Dev Wallet Tracker

Temukan dan pantau **wallet developer memecoin yang potensial** di Solana: track record, winrate graduate, trace arah dana on-chain, dan signal Telegram. Memakai API gratis (pump.fun, Dexscreener, RPC publik; opsional Helius).

## Cara menjalankan

**Lokal:** klik dua kali `JALANKAN.bat`, atau `npm start`, lalu buka http://localhost:3456

**Vercel:** import repo ini di [vercel.com/new](https://vercel.com/new) — zero config (static `public/` + serverless `api/`), langsung deploy.

Watchlist & pengaturan (token Telegram, Helius key) tersimpan di **localStorage browser** — tidak ada database, tidak ada kredensial di server.

## Fitur

### 1. Scan Dev Potensial
- Mengambil token terbaru (atau top market cap) dari pump.fun.
- Menelusuri wallet **creator** setiap token, lalu mengambil seluruh riwayat token yang pernah dibuat wallet itu.
- Memberi **skor 0–100** dan grade A–D, diurutkan dari yang terbaik.

### 2. Cek Wallet
Tempel alamat wallet dev mana pun untuk melihat track record lengkapnya.

### 3. Watchlist
Simpan dev yang menarik (tersimpan di `data.json`). Dev yang launch token baru dalam 24 jam terakhir ditandai badge "LAUNCH BARU".

### 4. Trace on-chain (deteksi dev gonta-ganti wallet)
Di profil dev, tombol **"Jalankan trace"** menelusuri riwayat transaksi via RPC publik Solana:
- **Didanai oleh siapa** — transfer SOL masuk paling awal (funding wallet).
- **Dana keluar ke mana** — agregasi transfer SOL keluar terbesar.
- Setiap wallet terkait **otomatis dicek apakah juga creator token** di pump.fun (jumlah launch, graduate, ATH) — kalau dev pindah wallet, jejaknya kelihatan di sini.
- Klik alamat mana pun untuk membuka profilnya dan lanjutkan penelusuran hop demi hop.

### 5. Data pasar (Dexscreener)
Tabel token di profil dev diperkaya likuiditas, volume 24 jam, dan perubahan harga.

### 6. Scan penuh 24 jam
Mode **"Semua graduate 24 jam"** memindai SELURUH token yang graduate dalam 24 jam terakhir (paging otomatis, biasanya 400–600 token / 300+ dev). Dev serial dengan winrate tinggi tidak akan lolos dari jendela scan. Analisisnya butuh beberapa menit karena rate limit API gratis.

### 7. Signal Telegram
Konfigurasi di tab **Pengaturan** (bot token dari @BotFather + chat ID). Dua jenis signal, formatnya dibedakan:
- **Signal watchlist (otomatis)** — browser memeriksa setiap dev watchlist tiap 3 menit **selama halaman terbuka**; begitu ada launch baru, terkirim pesan berisi nama token, **CA siap copy**, track record dev, dan link pump.fun/dexscreener.
- **Signal scan (manual)** — setelah scan selesai, tombol "Kirim signal Telegram" mengirim maksimal 10 dev teratas yang lolos filter, beserta skor, winrate, dan ATH.

## Cara skor dihitung

| Komponen | Bobot |
|---|---|
| Tingkat graduate ke DEX (Raydium/PumpSwap) | maks 40 |
| ATH market cap tertinggi yang pernah dicapai | maks 30 |
| Pengalaman (jumlah launch, maks 5 dihitung) | maks 10 |
| Aktivitas terkini (launch terakhir) | maks 10 |
| Konsistensi (persen token yang dapat traksi > $30k) | maks 10 |
| 🚩 Serial launcher (≥8 token, <5% graduate) | −25 |
| 🚩 Spam launch (>20 token) | −10 |

Grade: **A** ≥70 · **B** ≥50 · **C** ≥30 · **D** <30

### 8. Lintas launchpad (Meteora dll)
- **Tanpa key (gratis):** paste CA non-pump.fun → app mendeteksi mint on-chain dan mencari **wallet deployer**-nya via RPC (transaksi pertama sang mint), lalu membuka profilnya (trace tetap jalan; riwayat pump.fun-nya kosong kalau dia memang bukan dev pump.fun). Token yang riwayatnya sangat panjang butuh Helius.
- **Dengan Helius API key (daftar gratis di dashboard.helius.dev, isi di Pengaturan):** RPC beralih ke Helius (trace lebih cepat & dalam), CA seaktif apa pun bisa dilacak, dan di profil dev muncul tombol **"Scan deploy lintas launchpad"** — memindai 500 transaksi terakhir wallet untuk menemukan semua token yang pernah dia deploy (pump.fun, Meteora DBC, launchpad lain), lengkap dengan FDV/likuiditas/volume dan hitungan berapa yang masih hidup.

### 9. Auto-buy bot (lokal saja)
Bot lokal (`bot.js`) mendengar launch pump.fun **real-time** via WebSocket PumpPortal (delay ~1–3 detik) dan bertindak saat creator-nya ada di watchlist.
- Atur di tab **Auto-buy** di website lokal → "Simpan & sinkron ke bot" (menulis `bot-config.json`) → jalankan `node bot.js`.
- **Mode simulasi** (default): catat + kirim sinyal Telegram, tanpa uang. **Mode live**: beli via PumpPortal Trade API (`node bot.js`, butuh `npm install @solana/web3.js bs58`).
- Wallet burner khusus bot; private key hanya di `bot-config.json` lokal (di-gitignore), tidak pernah ke server/Vercel.
- Pengaman: jumlah beli tetap, slippage/priority fee, maks beli per dev per hari.

## Catatan penting

- Data hanya mencakup token yang dibuat lewat **pump.fun** (mayoritas memecoin Solana). Dev bisa saja memakai banyak wallet — skor tinggi bukan jaminan aman.
- API gratis punya rate limit; server sudah membatasi 3 request paralel. Kalau scan besar terasa lambat, itu normal.
- **Ini alat riset, bukan saran finansial.** Memecoin sangat berisiko.
