const { resolveAddress, json, isBase58 } = require('../lib/core');

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const address = (url.searchParams.get('address') || '').trim();
    if (!isBase58(address)) return json(res, 400, { error: 'Bukan alamat Solana yang valid' });
    json(res, 200, await resolveAddress(address, url.searchParams.get('heliusKey') || ''));
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
};
