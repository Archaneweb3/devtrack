// ================= util =================
const $ = s => document.querySelector(s);
const DAY = 24 * 60 * 60 * 1000;

const ICON = {
  ext: '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  star: '<svg viewBox="0 0 24 24"><path d="m12 3 2.7 5.8 6.3.7-4.7 4.3 1.3 6.2-5.6-3.2L6.4 20l1.3-6.2L3 9.5l6.3-.7z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m4 12 5 5L20 6"/></svg>',
};

function fmtUsd(n) {
  if (!n) return '—';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(0);
}
function fmtSol(n) { return n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(2) : n.toFixed(3); }
function fmtAgo(ts) {
  if (!ts) return '—';
  const d = Date.now() - ts;
  if (d < 60e3) return 'baru saja';
  if (d < 3600e3) return Math.floor(d / 60e3) + 'm';
  if (d < DAY) return Math.floor(d / 3600e3) + 'j';
  if (d < 30 * DAY) return Math.floor(d / DAY) + 'h';
  return Math.floor(d / (30 * DAY)) + 'bln';
}
function short(w) { return w.slice(0, 4) + '…' + w.slice(-4); }
function esc(s) { return (s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function gradeCls(g) { return 'sc-' + g.toLowerCase(); }

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

// ================= penyimpanan lokal (browser) =================
const store = {
  get(k, def) {
    try { const v = JSON.parse(localStorage.getItem('devtrack.' + k)); return v === null || v === undefined ? def : v; }
    catch { return def; }
  },
  set(k, v) { localStorage.setItem('devtrack.' + k, JSON.stringify(v)); },
};
let settings = store.get('settings', { tgToken: '', tgChat: '', heliusKey: '' });
let watchlist = store.get('watchlist', []); // [{wallet, label, addedAt, lastMint}]

function tgConfigured() { return !!(settings.tgToken && settings.tgChat); }
function heliusConfigured() { return !!settings.heliusKey; }
function hk() { return heliusConfigured() ? '&heliusKey=' + encodeURIComponent(settings.heliusKey) : ''; }
function watchlistWallets() { return new Set(watchlist.map(w => w.wallet)); }
function saveWatchlist() { store.set('watchlist', watchlist); if (typeof syncBotConfig === 'function') syncBotConfig(); }
function saveSettings() { store.set('settings', settings); }

// ================= tabs =================
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    $('#tab-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'watchlist') renderWatchlist(false);
    if (btn.dataset.tab === 'settings') renderSettings();
    if (btn.dataset.tab === 'bot') renderBot();
  });
});

// ================= auto-buy bot =================
let botCfg = store.get('botcfg', {
  mode: 'simulation', buySol: 0.05, slippage: 15, priorityFee: 0.001, maxBuysPerDevPerDay: 1, privateKey: '',
  takeProfit: [{ mult: 2, pct: 50 }, { mult: 5, pct: 25 }], stopLoss: { mult: 0, pct: 0 },
});
botCfg.takeProfit = botCfg.takeProfit || [{ mult: 2, pct: 50 }, { mult: 5, pct: 25 }];
botCfg.stopLoss = botCfg.stopLoss || { mult: 0, pct: 0 };
const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);

function renderBot() {
  $('#bot-local-warn').classList.toggle('hidden', isLocal);
  document.querySelector(`input[name="bot-mode"][value="${botCfg.mode}"]`).checked = true;
  $('#bot-sol').value = botCfg.buySol;
  $('#bot-slippage').value = botCfg.slippage;
  $('#bot-priority').value = botCfg.priorityFee;
  $('#bot-maxbuys').value = botCfg.maxBuysPerDevPerDay;
  $('#bot-key').value = botCfg.privateKey || '';
  const tp = botCfg.takeProfit;
  $('#tp1-pct').value = tp[0]?.pct ?? 50;
  $('#tp1-mult').value = tp[0]?.mult ?? 2;
  $('#tp2-pct').value = tp[1]?.pct ?? 0;
  $('#tp2-mult').value = tp[1]?.mult ?? 0;
  $('#sl-pct').value = botCfg.stopLoss?.pct ?? 0;
  $('#sl-mult').value = botCfg.stopLoss?.mult ?? 0;
  refreshBotSyncInfo();
}

async function refreshBotSyncInfo() {
  const el = $('#bot-sync-info');
  if (!isLocal) { el.innerHTML = 'Jalankan versi lokal untuk mengaktifkan bot.'; return; }
  try {
    const s = await api('/api/bot-config');
    el.innerHTML = `Config bot: <b>${s.hasKey ? 'private key terpasang' : 'belum ada key'}</b> · mode <b>${esc(s.mode)}</b>` +
      (s.updatedAt ? ` · sinkron terakhir ${fmtAgo(s.updatedAt)}` : ' · belum pernah sinkron') +
      `. Memantau <b>${watchlist.length} dev</b>. Jalankan <span class="addr">node bot.js</span> untuk mulai.`;
  } catch { el.innerHTML = 'Server lokal tidak terjangkau.'; }
}

