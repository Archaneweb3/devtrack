const { traceWallet, json, isBase58 } = require('../lib/core');

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const wallet = (url.searchParams.get('wallet') || '').trim();
    if (!isBase58(wallet)) return json(res, 400, { error: 'Alamat wallet Solana tidak valid' });
    json(res, 200, await traceWallet(wallet, url.searchParams.get('heliusKey') || ''));
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
};
