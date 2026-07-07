const { getDevProfile, json, isBase58 } = require('../lib/core');

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const wallet = (url.searchParams.get('wallet') || '').trim();
    if (!isBase58(wallet)) return json(res, 400, { error: 'Invalid Solana wallet address' });
    json(res, 200, await getDevProfile(wallet, url.searchParams.get('force') === '1'));
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
};
