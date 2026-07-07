// devtrack — server lokal. Memakai handler yang sama dengan deployment Vercel (folder api/).
// Watchlist & settings tersimpan di browser (localStorage), jadi server ini stateless.
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
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;
  try {
    if (p.startsWith('/api/')) {
      const name = p.slice('/api/'.length).split('/')[0];
      const handler = routes[name];
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Endpoint tidak ditemukan' }));
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
  console.log(`devtrack jalan di http://localhost:${PORT}`);
});
