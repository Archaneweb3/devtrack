// token terbaru buatan sebuah wallet — dipakai monitor watchlist di browser
const { fetchCoins, json, isBase58 } = require('../lib/core');

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const wallet = (url.searchParams.get('wallet') || '').trim();
    if (!isBase58(wallet)) return json(res, 400, { error: 'Alamat wallet tidak valid' });
    const coins = await fetchCoins({ creator: wallet, offset: '0', limit: '1', sort: 'created_timestamp', order: 'DESC' });
    const c = coins?.[0];
    json(res, 200, c ? { mint: c.mint, name: c.name, symbol: c.symbol, createdTs: c.created_timestamp } : null);
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
};
