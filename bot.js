// devtrack auto-buy bot — listens to pump.fun launches in real time, matches watchlist devs.
// Modes:
//   simulation (default) — only log + send Telegram signals, NO money.
//   live                 — buy automatically via PumpPortal (needs a burner wallet privateKey).
//
// Run: node bot.js   (the local devtrack server must be running so the watchlist stays synced)
// Config is read from bot-config.json (auto-pushed from the Auto-buy tab in the local website).

const fs = require('fs');
const path = require('path');
const http = require('http');

// WebSocket global (Node 21+) atau paket 'ws' sebagai fallback (Railway/Node lama)
const WS = globalThis.WebSocket || require('ws');

const CONFIG_FILE = path.join(__dirname, 'bot-config.json');
const LOG_FILE = path.join(__dirname, 'bot-trades.log');
const STATS_FILE = path.join(__dirname, 'bot-signals.csv');
const WS_URL = 'wss://pumpportal.fun/api/data';

// ---------- SOL price (to convert mcap to USD), cached 5 min ----------
let solPrice = 0, solPriceAt = 0;
async function getSolPrice() {
  if (solPrice && Date.now() - solPriceAt < 5 * 60 * 1000) return solPrice;
  try {
    const r = await (await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112')).json();
    const stable = (r.pairs || []).find(p => ['USDC', 'USDT'].includes(p.quoteToken?.symbol));
    if (stable) { solPrice = parseFloat(stable.priceUsd) || solPrice; solPriceAt = Date.now(); }
  } catch { /* use last price */ }
  return solPrice;
}
function usd(mcapSol) { return solPrice ? '$' + Math.round(mcapSol * solPrice).toLocaleString('en-US') : '—'; }
function usdRaw(mcapSol) { return solPrice ? Math.round(mcapSol * solPrice) : ''; } // no comma, safe for CSV

// config from environment variables (used on Railway/cloud); overrides the file
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
  if (e.BOT_TAKE_PROFIT) { try { c.takeProfit = JSON.parse(e.BOT_TAKE_PROFIT); } catch { /* ignore */ } }
  if (e.BOT_STOP_LOSS) { try { c.stopLoss = JSON.parse(e.BOT_STOP_LOSS); } catch { /* ignore */ } }
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
  try { file = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* no file (e.g. on Railway) */ }
  return { ...file, ...envConfig() }; // env override file
}

let cfg = loadConfig();
// reload config every 10s so watchlist changes from the website take effect immediately
setInterval(() => { cfg = loadConfig(); }, 10000);

function watchSet() {
  return new Set((cfg.watchlist || []).map(w => (typeof w === 'string' ? w : w.wallet)));
}
function labelOf(wallet) {
  const item = (cfg.watchlist || []).find(w => (w.wallet || w) === wallet);
  return (item && item.label) || '';
}

// ---------- open positions + take-profit / stop-loss rules ----------
const positions = new Map(); // mint -> { entryMcapSol, label, symbol, wallet, remainingPct, firedTiers:Set, openedAt }
let activeWs = null;
let lastEventAt = 0;

// default rule: sell 50% at 2x. Can be overridden via cfg.takeProfit = [{mult,pct}, ...]
function tpTiers() {
  const t = cfg.takeProfit;
  if (Array.isArray(t) && t.length) return t.filter(x => x.mult > 0 && x.pct > 0).sort((a, b) => a.mult - b.mult);
  return [{ mult: 2, pct: 50 }];
}
function stopLossRule() {
  const s = cfg.stopLoss;
  return (s && s.mult > 0 && s.pct > 0) ? s : null; // e.g. {mult:0.5, pct:100}
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
    log(`SELL SIGNAL (simulation) — ${name} ${reason} | ${pct}% at ${mcapStr} = ${x}x from entry | ${mint}`);
    await tg(`\u{1F7E0} <b>SIMULATION — SELL SIGNAL ${pct}%</b>\n` +
      `${reason}\n\n` +
      `<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n` +
      `<b>Now:</b> ${mcapStr} = <b>${x}x</b> from entry price\n` +
      `<b>Action:</b> sell ${pct}% (not executed — simulation)`);
    return true;
  }
  // ---- LIVE ----
  try {
    const sig = await executeSell(mint, pct);
    log(`SELL OK — ${name} ${pct}% at ${mcapStr} (${x}x) | tx ${sig}`);
    await tg(`\u{1F4B0} <b>AUTO-SELL ${pct}% OK</b>\n${reason}\n\n` +
      `<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n<b>Price:</b> ${mcapStr} = <b>${x}x</b>\n` +
      `<a href="https://solscan.io/tx/${sig}">tx</a> · <a href="https://dexscreener.com/solana/${mint}">chart</a>`);
    return true;
  } catch (e) {
    log(`SELL FAILED — ${name}: ${e.message}`);
    await tg(`\u{1F534} <b>AUTO-SELL FAILED</b>\n<b>Token:</b> ${name}\n<b>Reason:</b> ${e.message}`);
    return false;
  }
}

