const { scanDeploys, json, isBase58 } = require('../lib/core');

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const wallet = (url.searchParams.get('wallet') || '').trim();
    if (!isBase58(wallet)) return json(res, 400, { error: 'Invalid wallet address' });
    json(res, 200, await scanDeploys(wallet, url.searchParams.get('heliusKey') || ''));
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
};