async function syncBotConfig() {
  if (!isLocal) return;
  try {
    await api('/api/bot-config', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: botCfg.mode, buySol: botCfg.buySol, slippage: botCfg.slippage,
        priorityFee: botCfg.priorityFee, maxBuysPerDevPerDay: botCfg.maxBuysPerDevPerDay,
        privateKey: botCfg.privateKey, takeProfit: botCfg.takeProfit, stopLoss: botCfg.stopLoss,
        tgToken: settings.tgToken, tgChat: settings.tgChat, heliusKey: settings.heliusKey,
        watchlist: watchlist.map(w => ({ wallet: w.wallet, label: w.label })),
      }),
    });
  } catch { /* server lokal mungkin mati */ }
}

$('#btn-bot-save').addEventListener('click', async () => {
  botCfg.mode = document.querySelector('input[name="bot-mode"]:checked').value;
  botCfg.buySol = parseFloat($('#bot-sol').value) || 0.05;
  botCfg.slippage = parseInt($('#bot-slippage').value, 10) || 15;
  botCfg.priorityFee = parseFloat($('#bot-priority').value) || 0.001;
  botCfg.maxBuysPerDevPerDay = parseInt($('#bot-maxbuys').value, 10) || 1;
  botCfg.privateKey = $('#bot-key').value.trim();
  // aturan jual
  const tp = [];
  const t1m = parseFloat($('#tp1-mult').value), t1p = parseFloat($('#tp1-pct').value);
  const t2m = parseFloat($('#tp2-mult').value), t2p = parseFloat($('#tp2-pct').value);
  if (t1m > 1 && t1p > 0) tp.push({ mult: t1m, pct: t1p });
  if (t2m > 1 && t2p > 0) tp.push({ mult: t2m, pct: t2p });
  botCfg.takeProfit = tp;
  botCfg.stopLoss = { mult: parseFloat($('#sl-mult').value) || 0, pct: parseFloat($('#sl-pct').value) || 0 };
  store.set('botcfg', botCfg);
  const st = $('#bot-status');
  if (botCfg.mode === 'live' && !botCfg.privateKey) {
    st.textContent = 'Mode live butuh private key wallet burner.';
  } else if (!isLocal) {
    st.textContent = 'Tersimpan di browser, tapi bot hanya jalan di versi lokal.';
  } else {
    await syncBotConfig();
    st.textContent = 'Tersimpan & tersinkron ke bot.';
  }
  refreshBotSyncInfo();
});

// ================= settings =================
function renderSettings() {
  $('#tg-token').value = settings.tgToken;
  $('#tg-chat').value = settings.tgChat;
  $('#helius-key').value = settings.heliusKey;
  renderMonitorStatus();
}
function renderMonitorStatus() {
  const el = $('#monitor-status');
  if (!el) return;
  const conn = monitorConnected
    ? '<b style="color:var(--green)">tersambung real-time</b> ke stream pump.fun (delay ~1–3 detik)'
    : '<b style="color:var(--amber)">menyambung…</b>';
  el.innerHTML =
    `Monitor watchlist: ${conn} — memantau <b>${watchlist.length} dev</b>.` +
    (tgConfigured() ? ' Alert dikirim ke Telegram.' : ' <b>Isi token &amp; chat ID</b> agar alert masuk Telegram.') +
    '<br><span style="color:var(--faint)">Catatan: browser bisa menunda alert kalau tab lama tidak aktif. Untuk real-time yang benar-benar andal (dan auto-buy), jalankan <span class="addr">node bot.js</span>.</span>';
}

// auto-save: setiap ketikan langsung tersimpan, tanpa harus klik Simpan
let autoSaveTimer = null;
function autoSaveSettings() {
  settings.tgToken = $('#tg-token').value.trim();
  settings.tgChat = $('#tg-chat').value.trim();
  settings.heliusKey = $('#helius-key').value.trim();
  saveSettings();
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    $('#tg-status').textContent = 'Tersimpan otomatis.';
    $('#helius-status').textContent = settings.heliusKey ? 'Tersimpan otomatis.' : '';
    renderMonitorStatus();
  }, 400);
}
['#tg-token', '#tg-chat', '#helius-key'].forEach(sel => {
  $(sel).addEventListener('input', autoSaveSettings);
});

$('#btn-tg-save').addEventListener('click', () => {
  autoSaveSettings();
  $('#tg-status').textContent = tgConfigured() ? 'Tersimpan.' : 'Tersimpan (belum lengkap).';
  renderMonitorStatus();
});

$('#btn-tg-test').addEventListener('click', async () => {
  const st = $('#tg-status');
  st.textContent = 'Mengirim tes…';
  try {
    await api('/api/telegram', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'test', token: $('#tg-token').value.trim(), chatId: $('#tg-chat').value.trim() }),
    });
    st.textContent = 'Pesan tes terkirim — cek Telegram kamu.';
  } catch (e) { st.textContent = 'Gagal: ' + e.message; }
});

