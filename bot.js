// devtrack auto-buy bot — mendengar launch pump.fun real-time, cocokkan dev watchlist.
// Mode:
//   simulation (default) — hanya catat + kirim sinyal Telegram, TANPA uang.
//   live                 — beli otomatis via PumpPortal (butuh privateKey wallet burner).
//
// Jalankan: node bot.js   (server devtrack lokal harus hidup agar watchlist tersinkron)
// Konfigurasi dibaca dari bot-config.json (di-push otomatis dari tab Bot di website lokal).

const fs = require('fs');
const path = require('path');
const http = require('http');

// WebSocket global (Node 21+) atau paket 'ws' sebagai fallback (Railway/Node lama)
const WS = globalThis.WebSocket || require('ws');

const CONFIG_FILE = path.join(__dirname, 'bot-config.json');
const LOG_FILE = path.join(__dirname, 'bot-trades.log');
const STATS_FILE = path.join(__dirname, 'bot-signals.csv');
const WS_URL = 'wss://pumpportal.fun/api/data';

// ---------- harga SOL (untuk konversi mcap ke USD), cache 5 menit ----------
let solPrice = 0, solPriceAt = 0;
async function getSolPrice() {
  if (solPrice && Date.now() - solPriceAt < 5 * 60 * 1000) return solPrice;
  try {
    const r = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112')).json();
    const stable = (r.pairs || []).find(p => ['USDC', 'USDT'].includes(p.quoteToken?.symbol));
    if (stable) { solPrice = parseFloat(stable.priceUsd) || solPrice; solPriceAt = Date.now(); }
  } catch { /* pakai harga terakhir */ }
  return solPrice;
}
function usd(mcapSol) { return solPrice ? '$' + Math.round(mcapSol * solPrice).toLocaleString('en-US') : '—'; }
function usdRaw(mcapSol) { return solPrice ? Math.round(mcapSol * solPrice) : ''; } // tanpa koma, aman untuk CSV

// config dari environment variables (dipakai di Railway/cloud); menang atas file
function envConfig() {
  const e = process.env;
  const c = {};
  if (e.BOT_MODE) c.mode = e.BOT_MODE;
  if (e.BOT_BUY_SOL) c.buySol = parseFloat(e.BOT_BUY_SOL);
  if (e.BOT_SLIPPAGE) c.slippage = parseFloat(e.BOT_SLIPPAGE);
  if (e.BOT_PRIORITY_FEE) c.priorityFee = parseFloat(e.BOT_PRIORITY_FEE);
  if (e.BOT_MAX_BUYS_PER_DAY) c.maxBuysPerDevPerDay = parseInt(e.BOT_MAX_BUYS_PER_DAY, 10);
  if (e.TG_TOKEN) c.tgToken = e.TG_TOKEN;
  if (e.TG_CHAT) c.tgChat = e.TG_CHAT;
  if (e.HELIUS_KEY) c.heliusKey = e.HELIUS_KEY;
  if (e.PRIVATE_KEY) c.privateKey = e.PRIVATE_KEY;
  if (e.BOT_TAKE_PROFIT) { try { c.takeProfit = JSON.parse(e.BOT_TAKE_PROFIT); } catch { /* abaikan */ } }
  if (e.BOT_STOP_LOSS) { try { c.stopLoss = JSON.parse(e.BOT_STOP_LOSS); } catch { /* abaikan */ } }
  if (e.BOT_WATCHLIST) {
    const raw = e.BOT_WATCHLIST.trim();
    try {
      c.watchlist = raw.startsWith('[')
        ? JSON.parse(raw)
        : raw.split(',').map(s => s.trim()).filter(Boolean).map(w => ({ wallet: w, label: '' }));
    } catch { c.watchlist = []; }
  }
  return c;
}

function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* tak ada file (mis. di Railway) */ }
  return { ...file, ...envConfig() }; // env override file
}

