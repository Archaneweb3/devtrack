// devtrack — local server. Uses the same handlers as the Vercel deployment (api/ folder).
// Watchlist & settings are stored in the browser (localStorage), so this server is stateless.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const PUBLIC_DIR = path.join(__dirname, 'public');

const routes = {
  coins: require('./api/coins'),
  dev: require('./api/dev'),
  resolve: require('./api/resolve'),
  cluster: require('./api/cluster'),
  deploys: require('./api/deploys'),
  enrich: require('./api/enrich'),
  latest: require('./api/latest'),
  telegram: require('./api/telegram'),
  score: require('./api/score'),
};

// bot bridge (local only): browser pushes watchlist+settings → file read by bot.js
const BOT_CONFIG = path.join(__dirname, 'bot-config.json');
function readBotConfig() {
  try { return JSON.parse(fs.readFileSync(BOT_CONFIG, 'utf8')); } catch { return {}; }
}
function writeBotConfig(patch) {
  const cfg = { ...readBotConfig(), ...patch, updatedAt: Date.now() };
  fs.writeFileSync(BOT_CONFIG, JSON.stringify(cfg, null, 2));
  return cfg;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    // sync bot config (local only — used by bot.js for auto-buy)
    if (p === '/api/bot-config') {
      if (req.method === 'POST') {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = raw ? JSON.parse(raw) : {};
        writeBotConfig(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ ok: true }));
      }
      const cfg = readBotConfig();
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ hasKey: !!cfg.privateKey, mode: cfg.mode || 'simulation', updatedAt: cfg.updatedAt || 0 }));
    }

    if (p.startsWith('/api/')) {
      const name = p.slice('/api/'.length).split('/')[0];
      const handler = routes[name];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Endpoint not found' }));
      }
      return handler(req, res);
    }

    let file = p === '/' ? '/index.html' : p;
    const full = path.join(PUBLIC_DIR, path.normalize(file));
    if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
      res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(full));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (e) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => {
  console.log(`devtrack running at http://localhost:${PORT}`);
});