$('#btn-helius-save').addEventListener('click', () => {
  autoSaveSettings();
  $('#helius-status').textContent = heliusConfigured() ? 'Tersimpan — RPC beralih ke Helius.' : 'Key dikosongkan — kembali ke RPC publik.';
});

$('#btn-helius-test').addEventListener('click', async () => {
  const st = $('#helius-status');
  const key = $('#helius-key').value.trim();
  if (!key) { st.textContent = 'Isi key dulu.'; return; }
  st.textContent = 'Menguji koneksi…';
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getVersion', params: [] }),
    });
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || 'key ditolak');
    st.textContent = `Terhubung (solana-core ${body.result?.['solana-core'] || 'ok'}).`;
  } catch (e) { st.textContent = 'Gagal: ' + e.message; }
});

// ================= global search (CA token ATAU wallet dev) =================
$('#global-search').addEventListener('keydown', async e => {
  if (e.key !== 'Enter') return;
  const input = e.target;
  const q = input.value.trim();
  if (!q) return;
  input.disabled = true;
  const drawerBody = $('#drawer-body');
  drawer.classList.add('open');
  overlay.classList.remove('hidden');
  drawerBody.innerHTML = '<div class="loading-note">Mengenali alamat… (CA token atau wallet dev)</div>';
  try {
    const r = await api('/api/resolve?address=' + encodeURIComponent(q) + hk());
    input.value = '';
    openDrawer(r.wallet, r.type === 'coin' ? r.coin : null);
  } catch (err) {
    drawerBody.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
  } finally {
    input.disabled = false;
  }
});

// ================= watchlist =================
async function addToWatchlist(wallet, label) {
  if (!watchlist.find(w => w.wallet === wallet)) {
    const item = { wallet, label: label || '', addedAt: Date.now(), lastMint: null };
    try { item.lastMint = (await api('/api/latest?wallet=' + wallet))?.mint || null; } catch { /* set saat monitor */ }
    watchlist.push(item);
    saveWatchlist();
  }
  document.querySelectorAll(`.btn-watch[data-wallet="${wallet}"]`).forEach(b => { b.innerHTML = ICON.check; b.disabled = true; b.title = 'Sudah dipantau'; });
}

$('#btn-wl-add').addEventListener('click', async () => {
  const wallet = $('#wl-wallet').value.trim();
  if (!wallet) return;
  await addToWatchlist(wallet, $('#wl-label').value.trim());
  $('#wl-wallet').value = ''; $('#wl-label').value = '';
  renderWatchlist(false);
});
$('#btn-wl-refresh').addEventListener('click', () => renderWatchlist(true));

async function renderWatchlist(force) {
  const body = $('#wl-body');
  if (!watchlist.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-cell">Watchlist kosong. Tambahkan wallet dari scanner atau manual.</td></tr>';
    return;
  }
  body.innerHTML = watchlist.map(item => `
    <tr>
      <td><span class="addr">${short(item.wallet)}</span></td>
      <td class="dim">${esc(item.label) || '—'}</td>
      <td colspan="5"><span class="skel" style="width:180px"></span></td>
      <td></td>
    </tr>`).join('');
  $('#wl-status').textContent = 'Memuat…';

  const rows = [];
  for (const item of watchlist) {
    try {
      const p = await api('/api/dev?wallet=' + item.wallet + (force ? '&force=1' : ''));
      const isNew = p.lastLaunchTs && Date.now() - p.lastLaunchTs < DAY;
      rows.push(`
      <tr class="row-click" data-wallet="${p.wallet}">
        <td><span class="addr">${short(p.wallet)}</span>${p.username ? `<span class="addr-user">${esc(p.username)}</span>` : ''}${isNew ? '<span class="badge-new">LAUNCH BARU</span>' : ''}</td>
        <td class="dim">${esc(item.label) || '—'}</td>
        <td>${scoreCell(p)}</td>
        <td class="num">${p.totalLaunches}${p.truncated ? '+' : ''}</td>
        <td class="num">${p.graduated} <span class="dim">(${Math.round(p.gradRate * 100)}%)</span></td>
        <td class="num">${fmtUsd(p.bestAthUsd)}</td>
        <td class="dim">${fmtAgo(p.lastLaunchTs)}</td>
        <td class="col-act"><button class="icon-btn btn-wl-del" data-wallet="${p.wallet}" title="Hapus">${ICON.trash}</button></td>
      </tr>`);
    } catch (e) {
      rows.push(`<tr><td colspan="8" class="dim">${short(item.wallet)} — gagal: ${esc(e.message)}</td></tr>`);
    }
    body.innerHTML = rows.join('');
  }
  $('#wl-status').textContent = '';
  bindTableEvents(body);
  body.querySelectorAll('.btn-wl-del').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    watchlist = watchlist.filter(w => w.wallet !== b.dataset.wallet);
    saveWatchlist();
    renderWatchlist(false);
  }));
}