let cfg = loadConfig();
// reload config tiap 10 detik supaya perubahan watchlist dari website langsung kepakai
setInterval(() => { cfg = loadConfig(); }, 10000);

function watchSet() {
  return new Set((cfg.watchlist || []).map(w => (typeof w === 'string' ? w : w.wallet)));
}
function labelOf(wallet) {
  const item = (cfg.watchlist || []).find(w => (w.wallet || w) === wallet);
  return (item && item.label) || '';
}

// ---------- posisi terbuka + aturan take-profit / stop-loss ----------
const positions = new Map(); // mint -> { entryMcapSol, label, symbol, wallet, remainingPct, firedTiers:Set, openedAt }
let activeWs = null;
let lastEventAt = 0;

// aturan default: jual 50% di 2x. Bisa dioverride via cfg.takeProfit = [{mult,pct}, ...]
function tpTiers() {
  const t = cfg.takeProfit;
  if (Array.isArray(t) && t.length) return t.filter(x => x.mult > 0 && x.pct > 0).sort((a, b) => a.mult - b.mult);
  return [{ mult: 2, pct: 50 }];
}
function stopLossRule() {
  const s = cfg.stopLoss;
  return (s && s.mult > 0 && s.pct > 0) ? s : null; // mis. {mult:0.5, pct:100}
}

function openPosition(mint, entryMcapSol, label, symbol, wallet) {
  if (!entryMcapSol || positions.has(mint)) return;
  positions.set(mint, { entryMcapSol, label, symbol, wallet, remainingPct: 100, firedTiers: new Set(), openedAt: Date.now() });
  try { activeWs && activeWs.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [mint] })); } catch { /* noop */ }
}
function closePosition(mint) {
  positions.delete(mint);
  try { activeWs && activeWs.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [mint] })); } catch { /* noop */ }
}

async function sellPortion(pos, mint, pct, reason, curMcapSol) {
  const mode = cfg.mode || 'simulation';
  const mcapStr = `${curMcapSol.toFixed(1)} SOL (${usd(curMcapSol)})`;
  const x = (curMcapSol / pos.entryMcapSol).toFixed(2);
  const name = `${pos.symbol || '?'}`;

  if (mode === 'simulation') {
    log(`SINYAL JUAL (simulasi) — ${name} ${reason} | ${pct}% di ${mcapStr} = ${x}x dari masuk | ${mint}`);
    await tg(`\u{1F7E0} <b>SIMULASI — SINYAL JUAL ${pct}%</b>\n` +
      `${reason}\n\n` +
      `<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n` +
      `<b>Sekarang:</b> ${mcapStr} = <b>${x}x</b> dari harga masuk\n` +
      `<b>Aksi:</b> jual ${pct}% (tidak dieksekusi — simulasi)`);
    return true;
  }
  // ---- LIVE ----
  try {
    const sig = await executeSell(mint, pct);
    log(`JUAL BERHASIL — ${name} ${pct}% di ${mcapStr} (${x}x) | tx ${sig}`);
    await tg(`\u{1F4B0} <b>AUTO-SELL ${pct}% BERHASIL</b>\n${reason}\n\n` +
      `<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n<b>Harga:</b> ${mcapStr} = <b>${x}x</b>\n` +
      `<a href="https://solscan.io/tx/${sig}">tx</a> · <a href="https://dexscreener.com/solana/${mint}">chart</a>`);
    return true;
  } catch (e) {
    log(`JUAL GAGAL — ${name}: ${e.message}`);
    await tg(`\u{1F534} <b>AUTO-SELL GAGAL</b>\n<b>Token:</b> ${name}\n<b>Alasan:</b> ${e.message}`);
    return false;
  }
}

