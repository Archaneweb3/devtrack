// devtrack core — shared logic for the local server (server.js) and Vercel functions (api/*)
// Storage-stateless: watchlist & settings live in the browser's localStorage.

const PUMP_API = 'https://frontend-api-v3.pump.fun';
const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const DAY = 24 * 60 * 60 * 1000;
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ---------- throttled fetch queue for pump.fun ----------
const pumpQueue = [];
let pumpActive = 0;
let pumpLastStart = 0;

function throttledFetch(url) {
  return new Promise((resolve, reject) => {
    pumpQueue.push({ url, resolve, reject });
    drainPump();
  });
}
function drainPump() {
  if (pumpActive >= 3 || pumpQueue.length === 0) return;
  const wait = Math.max(0, pumpLastStart + 250 - Date.now());
  const job = pumpQueue.shift();
  pumpActive++;
  setTimeout(async () => {
    pumpLastStart = Date.now();
    try {
      let res = await fetch(job.url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } });
      if (res.status === 429 || res.status >= 500) {
        await new Promise(r => setTimeout(r, 1500));
        res = await fetch(job.url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' } });
      }
      if (!res.ok) throw new Error(`API ${res.status}`);
      job.resolve(await res.json());
    } catch (e) {
      job.reject(e);
    } finally {
      pumpActive--;
      drainPump();
    }
  }, wait);
  drainPump();
}

async function fetchCoins(params) {
  const qs = new URLSearchParams({ includeNsfw: 'false', ...params }).toString();
  return throttledFetch(`${PUMP_API}/coins?${qs}`);
}

async function fetchCoin(mint) {
  return throttledFetch(`${PUMP_API}/coins/${mint}`);
}

async function fetchCreatorCoins(wallet, maxCoins = 150) {
  const all = [];
  const pageSize = 50;
  for (let offset = 0; offset < maxCoins; offset += pageSize) {
    const page = await fetchCoins({
      creator: wallet, offset: String(offset), limit: String(pageSize),
      sort: 'created_timestamp', order: 'DESC',
    });
    if (!Array.isArray(page) || page.length === 0) break;
    all.push(...page);
    if (page.length < pageSize) break;
  }
  return all;
}

// ---------- token list for the scanner ----------
async function listCoins(mode, limit) {
  let coins;
  if (mode === 'graduated24') {
    coins = [];
    const cutoff = Date.now() - DAY;
    for (let offset = 0; offset < 1500; offset += 50) {
      const page = await fetchCoins({ offset: String(offset), limit: '50', sort: 'created_timestamp', order: 'DESC', complete: 'true' });
      if (!Array.isArray(page) || !page.length) break;
      coins.push(...page);
      if (page[page.length - 1].created_timestamp < cutoff) break;
    }
    coins = coins.filter(c => c.created_timestamp >= cutoff);
  } else {
    const capped = Math.min(limit || 48, 300);
    const sort = mode === 'top' ? 'market_cap' : 'created_timestamp';
    const extra = mode === 'graduated' ? { complete: 'true' } : {};
    const pages = [];
    for (let offset = 0; offset < capped; offset += 50) {
      pages.push(fetchCoins({ offset: String(offset), limit: String(Math.min(50, capped - offset)), sort, order: 'DESC', ...extra }));
    }
    coins = (await Promise.all(pages)).flat();
  }
  return coins.map(c => ({
    mint: c.mint, name: c.name, symbol: c.symbol, image: c.image_uri,
    creator: c.creator, createdTs: c.created_timestamp, complete: !!c.complete,
    usdMcap: c.usd_market_cap || 0, athUsd: c.ath_market_cap || 0,
  }));
}

