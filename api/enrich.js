const { enrichMints, json } = require('../lib/core');

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const mints = (url.searchParams.get('mints') || '').split(',').filter(Boolean).slice(0, 60);
    if (!mints.length) return json(res, 200, {});
    json(res, 200, await enrichMints(mints));
  } catch (e) {
    json(res, e.status || 500, { error: e.message });
  }
};