// dipanggil tiap ada trade pada token yang sedang dipegang
async function onTrade(ev) {
  const pos = positions.get(ev.mint);
  if (!pos) return;
  const cur = ev.marketCapSol || 0;
  if (!cur) return;
  const ratio = cur / pos.entryMcapSol;

  // stop-loss (mis. turun ke 0.5x -> jual semua)
  const sl = stopLossRule();
  if (sl && ratio <= sl.mult && !pos.firedTiers.has('SL')) {
    pos.firedTiers.add('SL');
    const ok = await sellPortion(pos, ev.mint, sl.pct, `Stop-loss: turun ke ${ratio.toFixed(2)}x`, cur);
    if (ok) { pos.remainingPct -= sl.pct; if (pos.remainingPct <= 0) return closePosition(ev.mint); }
  }

  // take-profit bertingkat
  for (const [i, tier] of tpTiers().entries()) {
    const key = 'TP' + i;
    if (ratio >= tier.mult && !pos.firedTiers.has(key) && pos.remainingPct > 0) {
      pos.firedTiers.add(key);
      const pct = Math.min(tier.pct, pos.remainingPct);
      const ok = await sellPortion(pos, ev.mint, pct, `Take-profit ${tier.mult}x tercapai`, cur);
      if (ok) { pos.remainingPct -= pct; if (pos.remainingPct <= 0) return closePosition(ev.mint); }
    }
  }
}

// ---------- pengaman: berapa kali beli per dev per hari ----------
const buysToday = new Map(); // wallet -> {date, count}
function todayKey() { return new Date().toISOString().slice(0, 10); }
function canBuy(wallet) {
  const max = cfg.maxBuysPerDevPerDay || 1;
  const rec = buysToday.get(wallet);
  if (!rec || rec.date !== todayKey()) return true;
  return rec.count < max;
}
function recordBuy(wallet) {
  const rec = buysToday.get(wallet);
  if (!rec || rec.date !== todayKey()) buysToday.set(wallet, { date: todayKey(), count: 1 });
  else rec.count++;
}

// ---------- logging ----------
function log(line) {
  const stamp = new Date().toISOString();
  const msg = `[${stamp}] ${line}`;
  console.log(msg);
  try { fs.appendFileSync(LOG_FILE, msg + '\n'); } catch { /* abaikan */ }
}

// catat tiap deteksi ke CSV untuk analisis rata-rata mcap masuk per dev
function recordStat(row) {
  try {
    if (!fs.existsSync(STATS_FILE)) {
      fs.writeFileSync(STATS_FILE, 'waktu,dev,label,symbol,mint,mcap_sol,mcap_usd,mode\n');
    }
    const line = [
      new Date().toISOString(), row.wallet, `"${(row.label || '').replace(/"/g, "'")}"`,
      `"${(row.symbol || '').replace(/"/g, "'")}"`, row.mint,
      row.mcapSol.toFixed(2), row.mcapUsdRaw, row.mode,
    ].join(',');
    fs.appendFileSync(STATS_FILE, line + '\n');
  } catch { /* abaikan */ }
}

// ---------- Telegram ----------
async function tg(html) {
  if (!cfg.tgToken || !cfg.tgChat) return;
  try {
    await fetch(`https://api.telegram.org/bot${cfg.tgToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.tgChat, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
  } catch (e) { log('Telegram gagal: ' + e.message); }
}

// ---------- eksekusi beli (live) via PumpPortal local-transaction ----------
// Modul berat hanya di-load kalau mode live, supaya simulasi tetap tanpa dependency.
let web3, bs58, signer;
async function initLive() {
  if (!cfg.privateKey) throw new Error('mode live butuh privateKey (wallet burner) di bot-config.json');
  web3 = require('@solana/web3.js');
  bs58 = require('bs58');
  signer = web3.Keypair.fromSecretKey(bs58.default ? bs58.default.decode(cfg.privateKey) : bs58.decode(cfg.privateKey));
  const rpc = cfg.heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${cfg.heliusKey}` : 'https://api.mainnet-beta.solana.com';
  return new web3.Connection(rpc, 'confirmed');
}
let connection = null;

async function executeSell(mint, pct) {
  const res = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publicKey: signer.publicKey.toBase58(),
      action: 'sell',
      mint,
      amount: pct + '%',                 // jual persentase dari holding
      denominatedInSol: 'false',
      slippage: cfg.slippage || 15,
      priorityFee: cfg.priorityFee || 0.001,
      pool: 'pump',
    }),
  });
  if (!res.ok) throw new Error('PumpPortal ' + res.status + ' ' + (await res.text()).slice(0, 120));
  const data = new Uint8Array(await res.arrayBuffer());
  const tx = web3.VersionedTransaction.deserialize(data);
  tx.sign([signer]);
  return connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 2 });
}