// ================= monitor watchlist REAL-TIME (WebSocket, selama tab terbuka) =================
let monitorLastRun = 0;      // waktu event terakhir diterima dari stream
let monitorConnected = false;
let monitorWs = null;
const alertedMints = new Set(); // hindari alert dobel utk mint yang sama

function startWatchMonitor() {
  try {
    monitorWs = new WebSocket('wss://pumpportal.fun/api/data');
    monitorWs.onopen = () => {
      monitorConnected = true;
      monitorWs.send(JSON.stringify({ method: 'subscribeNewToken' }));
      renderMonitorStatus();
    };
    monitorWs.onmessage = async e => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      monitorLastRun = Date.now();
      if (!d.mint || d.txType !== 'create') return;
      const wl = watchlist.find(w => w.wallet === d.traderPublicKey);
      if (!wl || alertedMints.has(d.mint)) return;
      alertedMints.add(d.mint);
      wl.lastMint = d.mint; saveWatchlist();

      // alert instan: notifikasi browser + Telegram
      const title = `${wl.label || short(wl.wallet)} launch ${d.symbol || 'token'}`;
      try {
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('🔔 Dev watchlist launch!', { body: `${d.name || ''} (${d.symbol || ''})\n${d.mint}` });
        }
      } catch { /* noop */ }
      if (tgConfigured()) {
        api('/api/telegram', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            type: 'watchlist', token: settings.tgToken, chatId: settings.tgChat,
            wallet: wl.wallet, label: wl.label,
            coin: { mint: d.mint, name: d.name, symbol: d.symbol },
          }),
        }).catch(() => {});
      }
      if ($('#tab-watchlist').classList.contains('active')) renderWatchlist(false);
    };
    monitorWs.onclose = () => { monitorConnected = false; renderMonitorStatus(); setTimeout(startWatchMonitor, 3000); };
    monitorWs.onerror = () => { try { monitorWs.close(); } catch { /* noop */ } };
  } catch { setTimeout(startWatchMonitor, 5000); }
}
startWatchMonitor();
// minta izin notifikasi browser sekali
if ('Notification' in window && Notification.permission === 'default') {
  setTimeout(() => Notification.requestPermission().catch(() => {}), 3000);
}
renderSettings(); // isi field pengaturan dari localStorage sejak halaman dimuat

// ================= dev card / table rendering =================
function primaryTag(p) {
  const bad = (p.flags || []).find(f => f.good === false);
  if (bad) return `<span class="tag tag-bad">${esc(bad.text)}</span>`;
  const good = (p.flags || []).find(f => f.good === true);
  if (good) return `<span class="tag tag-good">${esc(good.text)}</span>`;
  const neutral = (p.flags || [])[0];
  if (neutral) return `<span class="tag tag-warn">${esc(neutral.text)}</span>`;
  return '<span class="dim">—</span>';
}
function scoreCell(p) {
  return `<div class="score-cell ${gradeCls(p.grade)}">
    <span class="score-num">${p.score}</span>
    <span class="score-bar"><i style="width:${p.score}%"></i></span>
  </div>`;
}

// ================= scanner =================
let scanAbort = false;
let scanProfiles = [];

function scanFilter(p) {
  const minLaunch = parseInt($('#f-launch').value, 10) || 0;
  const minWinrate = parseInt($('#f-winrate').value, 10) || 0;
  return p.totalLaunches >= minLaunch && p.gradRate * 100 >= minWinrate;
}