// called on every trade of a token currently held
async function onTrade(ev) {
  const pos = positions.get(ev.mint);
  if (!pos) return;
  const cur = ev.marketCapSol || 0;
  if (!cur) return;
  const ratio = cur / pos.entryMcapSol;

  // stop-loss (e.g. drops to 0.5x -> sell everything)
  const sl = stopLossRule();
  if (sl && ratio <= sl.mult && !pos.firedTiers.has('SL')) {
    pos.firedTiers.add('SL');
    const ok = await sellPortion(pos, ev.mint, sl.pct, `Stop-loss: dropped to ${ratio.toFixed(2)}x`, cur);
    if (ok) { pos.remainingPct -= sl.pct; if (pos.remainingPct <= 0) return closePosition(ev.mint); }
  }

  // tiered take-profit
  for (const [i, tier] of tpTiers().entries()) {
    const key = 'TP' + i;
    if (ratio >= tier.mult && !pos.firedTiers.has(key) && pos.remainingPct > 0) {
      pos.firedTiers.add(key);
      const pct = Math.min(tier.pct, pos.remainingPct);
      const ok = await sellPortion(pos, ev.mint, pct, `Take-profit ${tier.mult}x reached`, cur);
      if (ok) { pos.remainingPct -= pct; if (pos.remainingPct <= 0) return closePosition(ev.mint); }
    }
  }
}

// ---------- safety limit: how many buys per dev per day ----------
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
  try { fs.appendFileSync(LOG_FILE, msg + '\n'); } catch { /* ignore */ }
}

// log every detection to CSV to analyze the average entry mcap per dev
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
  } catch { /* ignore */ }
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
  } catch (e) { log('Telegram failed: ' + e.message); }
}

// ---------- buy execution (live) via PumpPortal local-transaction ----------
// Heavy modules only load in live mode, so simulation stays dependency-free.
let web3, bs58, signer;
async function initLive() {
  if (!cfg.privateKey) throw new Error('live mode needs a privateKey (burner wallet) in bot-config.json');
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
      amount: pct + '%',                 // sell a percentage of holdings
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
  if (!watchSet().has(wallet)) return; // not a watchlist dev — ignore

  const label = labelOf(wallet);
  const who = `${wallet.slice(0, 6)}…${label ? ' (' + label + ')' : ''}`;
  const name = `${ev.name || '?'} ${ev.symbol ? '(' + ev.symbol + ')' : ''}`;

  if (!canBuy(wallet)) {
    log(`SKIP (daily limit reached) — dev ${who} launched ${name} | ${mint}`);
    return;
  }

  const mode = cfg.mode || 'simulation';
  const links = `pump.fun/coin/${mint}`;
  await getSolPrice();
  const mcapSol = ev.marketCapSol || 0;         // mcap when the bot detects the launch
  const mcapUsd = usd(mcapSol);
  const mcapUsdRaw = usdRaw(mcapSol);
  const mcapStr = `${mcapSol.toFixed(1)} SOL (${mcapUsd})`;

  if (mode === 'simulation') {
    recordBuy(wallet);
    recordStat({ wallet, label, symbol: ev.symbol, mint, mcapSol, mcapUsdRaw, mode });
    log(`BUY SIGNAL (simulation) — dev ${who} launched ${name} | entry mcap ${mcapStr} | ${mint} | plan ${cfg.buySol || 0.05} SOL`);
    await tg(`\u{1F7E1} <b>SIMULATION — BUY SIGNAL</b>\n` +
      `A watchlist dev launched a token!\n\n` +
      `<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n<b>Dev:</b> <code>${wallet}</code>${label ? ` (${label})` : ''}\n` +
      `<b>Mcap when detected:</b> ${mcapStr}\n` +
      `<b>Planned buy:</b> ${cfg.buySol || 0.05} SOL (not executed — simulation mode)\n\n` +
      `<a href="https://${links}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint}">chart</a>`);
    openPosition(mint, mcapSol, label, ev.symbol, wallet); // watch price for take-profit
    return;
  }

  // ---- LIVE ----
  recordBuy(wallet);
  recordStat({ wallet, label, symbol: ev.symbol, mint, mcapSol, mcapUsdRaw, mode });
  log(`EXECUTING BUY — dev ${who} launched ${name} | entry mcap ${mcapStr} | ${mint} | ${cfg.buySol} SOL...`);
  try {
    const sig = await executeBuy(mint);
    log(`OK — ${name} | tx ${sig}`);
    openPosition(mint, mcapSol, label, ev.symbol, wallet); // start watching for auto-sell
    await tg(`\u{1F7E2} <b>AUTO-BUY OK</b>\n` +
      `<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n<b>Dev:</b> <code>${wallet}</code>${label ? ` (${label})` : ''}\n` +
      `<b>Mcap at buy:</b> ${mcapStr}\n<b>Amount:</b> ${cfg.buySol} SOL\n` +
      `<a href="https://solscan.io/tx/${sig}">tx</a> · <a href="https://${links}">pump.fun</a> · <a href="https://dexscreener.com/solana/${mint}">chart</a>`);
  } catch (e) {
    log(`FAILED to buy ${name}: ${e.message}`);
    await tg(`\u{1F534} <b>AUTO-BUY FAILED</b>\n<b>Token:</b> ${name}\n<b>CA:</b> <code>${mint}</code>\n<b>Reason:</b> ${e.message}`);
  }
}