async function executeBuy(mint) {
  const res = await fetch('https://pumpportal.fun/api/trade-local', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      publicKey: signer.publicKey.toBase58(),
      action: 'buy',
      mint,
      amount: cfg.buySol || 0.05,        // jumlah SOL
      denominatedInSol: 'true',
      slippage: cfg.slippage || 15,      // persen
      priorityFee: cfg.priorityFee || 0.001,
      pool: 'pump',
    }),
  });
  if (!res.ok) throw new Error('PumpPortal ' + res.status + ' ' + (await res.text()).slice(0, 120));
  const data = new Uint8Array(await res.arrayBuffer());
  const tx = web3.VersionedTransaction.deserialize(data);
  tx.sign([signer]);
  const sig = await connection.sendTransaction(tx, { skipPreflight: true, maxRetries: 2 });
  return sig;
}

// ---------- handler launch ----------
async function onLaunch(ev) {
  const wallet = ev.traderPublicKey;
  const mint = ev.mint;
  if (!wallet || !mint) return;
  if (!watchSet().has(wallet)) return; // bukan dev watchlist — abaikan

  const label = labelOf(wallet);
  const who = `${wallet.slice(0, 6)}…${label ? ' (' + label + ')' : ''}`;
  const name = `${ev.name || '?'} ${ev.symbol ? '(' + ev.symbol + ')' : ''}`;

  if (!canBuy(wallet)) {
    log(`SKIP (limit harian tercapai) — dev ${who} launch ${name} | ${mint}`);
    return;
  }

  const mode = cfg.mode || 'simulation';
  const links = `pump.fun/coin/${mint}`;
  await getSolPrice();
  const mcapSol = ev.marketCapSol || 0;         // mcap saat bot mendeteksi launch
  const mcapUsd = usd(mcapSol);
  const mcapUsdRaw = usdRaw(mcapSol);
  const mcapStr = `${mcapSol.toFixed(1)} SOL (${mcapUsd})`;

  if (mode === 'simulation') {
    recordBuy(wallet);
    recordStat({ wallet, label, symbol: ev.symbol, mint, mcapSol, mcapUsdRaw, mode });
    log(`SINYAL BELI (simulasi) — dev ${who} launch ${name} | mcap masuk ${mcapStr} | ${mint} | rencana ${cfg.buySol || 0.05} SOL`);
    await tg(`\u{1F7E1} <b>SIMULASI — SINYAL BELI</b>\n` +
      `Dev watchlist launch token!\n\n` +
      `<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n<b>Dev:</b> <code>${wallet}</code>${label ? ` (${label})` : ''}\n` +
      `<b>Mcap saat terdeteksi:</b> ${mcapStr}\n` +
      `<b>Rencana beli:</b> ${cfg.buySol || 0.05} SOL (tidak dieksekusi — mode simulasi)\n\n` +
      `<a href="https://${links}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint}">chart</a>`);
    openPosition(mint, mcapSol, label, ev.symbol, wallet); // pantau harga utk take-profit
    return;
  }

  // ---- LIVE ----
  recordBuy(wallet);
  recordStat({ wallet, label, symbol: ev.symbol, mint, mcapSol, mcapUsdRaw, mode });
  log(`EKSEKUSI BELI — dev ${who} launch ${name} | mcap masuk ${mcapStr} | ${mint} | ${cfg.buySol} SOL...`);
  try {
    const sig = await executeBuy(mint);
    log(`BERHASIL — ${name} | tx ${sig}`);
    openPosition(mint, mcapSol, label, ev.symbol, wallet); // mulai pantau utk auto-sell
    await tg(`\u{1F7E2} <b>AUTO-BUY BERHASIL</b>\n` +
      `<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n<b>Dev:</b> <code>${wallet}</code>${label ? ` (${label})` : ''}\n` +
      `<b>Mcap saat beli:</b> ${mcapStr}\n<b>Jumlah:</b> ${cfg.buySol} SOL\n` +
      `<a href="https://solscan.io/tx/${sig}">tx</a> · <a href="https://${links}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint}">chart</a>`);
  } catch (e) {
    log(`GAGAL beli ${name}: ${e.message}`);
    await tg(`\u{1F534} <b>AUTO-BUY GAGAL</b>\n<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n<b>Alasan:</b> ${e.message}`);
  }
}