$('#btn-scan').addEventListener('click', async () => {
  const mode = $('#scan-mode').value, limit = $('#scan-limit').value;
  const btn = $('#btn-scan');
  btn.disabled = true; scanAbort = false; scanProfiles = [];
  $('#btn-stop').classList.remove('hidden');
  $('#btn-send-signal').classList.add('hidden');
  $('#scan-progress').classList.remove('hidden');
  $('#scan-bar').style.width = '0%';
  const deep = mode === 'graduated24';
  $('#scan-status').textContent = deep ? 'Mengambil semua token graduate 24 jam terakhir… (bisa 1–2 menit)' : 'Mengambil daftar token…';
  $('#scan-body').innerHTML = '<tr><td colspan="9" class="empty-cell">Mengambil token dari pump.fun…</td></tr>';

  try {
    const coins = await api(`/api/coins?mode=${mode}&limit=${limit}`);
    const creators = new Map();
    for (const c of coins) {
      if (!c.creator) continue;
      if (!creators.has(c.creator)) creators.set(c.creator, []);
      creators.get(c.creator).push(c);
    }
    const wallets = [...creators.keys()];
    const total = wallets.length;
    let done = 0;

    async function worker() {
      while (wallets.length && !scanAbort) {
        const w = wallets.shift();
        try {
          const p = await api('/api/dev?wallet=' + w);
          p._via = (creators.get(w) || [])[0];
          scanProfiles.push(p);
        } catch { /* skip */ }
        done++;
        $('#scan-status').textContent = `${done}/${total} dev dianalisis`;
        $('#scan-bar').style.width = Math.round(done / total * 100) + '%';
        renderScanTable();
      }
    }
    await Promise.all(Array.from({ length: 3 }, worker));
    $('#scan-status').textContent = (scanAbort ? 'Dihentikan — ' : 'Selesai — ') + `${scanProfiles.length} dev dianalisis`;
    $('#scan-bar').style.width = '100%';
    if (!scanProfiles.length) $('#scan-body').innerHTML = '<tr><td colspan="9" class="empty-cell">Tidak ada dev yang berhasil dianalisis.</td></tr>';
    if (tgConfigured() && scanProfiles.filter(scanFilter).length) $('#btn-send-signal').classList.remove('hidden');
  } catch (e) {
    $('#scan-body').innerHTML = `<tr><td colspan="9" class="empty-cell">Scan gagal: ${esc(e.message)}</td></tr>`;
    $('#scan-status').textContent = '';
  } finally {
    btn.disabled = false;
    $('#btn-stop').classList.add('hidden');
    setTimeout(() => $('#scan-progress').classList.add('hidden'), 1200);
  }
});
$('#btn-stop').addEventListener('click', () => { scanAbort = true; });
$('#f-launch').addEventListener('input', () => { if (scanProfiles.length) renderScanTable(); });
$('#f-winrate').addEventListener('input', () => { if (scanProfiles.length) renderScanTable(); });

const MODE_LABELS = {
  graduated: 'Baru graduate', graduated24: 'Semua graduate 24 jam',
  new: 'Token terbaru', top: 'Top market cap',
};
$('#btn-send-signal').addEventListener('click', async function () {
  const passed = scanProfiles.filter(scanFilter).sort((a, b) => (b.gradRate - a.gradRate) || (b.score - a.score));
  if (!passed.length) return;
  this.disabled = true; this.textContent = 'Mengirim…';
  try {
    const r = await api('/api/telegram', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'scan', token: settings.tgToken, chatId: settings.tgChat,
        modeLabel: MODE_LABELS[$('#scan-mode').value] || 'Scan',
        filter: { minLaunch: $('#f-launch').value, minWinrate: $('#f-winrate').value },
        devs: passed.slice(0, 10).map(p => ({
          wallet: p.wallet, username: p.username, score: p.score,
          totalLaunches: p.totalLaunches, graduated: p.graduated,
          gradRate: p.gradRate, bestAthUsd: p.bestAthUsd,
        })),
      }),
    });
    this.textContent = `Terkirim (${r.sent} dev)`;
    setTimeout(() => { this.textContent = 'Kirim signal Telegram'; this.disabled = false; }, 3000);
  } catch (e) {
    this.textContent = 'Gagal: ' + e.message;
    setTimeout(() => { this.textContent = 'Kirim signal Telegram'; this.disabled = false; }, 4000);
  }
});

function renderScanTable() {
  const passed = scanProfiles.filter(scanFilter);
  const sorted = [...passed].sort((a, b) => (b.gradRate - a.gradRate) || (b.score - a.score));
  $('#scan-filtered').textContent = scanProfiles.length
    ? `${passed.length} dari ${scanProfiles.length} dev lolos filter`
    : '';
  if (!sorted.length && scanProfiles.length) {
    $('#scan-body').innerHTML = '<tr><td colspan="9" class="empty-cell">Belum ada dev yang lolos filter — turunkan "Min launch" / "Min winrate", atau tunggu scan menemukan lebih banyak dev.</td></tr>';
    return;
  }
  const inWlSet = watchlistWallets();
  $('#scan-body').innerHTML = sorted.map((p, i) => {
    const inWl = inWlSet.has(p.wallet);
    return `
    <tr class="row-click" data-wallet="${p.wallet}">
      <td class="col-rank">${i + 1}</td>
      <td><span class="addr">${short(p.wallet)}</span>${p.username ? `<span class="addr-user">${esc(p.username)}</span>` : ''}</td>
      <td>${scoreCell(p)}</td>
      <td class="num">${p.totalLaunches}${p.truncated ? '+' : ''}</td>
      <td class="num">${p.graduated} <span class="dim">(${Math.round(p.gradRate * 100)}%)</span></td>
      <td class="num">${fmtUsd(p.bestAthUsd)}</td>
      <td class="dim">${fmtAgo(p.lastLaunchTs)}</td>
      <td>${primaryTag(p)}</td>
      <td class="col-act">
        <button class="icon-btn btn-watch" data-wallet="${p.wallet}" title="${inWl ? 'Sudah dipantau' : 'Tambah ke watchlist'}" ${inWl ? 'disabled' : ''}>${inWl ? ICON.check : ICON.star}</button>
      </td>
    </tr>`;
  }).join('');
  bindTableEvents($('#scan-body'));
}