// ---------- dev score ----------
function scoreDev(wallet, coins) {
  const total = coins.length;
  const graduated = coins.filter(c => c.complete).length;
  const gradRate = total ? graduated / total : 0;
  const bestAth = Math.max(0, ...coins.map(c => c.ath_market_cap || 0));
  const bestLive = Math.max(0, ...coins.map(c => c.usd_market_cap || 0));
  const traction = coins.filter(c => (c.ath_market_cap || 0) >= 30000).length;
  const tractionRate = total ? traction / total : 0;
  const lastLaunchTs = Math.max(0, ...coins.map(c => c.created_timestamp || 0));
  const ageSinceLast = Date.now() - lastLaunchTs;

  let score = 0;
  score += gradRate * 40;
  if (bestAth >= 10_000_000) score += 30;
  else if (bestAth >= 1_000_000) score += 24;
  else if (bestAth >= 500_000) score += 18;
  else if (bestAth >= 100_000) score += 12;
  else if (bestAth >= 50_000) score += 6;
  score += Math.min(total, 5) * 2;
  if (ageSinceLast < DAY) score += 10;
  else if (ageSinceLast < 7 * DAY) score += 7;
  else if (ageSinceLast < 30 * DAY) score += 4;
  score += tractionRate * 10;

  const flags = [];
  if (graduated > 0) flags.push({ good: true, text: `${graduated} tokens graduated to DEX` });
  if (bestAth >= 1_000_000) flags.push({ good: true, text: `Once minted a token with an ATH of $${fmtNum(bestAth)}` });
  if (total >= 8 && gradRate < 0.05) {
    score -= 25;
    flags.push({ good: false, text: `Serial launcher: ${total} tokens, almost none graduated` });
  }
  if (total > 20) {
    score -= 10;
    flags.push({ good: false, text: `Spam launch: ${total} tokens created` });
  }
  if (total >= 3 && tractionRate === 0) flags.push({ good: false, text: 'All tokens died with no traction' });
  if (total === 1) flags.push({ good: null, text: 'New wallet: only 1 launch so far (limited track record)' });

  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade = score >= 70 ? 'A' : score >= 50 ? 'B' : score >= 30 ? 'C' : 'D';

  return {
    wallet,
    username: coins[0]?.username || null,
    score, grade, flags,
    totalLaunches: total,
    graduated, gradRate,
    bestAthUsd: bestAth,
    bestLiveUsd: bestLive,
    lastLaunchTs,
    truncated: total >= 150,
    coins: coins.map(c => ({
      mint: c.mint, name: c.name, symbol: c.symbol, image: c.image_uri,
      createdTs: c.created_timestamp, complete: !!c.complete,
      usdMcap: c.usd_market_cap || 0, athUsd: c.ath_market_cap || 0,
      replyCount: c.reply_count || 0,
    })),
  };
}
function fmtNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + 'k';
  return String(Math.round(n));
}

const devCache = new Map();
const DEV_CACHE_TTL = 10 * 60 * 1000;

async function getDevProfile(wallet, force = false) {
  const cached = devCache.get(wallet);
  if (!force && cached && Date.now() - cached.at < DEV_CACHE_TTL) return cached.profile;
  const coins = await fetchCreatorCoins(wallet);
  const profile = scoreDev(wallet, coins);
  devCache.set(wallet, { at: Date.now(), profile });
  return profile;
}

async function creatorSummary(addr) {
  try {
    const coins = await fetchCreatorCoins(addr, 50);
    if (!coins.length) return { isCreator: false };
    return {
      isCreator: true,
      launches: coins.length,
      graduated: coins.filter(c => c.complete).length,
      bestAthUsd: Math.max(0, ...coins.map(c => c.ath_market_cap || 0)),
      username: coins[0]?.username || null,
      truncated: coins.length >= 50,
    };
  } catch { return { isCreator: false, error: true }; }
}

