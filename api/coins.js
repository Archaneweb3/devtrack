const { listCoins, json } = require('../lib/core');

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const mode = url.searchParams.get('mode') || 'new';
    const limit = parseInt(url.searchParams.get('limit') || '48', 10);
    json(res, 200, await listCoins(mode, limit));
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
};