function bindTableEvents(tbody) {
  tbody.querySelectorAll('.btn-watch').forEach(b => b.addEventListener('click', e => {
    e.stopPropagation();
    addToWatchlist(b.dataset.wallet).catch(() => {});
  }));
  tbody.querySelectorAll('tr.row-click').forEach(tr =>
    tr.addEventListener('click', () => openDrawer(tr.dataset.wallet)));
}

// ================= drawer =================
const drawer = $('#drawer'), overlay = $('#overlay');
function closeDrawer() { drawer.classList.remove('open'); overlay.classList.add('hidden'); }
$('#drawer-close').addEventListener('click', closeDrawer);
overlay.addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

async function openDrawer(wallet, viaCoin) {
  drawer.classList.add('open');
  overlay.classList.remove('hidden');
  const body = $('#drawer-body');
  body.innerHTML = '<div class="loading-note">Memuat track record…</div>';
  try {
    const p = await api('/api/dev?wallet=' + encodeURIComponent(wallet));
    renderProfile(p, viaCoin);
  } catch (e) {
    body.innerHTML = `<div class="error-box">${esc(e.message)}</div>`;
  }
}

function renderProfile(p, viaCoin) {
  const inWl = watchlistWallets().has(p.wallet);
  const flags = (p.flags || []).map(f =>
    `<span class="tag ${f.good === true ? 'tag-good' : f.good === false ? 'tag-bad' : 'tag-warn'}">${esc(f.text)}</span>`).join('');

  const coinRows = p.coins.map(c => `
    <tr>
      <td><div class="coin-name">${c.image ? `<img src="${esc(c.image)}" loading="lazy" onerror="this.remove()">` : ''}<span>${esc(c.name)} <span class="sym">${esc(c.symbol)}</span></span></div></td>
      <td class="dim">${fmtAgo(c.createdTs)}</td>
      <td>${c.complete ? '<span class="tag tag-good">Graduate</span>' : '<span class="tag tag-plain">Bonding</span>'}</td>
      <td class="num">${fmtUsd(c.usdMcap)}</td>
      <td class="num">${fmtUsd(c.athUsd)}</td>
      <td class="num" data-liq="${c.mint}"><span class="skel" style="width:36px"></span></td>
      <td class="num" data-vol="${c.mint}"><span class="skel" style="width:36px"></span></td>
      <td><a href="https://dexscreener.com/solana/${c.mint}" target="_blank" title="Chart">${ICON.ext}</a></td>
    </tr>`).join('');

  $('#drawer-body').innerHTML = `
    ${viaCoin ? `<div class="dw-via"><span class="tag tag-info">Dev di balik token ${esc(viaCoin.name)} ${viaCoin.symbol ? `(${esc(viaCoin.symbol)})` : ''}</span></div>` : ''}
    <div class="dw-addr-row">
      <span class="dw-addr">${p.wallet}</span>
      <button class="icon-btn" id="btn-copy" title="Salin alamat">${ICON.copy}</button>
      ${p.username ? `<span class="addr-user">${esc(p.username)}</span>` : ''}
    </div>
    <div class="dw-links">
      <a href="https://solscan.io/account/${p.wallet}" target="_blank">Solscan ${ICON.ext}</a>
      <a href="https://pump.fun/profile/${p.wallet}" target="_blank">pump.fun ${ICON.ext}</a>
      <a href="https://gmgn.ai/sol/address/${p.wallet}" target="_blank">GMGN ${ICON.ext}</a>
      <button class="btn btn-sm btn-watch" data-wallet="${p.wallet}" ${inWl ? 'disabled' : ''} style="margin-left:auto">${inWl ? 'Dipantau' : 'Tambah ke watchlist'}</button>
    </div>

    <div class="stat-grid">
      <div class="stat"><span>Skor</span><b class="${gradeCls(p.grade)}">${p.score} <small style="font-size:.7rem">/ 100</small></b></div>
      <div class="stat"><span>Launch</span><b>${p.totalLaunches}${p.truncated ? '+' : ''}</b></div>
      <div class="stat"><span>Graduate</span><b>${p.graduated} <small style="font-size:.7rem;color:var(--muted)">(${Math.round(p.gradRate * 100)}%)</small></b></div>
      <div class="stat"><span>ATH terbaik</span><b>${fmtUsd(p.bestAthUsd)}</b></div>
      <div class="stat"><span>MCap live terbesar</span><b>${fmtUsd(p.bestLiveUsd)}</b></div>
      <div class="stat"><span>Launch terakhir</span><b>${fmtAgo(p.lastLaunchTs)}</b></div>
    </div>
    ${flags ? `<div class="flag-list">${flags}</div>` : ''}

    <div class="section-title">Trace on-chain — arah dana &amp; wallet terkait</div>
    <div class="trace-box" id="trace-box">
      <p class="trace-note">Menelusuri riwayat transaksi via RPC Solana: siapa yang mendanai wallet ini, ke mana SOL dikirim, dan apakah wallet-wallet terkait itu juga pernah membuat token (deteksi dev gonta-ganti wallet).</p>
      <button class="btn btn-sm" id="btn-trace" data-wallet="${p.wallet}">Jalankan trace</button>
    </div>

    <div class="section-title">Deploy lintas launchpad — Meteora dll</div>
    <div class="trace-box" id="deploy-box">
      ${heliusConfigured()
        ? `<p class="trace-note">Scan 500 transaksi terakhir wallet ini via Helius untuk menemukan SEMUA token yang pernah dia deploy — pump.fun, Meteora DBC, atau launchpad lain.</p>
           <button class="btn btn-sm" id="btn-deploys" data-wallet="${p.wallet}">Scan deploy lintas launchpad</button>`
        : '<p class="trace-note">Butuh Helius API key (gratis, daftar di dashboard.helius.dev) — isi di tab Pengaturan untuk mengaktifkan fitur ini.</p>'}
    </div>

    <div class="section-title">Riwayat token pump.fun (${p.totalLaunches}${p.truncated ? '+, 150 terbaru' : ''})</div>
    <div class="tbl-scroll">
      <table class="coin-table">
        <thead><tr><th>Token</th><th>Umur</th><th>Status</th><th class="num">MCap</th><th class="num">ATH</th><th class="num">Liq</th><th class="num">Vol 24j</th><th></th></tr></thead>
        <tbody>${coinRows || '<tr><td colspan="8" class="dim">Belum pernah membuat token di pump.fun.</td></tr>'}</tbody>
      </table>
    </div>`;

  $('#btn-copy').addEventListener('click', () => navigator.clipboard.writeText(p.wallet).catch(() => {}));
  $('#drawer-body').querySelector('.btn-watch')?.addEventListener('click', function () { addToWatchlist(p.wallet).then(() => { this.textContent = 'Dipantau'; this.disabled = true; }).catch(() => {}); });
  $('#btn-trace').addEventListener('click', () => runTrace(p.wallet));
  $('#btn-deploys')?.addEventListener('click', () => runDeployScan(p.wallet));
  loadEnrichment(p.coins.map(c => c.mint).slice(0, 60));
}