// ---------- Solana RPC (public, or Helius per-request) ----------
function rpcUrl(heliusKey) {
  return heliusKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}` : PUBLIC_RPC;
}
function rpcLimits(heliusKey) { return heliusKey ? { conc: 4, gap: 120 } : { conc: 2, gap: 350 }; }

const rpcQueue = [];
let rpcActive = 0;
let rpcLastStart = 0;

function rpc(method, params, heliusKey) {
  return new Promise((resolve, reject) => {
    rpcQueue.push({ payload: { jsonrpc: '2.0', id: 1, method, params }, heliusKey, resolve, reject, tries: 0 });
    drainRpc();
  });
}
function rpcBatch(calls, heliusKey) {
  return new Promise((resolve, reject) => {
    rpcQueue.push({
      payload: calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: i, method, params })),
      batch: true, heliusKey, resolve, reject, tries: 0,
    });
    drainRpc();
  });
}
function drainRpc() {
  if (rpcQueue.length === 0) return;
  const { conc, gap } = rpcLimits(rpcQueue[0].heliusKey);
  if (rpcActive >= conc) return;
  const wait = Math.max(0, rpcLastStart + gap - Date.now());
  const job = rpcQueue.shift();
  rpcActive++;
  setTimeout(async () => {
    rpcLastStart = Date.now();
    try {
      const res = await fetch(rpcUrl(job.heliusKey), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(job.payload),
      });
      if (res.status === 429) throw new Error('rate-limited');
      const body = await res.json();
      if (job.batch) {
        const sorted = (Array.isArray(body) ? body : [body]).sort((a, b) => a.id - b.id);
        job.resolve(sorted.map(r => (r.error ? null : r.result)));
      } else {
        if (body.error) throw new Error(body.error.message || 'RPC error');
        job.resolve(body.result);
      }
    } catch (e) {
      if (job.tries < 2) {
        job.tries++;
        setTimeout(() => { rpcQueue.unshift(job); rpcActive--; drainRpc(); }, 2000);
        return;
      }
      job.reject(e);
    }
    rpcActive--;
    drainRpc();
  }, wait);
  drainRpc();
}

// ---------- on-chain trace ----------
function extractTransfers(tx, wallet) {
  const out = [];
  if (!tx || !tx.meta || tx.meta.err) return out;
  const push = ix => {
    if (ix.program === 'system' && ix.parsed &&
        (ix.parsed.type === 'transfer' || ix.parsed.type === 'transferWithSeed')) {
      const { source, destination, lamports } = ix.parsed.info;
      out.push({ source, destination, sol: lamports / 1e9 });
    }
  };
  (tx.transaction?.message?.instructions || []).forEach(push);
  (tx.meta.innerInstructions || []).forEach(g => (g.instructions || []).forEach(push));
  return out.filter(t => (t.source === wallet || t.destination === wallet) && t.sol >= 0.001);
}

const clusterCache = new Map();
const CLUSTER_TTL = 15 * 60 * 1000;

async function traceWallet(wallet, heliusKey) {
  const cached = clusterCache.get(wallet);
  if (cached && Date.now() - cached.at < CLUSTER_TTL) return cached.result;

  const [balanceRes, sigs] = await Promise.all([
    rpc('getBalance', [wallet], heliusKey),
    rpc('getSignaturesForAddress', [wallet, { limit: 1000 }], heliusKey),
  ]);
  const solBalance = (balanceRes?.value ?? 0) / 1e9;
  const okSigs = (sigs || []).filter(s => !s.err);
  if (!okSigs.length) {
    const result = { wallet, solBalance, txCount: 0, funding: null, outflows: [], inflows: [] };
    clusterCache.set(wallet, { at: Date.now(), result });
    return result;
  }

  const firstSeen = (okSigs[okSigs.length - 1].blockTime || 0) * 1000;
  const lastSeen = (okSigs[0].blockTime || 0) * 1000;

  const nOld = heliusKey ? 8 : 5, nNew = heliusKey ? 30 : 14;
  const oldest = okSigs.slice(-nOld).map(s => s.signature);
  const newest = okSigs.slice(0, nNew).map(s => s.signature);
  const picked = [...new Set([...oldest, ...newest])];
  const txs = await Promise.all(picked.map(sig =>
    rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }], heliusKey).catch(() => null)
  ));

  const inflows = new Map(), outflows = new Map();
  let funding = null;
  for (const tx of txs) {
    const time = (tx?.blockTime || 0) * 1000;
    for (const t of extractTransfers(tx, wallet)) {
      if (t.destination === wallet) {
        const agg = inflows.get(t.source) || { address: t.source, sol: 0, txns: 0 };
        agg.sol += t.sol; agg.txns++;
        inflows.set(t.source, agg);
        if (!funding || time < funding.time) funding = { address: t.source, sol: t.sol, time };
      } else if (t.source === wallet) {
        const agg = outflows.get(t.destination) || { address: t.destination, sol: 0, txns: 0 };
        agg.sol += t.sol; agg.txns++;
        outflows.set(t.destination, agg);
      }
    }
  }

  const topOut = [...outflows.values()].sort((a, b) => b.sol - a.sol).slice(0, 5);
  const topIn = [...inflows.values()].filter(f => f.address !== funding?.address)
    .sort((a, b) => b.sol - a.sol).slice(0, 3);

  const related = [funding?.address, ...topOut.map(o => o.address)].filter(Boolean);
  const summaries = await Promise.all([...new Set(related)].map(async a => [a, await creatorSummary(a)]));
  const summaryMap = new Map(summaries);
  if (funding) funding.creator = summaryMap.get(funding.address) || null;
  for (const o of topOut) o.creator = summaryMap.get(o.address) || null;

  const result = {
    wallet, solBalance,
    txCount: okSigs.length, historyTruncated: sigs.length >= 1000,
    firstSeen, lastSeen,
    parsedTxs: picked.length,
    funding, outflows: topOut, inflows: topIn,
  };
  clusterCache.set(wallet, { at: Date.now(), result });
  return result;
}

// ---------- mint & deployer detection ----------
const TOKEN_PROGRAMS = new Set([
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
]);

async function isMint(addr, heliusKey) {
  try {
    const info = await rpc('getAccountInfo', [addr, { encoding: 'jsonParsed' }], heliusKey);
    const v = info?.value;
    return !!(v && TOKEN_PROGRAMS.has(v.owner) && v.data?.parsed?.type === 'mint');
  } catch { return false; }
}

async function findDeployer(mint, heliusKey) {
  const maxPages = heliusKey ? 20 : 5;
  let before;
  for (let i = 0; i < maxPages; i++) {
    const sigs = await rpc('getSignaturesForAddress', [mint, { limit: 1000, ...(before ? { before } : {}) }], heliusKey);
    if (!Array.isArray(sigs) || !sigs.length) return null;
    const oldest = sigs[sigs.length - 1];
    before = oldest.signature;
    if (sigs.length < 1000) {
      const tx = await rpc('getTransaction', [oldest.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }], heliusKey);
      const keys = tx?.transaction?.message?.accountKeys || [];
      const payer = keys.find(k => k.signer)?.pubkey || keys[0]?.pubkey;
      return payer ? { deployer: payer, createdTime: (tx?.blockTime || 0) * 1000 } : null;
    }
  }
  return null;
}

async function resolveAddress(addr, heliusKey) {
  try {
    const coin = await fetchCoin(addr);
    if (coin && coin.mint && coin.creator) {
      return {
        type: 'coin', source: 'pumpfun', wallet: coin.creator,
        coin: { mint: coin.mint, name: coin.name, symbol: coin.symbol, image: coin.image_uri },
      };
    }
  } catch { /* not a pump.fun token */ }
  if (await isMint(addr, heliusKey)) {
    const found = await findDeployer(addr, heliusKey);
    if (!found) {
      const err = new Error('This token was detected but its history is too long to trace via the free RPC.' +
        (heliusKey ? '' : ' Add a Helius API key in Settings to trace deeper.'));
      err.status = 400;
      throw err;
    }
    const m = (await enrichMints([addr]))[addr];
    return {
      type: 'coin', source: 'onchain', wallet: found.deployer,
      coin: { mint: addr, name: m?.name || addr.slice(0, 4) + '…' + addr.slice(-4), symbol: m?.symbol || '', createdTime: found.createdTime },
    };
  }
  return { type: 'wallet', wallet: addr };
}

// ---------- cross-launchpad deploy scan (Helius) ----------
const deployCache = new Map();

async function scanDeploys(wallet, heliusKey) {
  if (!heliusKey) {
    const err = new Error('This feature needs a Helius API key (free) — add it in the Settings tab');
    err.status = 400;
    throw err;
  }
  const cached = deployCache.get(wallet);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000) return cached.result;

  const allSigs = await rpc('getSignaturesForAddress', [wallet, { limit: 1000 }], heliusKey);
  const sigs = (allSigs || []).filter(s => !s.err).slice(0, 500);
  const mints = new Map();
  for (let i = 0; i < sigs.length; i += 20) {
    const chunk = sigs.slice(i, i + 20);
    const txs = await rpcBatch(chunk.map(s => ['getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]]), heliusKey);
    for (const tx of txs) {
      if (!tx || tx.meta?.err) continue;
      const keys = tx.transaction?.message?.accountKeys || [];
      if ((keys.find(k => k.signer)?.pubkey) !== wallet) continue;
      const scan = ix => {
        if ((ix.program === 'spl-token' || ix.program === 'spl-token-2022') && ix.parsed &&
            /^initializeMint2?$/.test(ix.parsed.type) && ix.parsed.info?.mint) {
          if (!mints.has(ix.parsed.info.mint)) mints.set(ix.parsed.info.mint, (tx.blockTime || 0) * 1000);
        }
      };
      (tx.transaction.message.instructions || []).forEach(scan);
      (tx.meta?.innerInstructions || []).forEach(g => (g.instructions || []).forEach(scan));
    }
  }

  const list = [...mints.entries()].map(([mint, time]) => ({ mint, time })).sort((a, b) => b.time - a.time);
  const market = await enrichMints(list.map(d => d.mint));
  for (const d of list) {
    const m = market[d.mint];
    d.name = m?.name || null; d.symbol = m?.symbol || null;
    d.dex = m?.dex || null; d.fdv = m?.fdv || 0;
    d.liqUsd = m?.liqUsd || 0; d.vol24h = m?.vol24h || 0;
    d.launchpad = d.mint.endsWith('pump') ? 'pump.fun'
      : m?.dex === 'meteora' || m?.dex === 'met-dbc' ? 'Meteora'
      : m?.dex ? m.dex : 'not detected';
    d.alive = d.fdv >= 50000 || d.liqUsd >= 10000;
  }
  const result = {
    wallet,
    txScanned: sigs.length,
    historyTruncated: (allSigs || []).length >= 1000,
    deploys: list,
    total: list.length,
    alive: list.filter(d => d.alive).length,
  };
  deployCache.set(wallet, { at: Date.now(), result });
  return result;
}

// ---------- Dexscreener enrichment ----------
const enrichCache = new Map();
async function enrichMints(mints) {
  const need = mints.filter(m => {
    const c = enrichCache.get(m);
    return !c || Date.now() - c.at > 5 * 60 * 1000;
  });
  for (let i = 0; i < need.length; i += 30) {
    const batch = need.slice(i, i + 30);
    try {
      const res = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`, {
        headers: { accept: 'application/json' },
      });
      if (!res.ok) continue;
      const pairs = await res.json();
      const best = new Map();
      for (const p of Array.isArray(pairs) ? pairs : []) {
        const mint = p.baseToken?.address;
        if (!mint) continue;
        const liq = p.liquidity?.usd || 0;
        if (!best.has(mint) || liq > best.get(mint).liqUsd) {
          best.set(mint, {
            liqUsd: liq,
            vol24h: p.volume?.h24 || 0,
            change24h: p.priceChange?.h24 ?? null,
            priceUsd: parseFloat(p.priceUsd) || 0,
            dex: p.dexId,
            fdv: p.fdv || p.marketCap || 0,
            name: p.baseToken?.name || null,
            symbol: p.baseToken?.symbol || null,
          });
        }
      }
      for (const m of batch) enrichCache.set(m, { at: Date.now(), data: best.get(m) || null });
    } catch { /* best-effort */ }
  }
  const out = {};
  for (const m of mints) out[m] = enrichCache.get(m)?.data || null;
  return out;
}