// ---------- koneksi WebSocket + auto-reconnect ----------
function connect() {
  const ws = new WS(WS_URL);
  activeWs = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    // sambung ulang pemantauan posisi yang masih terbuka (mis. setelah reconnect)
    const held = [...positions.keys()];
    if (held.length) ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: held }));
    const tp = tpTiers().map(t => `${t.pct}%@${t.mult}x`).join(', ');
    log(`Tersambung ke stream pump.fun. Mode: ${(cfg.mode || 'simulation').toUpperCase()} | pantau ${watchSet().size} dev | beli ${cfg.buySol || 0.05} SOL | take-profit: ${tp}`);
  };
  ws.onmessage = e => {
    lastEventAt = Date.now();
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (!d.mint) return;
    if (d.txType === 'create') { onLaunch(d); return; }
    if ((d.txType === 'buy' || d.txType === 'sell') && positions.has(d.mint)) { onTrade(d); return; }
    if (!d.txType) onLaunch(d); // sebagian event create tak bertipe
  };
  ws.onclose = () => { log('Koneksi putus — menyambung ulang dalam 3 detik...'); setTimeout(connect, 3000); };
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
}

// ---------- health server (Railway/cloud butuh proses bind ke port; juga status page) ----------
function startHealthServer() {
  const port = process.env.PORT;
  if (!port) return; // lokal tanpa PORT: lewati
  http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      mode: cfg.mode || 'simulation',
      watching: watchSet().size,
      openPositions: positions.size,
      wsConnected: activeWs && activeWs.readyState === 1,
      lastEventAgoSec: lastEventAt ? Math.round((Date.now() - lastEventAt) / 1000) : null,
    }));
  }).listen(port, () => log(`Health server di port ${port}`));
}

// ---------- start ----------
(async () => {
  const hasConfig = fs.existsSync(CONFIG_FILE) || Object.keys(envConfig()).length > 0;
  if (!hasConfig) {
    log('Config belum ada. Lokal: buka website → tab Auto-buy → Simpan. Cloud: set environment variables (lihat RAILWAY.md).');
    process.exit(1);
  }
  startHealthServer();
  log(`devtrack bot start. Watchlist: ${watchSet().size} dev. Sumber config: ${fs.existsSync(CONFIG_FILE) ? 'file' : 'env'}${process.env.BOT_WATCHLIST ? '+env' : ''}.`);
  if ((cfg.mode || 'simulation') === 'live') {
    try { connection = await initLive(); log(`Mode LIVE aktif — wallet ${signer.publicKey.toBase58()}`); }
    catch (e) { log('Gagal init live: ' + e.message + ' — jatuh ke simulasi.'); cfg.mode = 'simulation'; }
  }
  if (watchSet().size === 0) log('PERINGATAN: watchlist kosong — tidak ada yang dipantau.');
  connect();
})();