// ---- Dexscreener enrichment ----
async function loadEnrichment(mints) {
  if (!mints.length) return;
  try {
    const data = await api('/api/enrich?mints=' + mints.join(','));
    for (const m of mints) {
      const d = data[m];
      const liqEl = document.querySelector(`[data-liq="${m}"]`);
      const volEl = document.querySelector(`[data-vol="${m}"]`);
      if (liqEl) liqEl.innerHTML = d ? fmtUsd(d.liqUsd) : '<span class="dim">—</span>';
      if (volEl) {
        if (d) {
          const chg = d.change24h;
          volEl.innerHTML = fmtUsd(d.vol24h) + (chg != null ? ` <span class="${chg >= 0 ? 'chg-up' : 'chg-down'}">${chg >= 0 ? '+' : ''}${chg}%</span>` : '');
        } else volEl.innerHTML = '<span class="dim">—</span>';
      }
    }
  } catch {
    document.querySelectorAll('[data-liq] .skel, [data-vol] .skel').forEach(s => s.outerHTML = '<span class="dim">—</span>');
  }
}

// ---- on-chain trace ----
function creatorChip(c) {
  if (!c || c.error) return '<span class="tag tag-plain">cek gagal</span>';
  if (!c.isCreator) return '<span class="tag tag-plain">bukan creator</span>';
  const risky = c.launches >= 8 && c.graduated / c.launches < 0.05;
  const cls = risky ? 'tag-bad' : c.graduated > 0 ? 'tag-good' : 'tag-warn';
  return `<span class="tag ${cls}">creator: ${c.launches}${c.truncated ? '+' : ''} token, ${c.graduated} graduate${c.bestAthUsd >= 50000 ? ', ATH ' + fmtUsd(c.bestAthUsd) : ''}</span>`;
}

function flowItem(f) {
  return `
  <div class="flow-item">
    <span class="addr" data-open="${f.address}" title="Buka profil dev">${short(f.address)}</span>
    <a href="https://solscan.io/account/${f.address}" target="_blank" title="Solscan">${ICON.ext}</a>
    ${f.creator ? creatorChip(f.creator) : ''}
    <span class="flow-amt">${fmtSol(f.sol)} SOL${f.txns > 1 ? ` · ${f.txns} tx` : ''}</span>
  </div>`;
}