// ---------- Telegram ----------
function tgEsc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

async function sendTelegram({ token, chatId }, html) {
  if (!token || !chatId) throw new Error('Telegram is not configured yet');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  const body = await res.json();
  if (!body.ok) {
    const d = body.description || '';
    if (/blocked by the user/i.test(d)) throw new Error('Your bot is blocked / not Started. Open the chat with the bot in Telegram, press Start (or Unblock), then test again.');
    if (/chat not found/i.test(d)) throw new Error('Wrong chat ID, or you never pressed Start in the bot chat. Check the chat ID via @userinfobot and make sure you have pressed Start.');
    if (/unauthorized/i.test(d)) throw new Error('Wrong bot token — recopy the token from @BotFather (format 123456789:AAF...).');
    throw new Error(`Telegram: ${d || 'failed to send'}`);
  }
  return true;
}

function pct(rate) { return Math.round(rate * 100) + '%'; }
function usdShort(n) {
  if (!n) return '$0';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
}

function scanSignalHtml(modeLabel, filter, devs) {
  const lines = devs.slice(0, 10).map((d, i) =>
    `${i + 1}. <code>${d.wallet}</code>${d.username ? ` (${tgEsc(d.username)})` : ''}\n` +
    `    score ${d.score} · ${d.totalLaunches} launches · ${d.graduated} graduated (${pct(d.gradRate)}) · ATH ${usdShort(d.bestAthUsd)}\n` +
    `    <a href="https://solscan.io/account/${d.wallet}">solscan</a> · <a href="https://pump.fun/profile/${d.wallet}">pump.fun</a> · <a href="https://gmgn.ai/sol/address/${d.wallet}">gmgn</a>`
  );
  return `\u{1F4E1} <b>SCAN SIGNAL — ${tgEsc(modeLabel)}</b>\n` +
    `Filter: min ${filter.minLaunch} launches, min winrate ${filter.minWinrate}%\n` +
    `${devs.length} devs passed the filter\n\n` + lines.join('\n\n');
}

