const { creatorSummary, json, isBase58 } = require('../lib/core');

// lightweight scoring for the PRO badge in the live feed (brief creator track record)
module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const wallet = (url.searchParams.get('wallet') || '').trim();
    if (!isBase58(wallet)) return json(res, 400, { error: 'bad wallet' });
    const s = await creatorSummary(wallet);
    const total = s.launches || 0;
    const graduated = s.graduated || 0;
    const gradRate = total ? graduated / total : 0;
    const bestAth = s.bestAthUsd || 0;
    const pro = (graduated >= 1 && gradRate >= 0.25) || bestAth >= 500000;
    json(res, 200, { total, graduated, gradRate: Math.round(gradRate * 100), bestAth, pro });
  } catch {
    json(res, 200, { total: 0, graduated: 0, gradRate: 0, bestAth: 0, pro: false });
  }
};