async function runTrace(wallet) {
  const box = $('#trace-box');
  box.innerHTML = '<div class="loading-note">Menelusuri on-chain… mengambil riwayat transaksi &amp; memeriksa wallet terkait (±10–20 detik)</div>';
  try {
    const t = await api('/api/cluster?wallet=' + wallet + hk());
    if (!t.txCount) {
      box.innerHTML = '<p class="trace-note">Wallet ini belum punya riwayat transaksi on-chain.</p>';
      return;
    }
    const ageDays = t.firstSeen ? Math.max(1, Math.round((Date.now() - t.firstSeen) / DAY)) : null;
    let html = `
      <div class="trace-stats">
        <span>Saldo <b>${fmtSol(t.solBalance)} SOL</b></span>
        <span>Transaksi <b>${t.txCount}${t.historyTruncated ? '+' : ''}</b></span>
        ${ageDays ? `<span>Umur wallet <b>${ageDays} hari</b></span>` : ''}
        <span class="dim" style="font-size:.72rem">${t.parsedTxs} tx dianalisis (${t.historyTruncated ? 'riwayat panjang, sampel awal & akhir' : 'awal & akhir riwayat'})</span>
      </div>`;

    if (t.funding) {
      html += `<div class="flow-group"><div class="flow-label">Didanai oleh (funding pertama)</div>${flowItem(t.funding)}</div>`;
    } else {
      html += '<div class="flow-group"><div class="flow-label">Didanai oleh</div><p class="trace-note">Tidak ditemukan transfer SOL masuk pada sampel transaksi yang dianalisis.</p></div>';
    }
    if (t.outflows.length) {
      html += `<div class="flow-group"><div class="flow-label">Dana keluar ke</div>${t.outflows.map(flowItem).join('')}</div>`;
    } else {
      html += '<div class="flow-group"><div class="flow-label">Dana keluar</div><p class="trace-note">Tidak ada transfer SOL keluar pada sampel transaksi terbaru.</p></div>';
    }
    if (t.inflows.length) {
      html += `<div class="flow-group"><div class="flow-label">Pemasukan lain</div>${t.inflows.map(flowItem).join('')}</div>`;
    }
    html += '<p class="trace-note" style="margin-top:10px;margin-bottom:0">Klik alamat untuk membuka profil dev wallet tersebut — berguna untuk mengikuti jejak dev yang berpindah wallet.</p>';
    box.innerHTML = html;
    box.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', () => openDrawer(el.dataset.open)));
  } catch (e) {
    box.innerHTML = `<div class="error-box">Trace gagal: ${esc(e.message)}. RPC publik kadang penuh — coba lagi beberapa detik.</div>
      <button class="btn btn-sm" id="btn-trace" data-wallet="${wallet}">Coba lagi</button>`;
    $('#btn-trace').addEventListener('click', () => runTrace(wallet));
  }
}

// ---- scan deploy lintas launchpad (Helius) ----
async function runDeployScan(wallet) {
  const box = $('#deploy-box');
  box.innerHTML = '<div class="loading-note">Memindai 500 transaksi terakhir via Helius… (±20–60 detik)</div>';
  try {
    const r = await api('/api/deploys?wallet=' + wallet + hk());
    if (!r.total) {
      box.innerHTML = `<p class="trace-note">Tidak ada deploy token ditemukan di ${r.txScanned} transaksi terakhir wallet ini${r.historyTruncated ? ' (riwayat lebih lama tidak dipindai)' : ''}.</p>`;
      return;
    }
    const rows = r.deploys.map(d => `
      <tr>
        <td><div class="coin-name"><span>${esc(d.name || short(d.mint))} <span class="sym">${esc(d.symbol || '')}</span></span></div></td>
        <td><span class="tag ${d.launchpad === 'Meteora' ? 'tag-info' : 'tag-plain'}">${esc(d.launchpad)}</span></td>
        <td class="dim">${fmtAgo(d.time)}</td>
        <td class="num">${fmtUsd(d.fdv)}</td>
        <td class="num">${fmtUsd(d.liqUsd)}</td>
        <td class="num">${fmtUsd(d.vol24h)}</td>
        <td><a href="https://dexscreener.com/solana/${d.mint}" target="_blank" title="Chart">${ICON.ext}</a></td>
      </tr>`).join('');
    box.innerHTML = `
      <div class="trace-stats">
        <span>Deploy ditemukan <b>${r.total}</b></span>
        <span>Masih hidup <b>${r.alive}</b> <span class="dim">(FDV ≥ $50K / liq ≥ $10K)</span></span>
        <span class="dim" style="font-size:.72rem">${r.txScanned} tx dipindai${r.historyTruncated ? ' — riwayat lebih lama tidak tercakup' : ''}</span>
      </div>
      <div class="tbl-scroll"><table class="coin-table">
        <thead><tr><th>Token</th><th>Launchpad</th><th>Umur</th><th class="num">FDV</th><th class="num">Liq</th><th class="num">Vol 24j</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  } catch (e) {
    box.innerHTML = `<div class="error-box">${esc(e.message)}</div>
      <button class="btn btn-sm" id="btn-deploys" data-wallet="${wallet}">Coba lagi</button>`;
    $('#btn-deploys').addEventListener('click', () => runDeployScan(wallet));
  }
}