function watchlistSignalHtml(item, coin, stats) {
  const label = item.label ? ` (${tgEsc(item.label)})` : '';
  const track = stats && stats.isCreator
    ? `${stats.launches}${stats.truncated ? '+' : ''} launches · ${stats.graduated} graduated · ATH ${usdShort(stats.bestAthUsd)}`
    : 'track record unavailable';
  return `\u{1F514} <b>WATCHLIST SIGNAL — NEW LAUNCH</b>\n` +
    `A dev on your watchlist just launched a token!\n\n` +
    `<b>Token:</b> ${tgEsc(coin.name)} (${tgEsc(coin.symbol)})\n` +
    `<b>CA:</b> <code>${coin.mint}</code>\n` +
    `<b>Dev:</b> <code>${item.wallet}</code>${label}\n` +
    `<b>Track record:</b> ${track}\n\n` +
    `<a href="https://pump.fun/coin/${coin.mint}">pump.fun</a> · <a href="https://dexscreener.com/solana/${coin.mint}">dexscreener</a> · <a href="https://solscan.io/account/${item.wallet}">solscan dev</a>`;
}

// ---------- HTTP helpers ----------
function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}
function isBase58(s) { return BASE58.test(s || ''); }

module.exports = {
  listCoins, fetchCoins, fetchCreatorCoins, getDevProfile, creatorSummary,
  traceWallet, resolveAddress, scanDeploys, enrichMints,
  sendTelegram, scanSignalHtml, watchlistSignalHtml,
  json, readBody, isBase58, rpc,
};
