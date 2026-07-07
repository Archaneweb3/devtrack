// devtrack auto-buy bot — mendengar launch pump.fun real-time, cocokkan dev watchlist.
// Mode:
//   simulation (default) — hanya catat + kirim sinyal Telegram, TANPA uang.
//   live                 — beli otomatis via PumpPortal (butuh privateKey wallet burner).
//
// Jalankan: node bot.js   (server devtrack lokal harus hidup agar watchlist tersinkron)
// Konfigurasi dibaca dari bot-config.json (di-push otomatis dari tab Bot di website lokal).

const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'bot-config.json');
const LOG_FILE = path.join(__dirname, 'bot-trades.log');
const WS_URL = 'wss://pumpportal.fun/api/data';

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return {}; }
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

  if (mode === 'simulation') {
    recordBuy(wallet);
    log(`SINYAL BELI (simulasi) — dev ${who} launch ${name} | ${mint} | seharusnya beli ${cfg.buySol || 0.05} SOL`);
    await tg(`\u{1F7E1} <b>SIMULASI — SINYAL BELI</b>\n` +
      `Dev watchlist launch token!\n\n` +
      `<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n<b>Dev:</b> <code>${wallet}</code>${label ? ` (${label})` : ''}\n` +
      `<b>Rencana beli:</b> ${cfg.buySol || 0.05} SOL (tidak dieksekusi — mode simulasi)\n\n` +
      `<a href="https://${links}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint}">chart</a>`);
    return;
  }

  // ---- LIVE ----
  recordBuy(wallet);
  log(`EKSEKUSI BELI — dev ${who} launch ${name} | ${mint} | ${cfg.buySol} SOL...`);
  try {
    const sig = await executeBuy(mint);
    log(`BERHASIL — ${name} | tx ${sig}`);
    await tg(`\u{1F7E2} <b>AUTO-BUY BERHASIL</b>\n` +
      `<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n<b>Dev:</b> <code>${wallet}</code>${label ? ` (${label})` : ''}\n` +
      `<b>Jumlah:</b> ${cfg.buySol} SOL\n` +
      `<a href="https://solscan.io/tx/${sig}">tx</a> · <a href="https://${links}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint}">chart</a>`);
  } catch (e) {
    log(`GAGAL beli ${name}: ${e.message}`);
    await tg(`\u{1F534} <b>AUTO-BUY GAGAL</b>\n<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n<b>Alasan:</b> ${e.message}`);
  }
}

// ---------- koneksi WebSocket + auto-reconnect ----------
function connect() {
  const ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    const n = watchSet().size;
    log(`Tersambung ke stream pump.fun. Mode: ${(cfg.mode || 'simulation').toUpperCase()} | memantau ${n} dev watchlist | beli ${cfg.buySol || 0.05} SOL/token`);
  };
  ws.onmessage = e => {
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (d.mint && d.txType === 'create') onLaunch(d);
    else if (d.mint && !d.txType) onLaunch(d); // format event bervariasi — tangani keduanya
  };
  ws.onclose = () => { log('Koneksi putus — menyambung ulang dalam 3 detik...'); setTimeout(connect, 3000); };
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
}

// ---------- start ----------
(async () => {
  if (!fs.existsSync(CONFIG_FILE)) {
    log('bot-config.json belum ada. Buka website lokal → tab Bot → aktifkan, atau salin bot-config.example.json.');
    process.exit(1);
  }
  log(`devtrack bot start. Watchlist: ${watchSet().size} dev.`);
  if ((cfg.mode || 'simulation') === 'live') {
    try { connection = await initLive(); log(`Mode LIVE aktif — wallet ${signer.publicKey.toBase58()}`); }
    catch (e) { log('Gagal init live: ' + e.message + ' — jatuh ke simulasi.'); cfg.mode = 'simulation'; }
  }
  if (watchSet().size === 0) log('PERINGATAN: watchlist kosong — tidak ada yang dipantau. Tambahkan dev di website.');
  connect();
})();