// ---------- WebSocket connection + auto-reconnect ----------
function connect() {
  const ws = new WS(WS_URL);
  activeWs = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    // re-subscribe monitoring for still-open positions (e.g. after a reconnect)
    const held = [...positions.keys()];
    if (held.length) ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: held }));
    const tp = tpTiers().map(t => `${t.pct}%@${t.mult}x`).join(', ');
    log(`Connected to the pump.fun stream. Mode: ${(cfg.mode || 'simulation').toUpperCase()} | watching ${watchSet().size} devs | buy ${cfg.buySol || 0.05} SOL | take-profit: ${tp}`);
  };
  ws.onmessage = e => {
    lastEventAt = Date.now();
    let d; try { d = JSON.parse(e.data); } catch { return; }
    if (!d.mint) return;
    if (d.txType === 'create') { onLaunch(d); return; }
    if ((d.txType === 'buy' || d.txType === 'sell') && positions.has(d.mint)) { onTrade(d); return; }
    if (!d.txType) onLaunch(d); // some create events have no type
  };
  ws.onclose = () => { log('Connection dropped — reconnecting in 3 seconds...'); setTimeout(connect, 3000); };
  ws.onerror = () => { try { ws.close(); } catch { /* noop */ } };
}

// ---------- health server (Railway/cloud needs a process bound to a port; also a status page) ----------
function startHealthServer() {
  const port = process.env.PORT;
  if (!port) return; // local without PORT: skip
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
  }).listen(port, () => log(`Health server on port ${port}`));
}

// ---------- start ----------
(async () => {
  const hasConfig = fs.existsSync(CONFIG_FILE) || Object.keys(envConfig()).length > 0;
  if (!hasConfig) {
    log('No config yet. Local: open the website → Auto-buy tab → Save. Cloud: set environment variables (see RAILWAY.md).');
    process.exit(1);
  }
  startHealthServer();
  log(`devtrack bot started. Watchlist: ${watchSet().size} devs. Config source: ${fs.existsSync(CONFIG_FILE) ? 'file' : 'env'}${process.env.BOT_WATCHLIST ? '+env' : ''}.`);
  if ((cfg.mode || 'simulation') === 'live') {
    try { connection = await initLive(); log(`LIVE mode active — wallet ${signer.publicKey.toBase58()}`); }
    catch (e) { log('Failed to init live: ' + e.message + ' — falling back to simulation.'); cfg.mode = 'simulation'; }
  }
  if (watchSet().size === 0) log('WARNING: watchlist is empty — nothing is being watched.');
  connect();
})();
